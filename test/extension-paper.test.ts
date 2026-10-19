/**
 * Lecture des positions DryFlip (paper trading) affichées sur la page : montants,
 * libellés dans toutes les dispositions courantes, solde du portefeuille.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatAmount,
  formatPct,
  isClosed,
  isNewBuy,
  mergeReadings,
  parseLabel,
  parseValue,
  readFields,
  readPaper,
  toneOf,
  tradeKey,
  type TextTree,
} from '../extension/src/paper.js';

const t = (text: string, tone?: 'up' | 'down'): TextTree => ({ text, ...(tone ? { tone } : {}) });
const e = (...children: TextTree[]): TextTree => ({ children });
const sol = (value: number) => ({ value, unit: 'SOL' as const });

test('montants : signes, unités, milliers, suffixes K/M, virgule décimale', () => {
  assert.deepEqual(parseValue('+0.32 SOL (+25.1%)'), { amount: sol(0.32), pct: 25.1 });
  assert.deepEqual(parseValue('1,234.5 SOL'), { amount: sol(1234.5) });
  assert.deepEqual(parseValue('−$12.30'), { amount: { value: -12.3, unit: 'USD' } });
  assert.deepEqual(parseValue('$-12.30'), { amount: { value: -12.3, unit: 'USD' } });
  assert.deepEqual(parseValue('1.2K'), { amount: { value: 1200, unit: '' } });
  assert.deepEqual(parseValue('0,75 SOL'), { amount: sol(0.75) });
  assert.deepEqual(parseValue('◎0.25'), { amount: sol(0.25) });
  assert.deepEqual(parseValue('-12.4%'), { pct: -12.4 });
  assert.deepEqual(parseValue('0.3 BNB'), { amount: { value: 0.3, unit: 'BNB' } });
  // Sans signe, une perte affichée en rouge est négative ; l'unité du libellé sert de repli.
  assert.deepEqual(parseValue('0.3', 'down', 'SOL'), { amount: sol(-0.3) });
  assert.deepEqual(parseValue('aucun chiffre'), {});
});

test('libellés : passé seulement (« Buy 0.5 » est un bouton, pas une position), unité entre parenthèses', () => {
  assert.deepEqual(parseLabel('Bought'), { field: 'bought', unit: '' });
  assert.deepEqual(parseLabel('Bought (SOL)'), { field: 'bought', unit: 'SOL' });
  assert.deepEqual(parseLabel('Total PnL:'), { field: 'pnl', unit: '' });
  assert.deepEqual(parseLabel('Remaining'), { field: 'remaining', unit: '' });
  assert.deepEqual(parseLabel('Balance'), { field: 'balance', unit: '' });
  assert.equal(parseLabel('Buy'), null);
  assert.equal(parseLabel('Sell'), null);
  assert.deepEqual(readFields(e(t('Buy'), t('0.5'), t('Sell'), t('25%'))), {});
});

test('cartes de stats (libellé au-dessus de la valeur)', () => {
  const widget = e(
    t('DryFlip'),
    e(e(t('Bought')), e(t('1.5'), t('SOL'))),
    e(e(t('Sold')), e(t('0.5 SOL'))),
    e(e(t('Remaining')), e(t('1.2 SOL'))),
    e(e(t('PnL')), e(t('+0.2 SOL'), t('(+13.3%)'))),
  );
  assert.deepEqual(readPaper(widget), {
    position: { bought: sol(1.5), sold: sol(0.5), remaining: sol(1.2), pnl: sol(0.2), pnlPct: 13.3 },
  });
});

test('libellé et valeur dans le même texte', () => {
  const widget = e(t('Bought: 2 SOL'), t('Sold: 0 SOL'), t('Remaining 1.7 SOL'), t('PNL -0.3 SOL (-15%)'));
  assert.deepEqual(readPaper(widget).position, { bought: sol(2), sold: sol(0), remaining: sol(1.7), pnl: sol(-0.3), pnlPct: -15 });
});

test('valeur au-dessus du libellé, perte en rouge sans signe', () => {
  const widget = e(e(t('1.5 SOL'), t('Bought')), e(t('0'), t('Sold')), e(t('1.1 SOL'), t('Remaining')), e(t('0.4 SOL', 'down'), t('PnL')));
  assert.deepEqual(readPaper(widget).position, { bought: sol(1.5), sold: { value: 0, unit: '' }, remaining: sol(1.1), pnl: sol(-0.4) });
});

test('libellés et valeurs à plat, côte à côte', () => {
  const widget = e(t('Bought'), t('1.5'), t('Sold'), t('0.5'), t('Remaining'), t('1.2'), t('PnL'), t('+0.2'), t('+13%'));
  assert.deepEqual(readPaper(widget).position, {
    bought: { value: 1.5, unit: '' },
    sold: { value: 0.5, unit: '' },
    remaining: { value: 1.2, unit: '' },
    pnl: { value: 0.2, unit: '' },
    pnlPct: 13,
  });
});

test('unité donnée par le libellé ou par le logo', () => {
  const widget = e(e(t('Bought (SOL)'), t('1.5')), e(t('Sold'), t('0.2'), t('SOL')));
  assert.deepEqual(readPaper(widget).position, { bought: sol(1.5), sold: sol(0.2) });
});

test('carte flottante : solde et PnL du portefeuille, pas une position', () => {
  const card = e(t('DryFlip'), e(t('Balance'), t('98.5 SOL')), e(t('PnL'), t('-1.5 SOL'), t('-1.5%')));
  assert.deepEqual(readPaper(card), { wallet: { balance: sol(98.5), pnl: sol(-1.5), pnlPct: -1.5 } });
});

test('widget affiché sans position ouverte (Bought 0) : aucune position', () => {
  const widget = e(e(t('Bought'), t('0 SOL')), e(t('Sold'), t('0 SOL')), e(t('Remaining'), t('0 SOL')), e(t('Balance'), t('10 SOL')));
  assert.deepEqual(readPaper(widget), { wallet: { balance: sol(10) } });
});

test('plusieurs widgets : position du token + solde de la carte flottante', () => {
  const merged = mergeReadings([{ wallet: { balance: sol(97) } }, { position: { bought: sol(1) } }, { position: { bought: sol(9) } }]);
  assert.deepEqual(merged, { position: { bought: sol(1) }, wallet: { balance: sol(97) } });
});

test('achats, ventes, fermeture', () => {
  assert.equal(isNewBuy(undefined, { bought: sol(1) }), true);
  assert.equal(isNewBuy({ bought: sol(1) }, { bought: sol(1), pnl: sol(0.4) }), false);
  assert.equal(isNewBuy({ bought: sol(1) }, { bought: sol(1.5) }), true);
  assert.equal(isNewBuy(undefined, { bought: sol(0), sold: sol(1) }), false);
  assert.equal(isClosed({ bought: sol(1), sold: sol(1.4), remaining: sol(0) }), true);
  assert.equal(isClosed({ bought: sol(1), sold: sol(0.5), remaining: sol(0.6) }), false);
  assert.equal(tradeKey({ bought: sol(1), pnl: sol(0.1) }), tradeKey({ bought: sol(1), pnl: sol(0.7) }));
  assert.notEqual(tradeKey({ bought: sol(1) }), tradeKey({ bought: sol(1), sold: sol(0.3) }));
});

test('affichage français', () => {
  // Toujours 4 décimales, comme DryFlip.
  assert.equal(formatAmount(sol(1.25)), '1,2500 SOL');
  assert.equal(formatAmount(sol(0.1)), '0,1000 SOL');
  assert.equal(formatAmount(sol(-0.3), true), '−0,3000 SOL');
  assert.equal(formatAmount(sol(0.0128), true), '+0,0128 SOL');
  assert.equal(formatAmount({ value: 45.2, unit: 'USD' }), '45,2000 $');
  assert.equal(formatPct(21.04), '+21 %');
  assert.equal(formatPct(-7.25), '−7,3 %');
});

test('couleurs : rouge = perte, vert = gain, le reste neutre', () => {
  assert.equal(toneOf('rgb(239, 68, 68)'), 'down');
  assert.equal(toneOf('rgb(34, 197, 94)'), 'up');
  assert.equal(toneOf('rgba(255, 255, 255, 0.9)'), undefined);
  assert.equal(toneOf('rgb(156, 163, 175)'), undefined);
  assert.equal(toneOf('oklch(0.637 0.237 25.331)'), 'down');
  assert.equal(toneOf('oklch(0.723 0.219 149.579)'), 'up');
});

test('position soldée : reste à zéro, en pourcentage, ou poussière d’arrondi', () => {
  assert.equal(isClosed({ bought: sol(1), sold: sol(1.4), remainingPct: 0 }), true);
  assert.equal(isClosed({ bought: sol(1), sold: sol(0.5), remainingPct: 50 }), false);
  assert.equal(isClosed({ bought: sol(1), sold: sol(1.39), remaining: sol(0.0004) }), true, 'poussière < 1 % de l’investi');
  assert.equal(isClosed({ bought: sol(1), sold: sol(0.6), remaining: sol(0.5) }), false);
  assert.equal(isClosed({ bought: sol(1), sold: sol(1.4) }), false, 'reste inconnu : pas de conclusion');
  const widget = e(e(t('Bought'), t('1 SOL')), e(t('Sold'), t('1.4 SOL')), e(t('Remaining'), t('0%')), e(t('PnL'), t('+0.4 SOL')));
  const position = readPaper(widget).position!;
  assert.equal(position.remainingPct, 0);
  assert.equal(isClosed(position), true);
});

/**
 * Le widget DryFlip tel qu'il s'affiche réellement (capture du 19/10) : solde dans
 * l'en-tête à côté du nom, BOUGHT / SOLD / REMAINING en cartes, « - » une fois tout
 * revendu, « PNL CHANGE » sans signe (vert), boutons d'achat et de vente rapides.
 */
