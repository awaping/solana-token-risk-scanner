/**
 * Suivi seconde par seconde du widget DryFlip : heure exacte des opérations,
 * widget du token précédent, affichage transitoire au chargement, disparition.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { positionKey, type DryFlipScan, type PaperPosition } from '../extension/src/paper.js';
import { ABSENT_AFTER_MS, PaperTracker, SEND_EVERY_MS } from '../extension/src/paper-tracker.js';

const sol = (value: number) => ({ value, unit: 'SOL' as const });
const T = 1_760_000_000_000;
const empty: DryFlipScan = { found: true, reading: {} };
const none: DryFlipScan = { found: false, reading: {} };
const pos = (position: PaperPosition, wallet?: DryFlipScan['reading']['wallet']): DryFlipScan => ({ found: true, reading: { position, ...(wallet ? { wallet } : {}) } });

/** Avance seconde par seconde ; renvoie les envois. */
function run(tracker: PaperTracker, from: number, to: number, scan: (t: number) => DryFlipScan) {
  const sends = [];
  for (let t = from; t <= to; t += 1_000) {
    const out = tracker.tick(scan(t), T + t);
    if (out.send) sends.push(out.send);
  }
  return sends;
}

test('achat vu en direct : heure exacte, marqué « observé »', () => {
  const tracker = new PaperTracker('ADDR', T);
  tracker.mint = 'MINT';
  assert.deepEqual(run(tracker, 0, 21_000, () => empty), []);
  const sends = run(tracker, 22_000, 25_000, () => pos({ bought: sol(1), pnl: sol(0) }));
  assert.equal(sends.length, 1);
  assert.equal(sends[0]!.at, T + 22_000);
  assert.equal(sends[0]!.observed, true);
});

test('position déjà ouverte à l’ouverture : non observée', () => {
  const tracker = new PaperTracker('ADDR', T);
  tracker.mint = 'MINT';
  const sends = run(tracker, 0, 5_000, () => pos({ bought: sol(1) }));
  assert.equal(sends.length, 1);
  assert.equal(sends[0]!.observed, false);
});

test('« 0 » transitoire au chargement de DryFlip : pas un achat en direct', () => {
  const tracker = new PaperTracker('ADDR', T);
  tracker.mint = 'MINT';
  const sends = run(tracker, 0, 6_000, (t) => (t < 4_000 ? empty : pos({ bought: sol(1) })));
  assert.equal(sends[0]!.observed, false, 'vide moins de 3 s avant la position');
});

test('achat pendant l’analyse : mis en attente, envoyé avec l’heure de l’achat', () => {
  const tracker = new PaperTracker('ADDR', T);
  run(tracker, 0, 9_000, () => empty);
  run(tracker, 10_000, 12_000, () => pos({ bought: sol(1) }));
  tracker.mint = 'MINT';
  const [send] = run(tracker, 13_000, 13_000, () => pos({ bought: sol(1) }));
  assert.equal(send!.at, T + 10_000);
  assert.equal(send!.observed, true);
});

test('widget du token précédent juste après la navigation : ignoré', () => {
  const previous = { bought: sol(3), pnl: sol(1) };
  const tracker = new PaperTracker('ADDR', T, positionKey(previous));
  tracker.mint = 'MINT';
  assert.deepEqual(run(tracker, 0, 6_000, () => pos(previous)), []);
  assert.equal(tracker.tick(pos(previous), T + 1_000).view.status, 'recherche');
});

test('variations de prix : un envoi toutes les 30 s au plus', () => {
  const tracker = new PaperTracker('ADDR', T);
  tracker.mint = 'MINT';
  const sends = run(tracker, 3_000, 3_000 + 2 * SEND_EVERY_MS, (t) => pos({ bought: sol(1), pnl: sol(t / 1e6) }));
  assert.equal(sends.length, 3);
});

test('vente totale puis retrait de la position : sortie avec le dernier PnL', () => {
  const tracker = new PaperTracker('ADDR', T);
  tracker.mint = 'MINT';
  run(tracker, 3_000, 5_000, () => pos({ bought: sol(1), pnl: sol(0.4) }));
  const sends = run(tracker, 6_000, 14_000, () => empty);
  assert.equal(sends.length, 1);
  assert.equal(sends[0]!.vanished, true);
  assert.equal(sends[0]!.position?.pnl?.value, 0.4);
});

test('solde de la carte flottante : premier envoi immédiat, puis toutes les 10 s au plus s’il change', () => {
  const tracker = new PaperTracker('ADDR', T);
  tracker.mint = 'MINT';
  const sends = run(tracker, 3_000, 15_000, (t) => ({ found: true, reading: { wallet: { balance: sol(100 - t / 1e5) } } }));
  assert.equal(sends.length, 2);
  assert.ok(sends.every((s) => s.wallet && !s.position));
});

test('DryFlip absent de la page : « recherche » puis « absent »', () => {
  const tracker = new PaperTracker('ADDR', T);
  assert.equal(tracker.tick(none, T + 1_000).view.status, 'recherche');
  assert.equal(tracker.tick(none, T + ABSENT_AFTER_MS).view.status, 'absent');
  assert.equal(tracker.tick({ found: true, framed: true, reading: {} }, T + ABSENT_AFTER_MS).view.status, 'iframe');
});

test('position absente 3 s (widget redessiné) : rien n’est envoyé', () => {
  const tracker = new PaperTracker('ADDR', T);
  tracker.mint = 'MINT';
  run(tracker, 3_000, 5_000, () => pos({ bought: sol(1), pnl: sol(0.4) }));
  const sends = run(tracker, 6_000, 12_000, (t) => (t <= 8_000 ? empty : pos({ bought: sol(1), pnl: sol(0.4) })));
  assert.deepEqual(sends, []);
});

test('widget DryFlip retiré de la page après la vente : sortie au bout de 5 s', () => {
  const tracker = new PaperTracker('ADDR', T);
  tracker.mint = 'MINT';
  run(tracker, 3_000, 5_000, () => pos({ bought: sol(1), pnl: sol(0.4) }));
  const sends = run(tracker, 6_000, 12_000, () => none);
  assert.equal(sends.length, 1);
  assert.equal(sends[0]!.vanished, true);
  assert.equal(sends[0]!.at, T + 6_000, 'datée de la disparition, pas de la confirmation');
});

test('sortie déclarée à la main : envoyée une fois, marquée manuelle', () => {
  const tracker = new PaperTracker('ADDR', T);
  tracker.mint = 'MINT';
  run(tracker, 3_000, 4_000, () => pos({ bought: sol(1), pnl: sol(-0.2) }));
  const send = tracker.manualExit(T + 5_000);
  assert.equal(send?.manual, true);
  assert.equal(send?.vanished, true);
  assert.equal(send?.position?.pnl?.value, -0.2);
  assert.equal(tracker.manualExit(T + 6_000), undefined);
});
