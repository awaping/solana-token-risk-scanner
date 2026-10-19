/**
 * Paper trading dans l'historique : achats et ventes DryFlip avec l'âge du token,
 * analyse rattachée à l'achat, ré-analyses de suivi, issue run / rug, et
 * comparaison des données d'achat entre groupes.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FOLLOW_UP_DELAYS_MS, HistoryStore, PAPER_POINT_MS, type KeyValueStore, type ScanSnapshot, type ScanTrigger } from '../extension/src/history-store.js';
import { alertKey, coinOutcome, compareGroups, median, paperTotals } from '../extension/src/paper-analysis.js';
import type { PaperPosition } from '../extension/src/paper.js';

function memoryStore(): KeyValueStore {
  const data = new Map<string, string>();
  return {
    get: async (keys) => Object.fromEntries(keys.filter((k) => data.has(k)).map((k) => [k, JSON.parse(data.get(k)!)])),
    set: async (items) => {
      for (const [k, v] of Object.entries(items)) data.set(k, JSON.stringify(v));
    },
    remove: async (keys) => {
      for (const k of keys) data.delete(k);
    },
  };
}

const T0 = 1_760_000_000_000;
const sol = (value: number) => ({ value, unit: 'SOL' as const });

function snap(
  mint: string,
  at: number,
  score: number,
  o: { trigger?: ScanTrigger; mcap?: number; reserve?: number; createdAt?: number; alerts?: string[]; top10?: number } = {},
): ScanSnapshot {
  const level = score >= 70 ? 'ROUGE' : score > 30 ? 'ORANGE' : 'VERT';
  return {
    mint,
    symbol: mint.slice(0, 4).toUpperCase(),
    point: {
      at,
      ...(o.trigger ? { trigger: o.trigger } : {}),
      ...(o.createdAt !== undefined ? { tokenAgeSec: (at - o.createdAt) / 1000 } : {}),
      score,
      level,
      coverage: 1,
      modules: {},
      metrics: { ...(o.mcap !== undefined ? { marketCapSol: o.mcap } : {}), ...(o.reserve !== undefined ? { reserveSol: o.reserve } : {}), ...(o.top10 !== undefined ? { top10Pct: o.top10 } : {}) },
      alerts: (o.alerts ?? []).map((message) => ({ severity: 'warning' as const, message })),
    },
    detail: {
      at,
      token: { mint, program: 'SPL Token', decimals: 6, supply: '1000', mintAuthority: null, freezeAuthority: null, dangerousExtensions: [] },
      modules: [],
      floors: [],
      ...(o.createdAt !== undefined ? { tokenAge: { createdAt: o.createdAt, exact: true } } : {}),
      durationMs: 10,
      rpcRequests: 5,
    },
  };
}

test('ouvert à 17 s, IN à 39 s, OUT à 58 s : âges, analyse d’entrée, résultat', async () => {
  const store = new HistoryStore(memoryStore());
  const created = T0;
  assert.equal((await store.attachPaper('MINT', { bought: sol(1) }, { at: created + 20_000 })).known, false, 'token pas encore analysé');

  await store.record(snap('MINT', created + 17_000, 45, { trigger: 'ouverture', createdAt: created, mcap: 30 }));
  // Widget DryFlip vu sans position, puis achat.
  const buy = await store.attachPaper('MINT', { bought: sol(1), remaining: sol(1), pnl: sol(0) }, { at: created + 39_000, observed: true });
  assert.deepEqual(buy, { known: true, buy: true, firstBuy: true, sell: false, closed: false });
  // Analyse lancée par l'achat : rattachée à cet achat.
  await store.record(snap('MINT', created + 42_000, 52, { trigger: 'entrée', createdAt: created, mcap: 36 }));
  // Variation de prix seule : pas une opération.
  const tick = await store.attachPaper('MINT', { bought: sol(1), remaining: sol(1.2), pnl: sol(0.2) }, { at: created + 45_000, observed: true });
  assert.equal(tick.buy || tick.sell, false);
  const out = await store.attachPaper('MINT', { bought: sol(1), sold: sol(1.4), remaining: sol(0), pnl: sol(0.4), pnlPct: 40 }, { at: created + 58_000, observed: true });
  assert.deepEqual(out, { known: true, buy: false, firstBuy: false, sell: true, closed: true });

  const coin = (await store.get('MINT'))!;
  assert.equal(coin.createdAt, created);
  assert.equal(coin.scans[0]!.tokenAgeSec, 17);
  const [achat, vente] = coin.paper!.trades;
  assert.equal(achat!.kind, 'achat');
  assert.equal(achat!.observed, true);
  assert.equal(achat!.tokenAgeSec, 39);
  assert.equal(achat!.scan?.score, 52, 'analyse d’entrée rattachée');
  assert.equal(coin.paper!.entryDetail?.at, created + 42_000);
  assert.equal(vente!.kind, 'vente');
  assert.equal(vente!.closes, true);
  assert.equal(vente!.tokenAgeSec, 58);
  assert.equal(coin.paper!.closedAt, created + 58_000);

  const outcome = coinOutcome(coin, created + 60_000)!;
  assert.equal(outcome.entryExact, true);
  assert.equal(outcome.entry?.score, 52);
  assert.equal(outcome.entryAgeSec, 39);
  assert.equal(outcome.exitAgeSec, 58);
  assert.equal(outcome.holdSec, 19);
  assert.equal(outcome.result, 'gain');
  assert.equal(outcome.open, false);

  const [summary] = await store.list();
  assert.equal(summary!.paper?.result, 'gain');
  assert.equal(summary!.paper?.entryScore, 52);
  assert.equal(summary!.paper?.entryAgeSec, 39);
  assert.equal(summary!.paper?.open, false);
});

test('position déjà ouverte à l’ouverture de la page : achat marqué « non observé »', async () => {
  const store = new HistoryStore(memoryStore());
  await store.record(snap('OLD', T0, 30, { mcap: 50 }));
  await store.attachPaper('OLD', { bought: sol(2), remaining: sol(1.5), pnl: sol(-0.5) }, { at: T0 + 1_000, observed: false });
  const coin = (await store.get('OLD'))!;
  assert.equal(coin.paper!.trades[0]!.observed, false);
  const outcome = coinOutcome(coin, T0 + 2_000)!;
  assert.equal(outcome.entryExact, false, 'pas d’analyse lancée par l’achat : dernière analyse avant');
  assert.equal(outcome.entry?.score, 30);
  assert.equal(outcome.result, 'perte');
  assert.equal(outcome.open, true);
});

test('renfort = nouvel achat ; courbe du PnL bornée à un point toutes les 30 s', async () => {
  const store = new HistoryStore(memoryStore());
  await store.record(snap('ADD', T0, 40));
  await store.attachPaper('ADD', { bought: sol(1), pnl: sol(0) }, { at: T0 + 1_000, observed: true });
  for (let i = 1; i <= 10; i++) await store.attachPaper('ADD', { bought: sol(1), pnl: sol(i / 100) }, { at: T0 + 1_000 + i * 2_000, observed: true });
  let coin = (await store.get('ADD'))!;
  assert.equal(coin.paper!.points.length, 1, 'variations de prix rapprochées : pas de point');
  assert.equal(coin.paper!.latest.pnl?.value, 0.1, 'valeur actuelle toujours à jour');
  await store.attachPaper('ADD', { bought: sol(1), pnl: sol(0.2) }, { at: T0 + 1_000 + PAPER_POINT_MS, observed: true });
  const again = await store.attachPaper('ADD', { bought: sol(1.5), pnl: sol(0.2) }, { at: T0 + 40_000, observed: true });
  assert.equal(again.buy, true);
  assert.equal(again.firstBuy, false, 'renfort, pas premier achat');
  coin = (await store.get('ADD'))!;
  assert.equal(coin.paper!.points.length, 3);
  assert.deepEqual(coin.paper!.trades.map((t) => t.bought?.value), [1, 1.5]);
});

test('suivi après l’achat : run (×2), rug (−70 %), neutre après 4 h', async () => {
  const store = new HistoryStore(memoryStore());
  const scenario = async (mint: string, caps: Array<[number, number]>, reserve?: number[]) => {
    await store.record(snap(mint, T0, 40, { mcap: 30, reserve: 10 }));
    await store.attachPaper(mint, { bought: sol(1) }, { at: T0 + 1_000, observed: true });
    await store.record(snap(mint, T0 + 3_000, 42, { trigger: 'entrée', mcap: 30, reserve: 10 }));
    for (const [i, [delay, mcap]] of caps.entries()) await store.record(snap(mint, T0 + delay, 50, { trigger: 'suivi', mcap, reserve: reserve?.[i] ?? 10 }));
    return coinOutcome((await store.get(mint))!, T0 + 30 * 3_600_000)!;
  };
  const run = await scenario('RUN', [[5 * 60_000, 45], [15 * 60_000, 75], [3_600_000, 50]]);
  assert.equal(run.market, 'run');
  assert.equal(run.peakX, 2.5);
  const rug = await scenario('RUG', [[5 * 60_000, 20], [15 * 60_000, 6]]);
  assert.equal(rug.market, 'rug');
  const drained = await scenario('DRAIN', [[5 * 60_000, 25]], [0.5]);
  assert.equal(drained.market, 'rug', 'réserve vidée à 95 %');
  const runThenRug = await scenario('PUMPDUMP', [[5 * 60_000, 90], [3_600_000, 5]]);
  assert.equal(runThenRug.market, 'run');
  assert.equal(runThenRug.thenRug, true);
  const flat = await scenario('FLAT', [[3_600_000, 33], [4 * 3_600_000, 28]]);
  assert.equal(flat.market, 'neutre');
  const early = await scenario('EARLY', [[5 * 60_000, 33]]);
  assert.equal(early.market, 'en cours');
  const [summary] = (await store.list()).filter((c) => c.mint === 'RUN');
  assert.equal(summary!.paper?.market, 'run', 'issue reportée dans la liste');
});

test('comparaison run vs rug : médianes à l’achat et alertes plus fréquentes d’un côté', async () => {
  const store = new HistoryStore(memoryStore());
  const coin = async (mint: string, top10: number, finalCap: number, alerts: string[], pnl: number) => {
    await store.record(snap(mint, T0, 40, { mcap: 30, top10, alerts }));
    await store.attachPaper(mint, { bought: sol(1), pnl: sol(pnl) }, { at: T0 + 1_000, observed: true });
    await store.record(snap(mint, T0 + 2_000, 40, { trigger: 'entrée', mcap: 30, top10, alerts }));
    await store.record(snap(mint, T0 + 3_600_000, 40, { trigger: 'suivi', mcap: finalCap }));
  };
  await coin('R1', 20, 90, [], 0.5);
  await coin('R2', 24, 70, ['Top 10 détient 24 %'], 0.8);
  await coin('X1', 60, 3, ['Wallet du créateur jetable : 0,1 SOL', 'Top 10 détient 60 %'], -0.9);
  await coin('X2', 70, 4, ['Wallet du créateur jetable : 0,02 SOL'], -1);
  await coin('X3', 50, 2, [], -0.7);

  const coins = await store.getMany((await store.list()).map((c) => c.mint));
  const market = compareGroups(coins, 'market', T0 + 5 * 3_600_000);
  assert.equal(market.a, 2);
  assert.equal(market.b, 3);
  const top10 = market.rows.find((r) => r.key === 'top10')!;
  assert.equal(top10.a, 22);
  assert.equal(top10.b, 60);
  assert.equal(market.alerts[0]!.label.startsWith('Wallet du créateur jetable'), true, 'alerte la plus discriminante en tête');
  assert.equal(market.alerts[0]!.a, 0);
  assert.ok(Math.abs(market.alerts[0]!.b - 2 / 3) < 1e-9);

  const result = compareGroups(coins, 'result', T0 + 5 * 3_600_000);
  assert.equal(result.a, 2, 'gagnants');
  assert.equal(result.b, 3, 'perdants');

  const totals = paperTotals(await store.list());
  const all = totals.find((t) => t.level === 'tous')!;
  assert.equal(all.coins, 5);
  assert.equal(all.gains, 2);
  assert.equal(all.pertes, 3);
  assert.ok(Math.abs(all.pnl.SOL! - (0.5 + 0.8 - 0.9 - 1 - 0.7)) < 1e-9);
  assert.equal(all.markets.run, 2);
  assert.equal(all.markets.rug, 3);
  assert.equal(totals.find((t) => t.level === 'ORANGE')!.coins, 5);
});

test('ré-analyses programmées : 5 étapes, réessai en cas d’échec, abandon après 3 essais', async () => {
  const store = new HistoryStore(memoryStore());
  await store.scheduleFollowUps('MINT', T0);
  let list = await store.followUps();
  assert.deepEqual(list.map((f) => f.due - T0), FOLLOW_UP_DELAYS_MS);
  await store.settleFollowUp(list[0]!, true);
  list = await store.followUps();
  assert.equal(list.length, 4);
  let item = list[0]!;
  for (let attempt = 0; attempt < 3; attempt++) {
    await store.settleFollowUp(item, false, T0 + 1);
    const retried = (await store.followUps()).find((f) => f.step === item.step);
    if (attempt < 2) {
      assert.equal(retried?.attempts, attempt + 1);
      item = retried!;
    } else {
      assert.equal(retried, undefined, 'abandonné');
    }
  }
  // Un nouveau premier achat reprogramme le token, sans doublon.
  await store.scheduleFollowUps('MINT', T0 + 10);
  assert.equal((await store.followUps()).length, 5);
  await store.remove('MINT');
  assert.equal((await store.followUps()).length, 0);
});

test('solde DryFlip : un point par minute au plus, effacé avec l’historique', async () => {
  const store = new HistoryStore(memoryStore());
  await store.setWallet({ balance: sol(100) }, T0);
  await store.setWallet({ balance: sol(99) }, T0 + 10_000);
  await store.setWallet({ balance: sol(98) }, T0 + 70_000);
  const wallet = (await store.wallet())!;
  assert.deepEqual(wallet.points.map((p) => p.balance.value), [100, 98]);
  assert.equal(wallet.latest.balance?.value, 98);
  await store.clear();
  assert.equal(await store.wallet(), null);
});

test('utilitaires : médiane, alerte sans ses chiffres', () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 2, 3]), 2.5);
  assert.equal(median([]), undefined);
  assert.equal(alertKey('Top 10 détient 45,2 %'), alertKey('Top 10 détient 61 %'));
});

test('position vide ignorée côté stockage ; type PaperPosition minimal accepté', async () => {
  const store = new HistoryStore(memoryStore());
  await store.record(snap('MIN', T0, 10));
  const position: PaperPosition = { bought: sol(0.5) };
  assert.equal((await store.attachPaper('MIN', position, { at: T0 + 1 })).buy, true);
  assert.equal((await store.attachPaper('MIN', position, { at: T0 + 2 })).buy, false, 'même position : rien de nouveau');
});

test('déjà rug à l’ouverture : marqué, signalé au panneau, exclu des statistiques', async () => {
  const { alreadyRugged } = await import('../extension/src/paper-analysis.js');
  const point = (metrics: Record<string, unknown>, tokenAgeSec?: number) =>
    ({ at: T0, score: 80, level: 'ROUGE', coverage: 1, modules: {}, metrics, alerts: [], ...(tokenAgeSec !== undefined ? { tokenAgeSec } : {}) }) as never;
  assert.match(alreadyRugged(point({ marketType: 'amm-pool', reserveSol: 0.4 }))!, /liquidité retirée/);
  assert.equal(alreadyRugged(point({ marketType: 'amm-pool', reserveSol: 84 })), undefined);
  assert.match(alreadyRugged(point({ marketType: 'bonding-curve', reserveSol: 0.2, mintTxCount: 350 }))!, /vidée.*350 transactions/);
  assert.match(alreadyRugged(point({ marketType: 'bonding-curve', reserveSol: 0.1, mintTxCount: 3 }, 20 * 60))!, /20 min/);
  // Token tout juste lancé : peu de SOL, mais vivant.
  assert.equal(alreadyRugged(point({ marketType: 'bonding-curve', reserveSol: 0.3, mintTxCount: 4 }, 17)), undefined);
  assert.equal(alreadyRugged(point({ marketType: 'none', reserveSol: 0 })), undefined, 'pool introuvable n’est pas une preuve de rug');

  const store = new HistoryStore(memoryStore());
  const dead = snap('DEAD', T0, 85, { mcap: 28 });
  dead.point.metrics = { ...dead.point.metrics, marketType: 'amm-pool', reserveSol: 0.2 };
  const brief = await store.record(dead);
  assert.match(brief.deadAtOpen!, /liquidité retirée/);
  await store.attachPaper('DEAD', { bought: sol(1), pnl: sol(-1) }, { at: T0 + 1_000, observed: true });
  const live = snap('LIVE', T0, 40, { mcap: 30 });
  await store.record(live);
  await store.attachPaper('LIVE', { bought: sol(1), pnl: sol(0.5) }, { at: T0 + 1_000, observed: true });

  const summaries = await store.list();
  assert.match(summaries.find((c) => c.mint === 'DEAD')!.deadAtOpen!, /liquidité retirée/);
  assert.equal(paperTotals(summaries).find((t) => t.level === 'tous')!.coins, 1, 'token mort exclu');
  assert.equal(paperTotals(summaries, { includeDead: true }).find((t) => t.level === 'tous')!.coins, 2);
  const coins = await store.getMany(['DEAD', 'LIVE']);
  assert.equal(compareGroups(coins, 'result', T0).b, 0);
  assert.equal(compareGroups(coins, 'result', T0, { includeDead: true }).b, 1);

  // Mort plus tard (après une première ouverture vivante) : c'est une issue, pas un « déjà rug ».
  const later = snap('LIVE', T0 + 3_600_000, 90, { mcap: 2 });
  later.point.metrics = { ...later.point.metrics, marketType: 'amm-pool', reserveSol: 0.1 };
  assert.equal((await store.record(later)).deadAtOpen, undefined);
});

test('position retirée du widget = vente totale ; nouvelle position ensuite = nouvel achat', async () => {
  const store = new HistoryStore(memoryStore());
  await store.record(snap('GONE', T0, 40, { createdAt: T0 - 10_000 }));
  await store.attachPaper('GONE', { bought: sol(1), remaining: sol(1.3), pnl: sol(0.3) }, { at: T0 + 1_000, observed: true });
  const gone = await store.attachPaper('GONE', {}, { at: T0 + 9_000, observed: true, vanished: true });
  assert.deepEqual(gone, { known: true, buy: false, firstBuy: false, sell: true, closed: true });
  let coin = (await store.get('GONE'))!;
  const exit = coin.paper!.trades[1]!;
  assert.equal(exit.closes, true);
  assert.equal(exit.pnl?.value, 0.3, 'dernier PnL affiché');
  assert.equal(exit.tokenAgeSec, 19);
  assert.equal(coinOutcome(coin)!.open, false);
  // Deuxième disparition : déjà soldée, rien de plus.
  assert.equal((await store.attachPaper('GONE', {}, { at: T0 + 10_000, vanished: true })).sell, false);

  const again = await store.attachPaper('GONE', { bought: sol(0.5), remaining: sol(0.5) }, { at: T0 + 60_000, observed: true });
  assert.equal(again.buy, true, 'nouvel achat après une sortie, même plus petit');
  coin = (await store.get('GONE'))!;
  assert.equal(coin.paper!.closedAt, undefined, 'position rouverte');
  assert.deepEqual(coin.paper!.trades.map((t) => t.kind), ['achat', 'vente', 'achat']);
});

test('libellé d’alerte commun : les chiffres qui varient deviennent « … »', async () => {
  const { alertLabel } = await import('../extension/src/paper-analysis.js');
  assert.equal(alertLabel(['Top 10 détient 45 % de la supply', 'Top 10 détient 61,5 % de la supply']), 'Top 10 détient … % de la supply');
  assert.equal(alertLabel(['3 wallets aux parts identiques']), '3 wallets aux parts identiques');
  assert.equal(alertKey('Wallet jetable : 1 250 SOL'), alertKey('Wallet jetable : 3 SOL'));
});

test('widget redessiné (position absente puis revenue à l’identique) : ni vente ni nouvel achat', async () => {
  const store = new HistoryStore(memoryStore());
  await store.record(snap('BLINK', T0, 40));
  await store.attachPaper('BLINK', { bought: sol(1), remaining: sol(1.1), pnl: sol(0.1) }, { at: T0 + 1_000, observed: true });
  await store.attachPaper('BLINK', {}, { at: T0 + 8_000, observed: true, vanished: true });
  assert.equal((await store.get('BLINK'))!.paper!.closedAt, T0 + 8_000);
  const back = await store.attachPaper('BLINK', { bought: sol(1), remaining: sol(1.2), pnl: sol(0.2) }, { at: T0 + 12_000, observed: true });
  assert.equal(back.buy, false);
  const coin = (await store.get('BLINK'))!;
  assert.equal(coin.paper!.closedAt, undefined, 'sortie annulée');
  assert.deepEqual(coin.paper!.trades.map((t) => t.kind), ['achat']);
  assert.equal(coin.paper!.latest.pnl?.value, 0.2);
});