function realWidget(remaining: string, pnl: TextTree[], header = '5.42'): TextTree {
  return e(
    e(e(t('DryFlip')), e(t(header), t('≡')), e()),
    e(t('BUY')),
    e(t('Amount'), t('SOL')),
    e(t('0.05'), t('0.1'), t('0.15'), t('0.25')),
    e(t('30%'), t('0.001'), t('0.001')),
    e(t('ORDER'), e(t('USD'), t('SOL'))),
    e(e(t('BOUGHT'), t('0.1000 SOL')), e(t('SOLD'), t('0.1168 SOL')), e(t('REMAINING'), t(remaining))),
    e(t('PNL CHANGE'), e(...pnl)),
    e(t('SELL')),
    e(t('Amount (%)')),
    e(t('10%'), t('25%'), t('50%'), t('100%')),
    e(t('30%'), t('0.001'), t('0.001'), t('SELL INIT')),
    e(t('TAKE PROFIT / STOP LOSS')),
    e(t('LIMIT BUY')),
  );
}

test('widget DryFlip réel : position soldée (« - »), PnL change, solde de l’en-tête', () => {
  const reading = readPaper(realWidget('-', [t('0.0128 SOL', 'up'), t('(+13%)', 'up')]));
  assert.deepEqual(reading.position, {
    bought: sol(0.1),
    sold: sol(0.1168),
    remaining: { value: 0, unit: '' },
    pnl: sol(0.0128),
    pnlPct: 13,
  });
  assert.equal(isClosed(reading.position), true, 'Remaining « - » après une vente totale = OUT');
  assert.deepEqual(reading.wallet, { balance: sol(5.42) });
});

test('widget DryFlip réel : position ouverte en perte', () => {
  const widget = e(
    e(e(t('DryFlip')), e(t('9.87'))),
    e(e(t('BOUGHT'), t('0.2500 SOL')), e(t('SOLD'), t('0 SOL')), e(t('REMAINING'), t('0.2010 SOL'))),
    e(t('PNL CHANGE'), e(t('-0.0490 SOL', 'down'), t('(-19.6%)', 'down'))),
  );
  const reading = readPaper(widget);
  assert.deepEqual(reading.position, { bought: sol(0.25), sold: sol(0), remaining: sol(0.201), pnl: sol(-0.049), pnlPct: -19.6 });
  assert.equal(isClosed(reading.position), false);
  assert.deepEqual(reading.wallet, { balance: sol(9.87) });
});

test('widget DryFlip réel sans position : solde seul, aucune position', () => {
  const widget = e(
    e(e(t('DryFlip')), e(t('5.42'))),
    e(e(t('BOUGHT'), t('-')), e(t('SOLD'), t('-')), e(t('REMAINING'), t('-'))),
    e(t('PNL CHANGE'), e(t('-'))),
  );
  assert.deepEqual(readPaper(widget), { wallet: { balance: { value: 5.42, unit: '' } } });
});
