import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { applyTrade, marketMetrics, newActivity, tradesLastMinute } from '../src/stream/activity.js';
import { buildBoard, renderBoard } from '../src/stream/dashboard.js';
import { StreamEngine, type VerdictEvent } from '../src/stream/engine.js';
import { ReputationStore } from '../src/stream/reputation.js';
import type { StreamTx } from '../src/stream/sources/types.js';
import { createTxLogs, key, signature, tradeTxLogs } from './fixtures/pump-logs.js';

const trade = (userKey: string, isBuy: boolean, tokenAmount: bigint) => ({
  userKey,
  isBuy,
  tokenAmount,
  solAmount: 1_000_000_000n,
  virtualSolReserves: 40_000_000_000n,
  virtualTokenReserves: 804_750_000_000_000n,
});

test('activité : holders exacts à partir des achats et ventes', () => {
  const a = newActivity();
  applyTrade(a, trade('A', true, 100n), 1_000);
  applyTrade(a, trade('B', true, 50n), 1_000);
  applyTrade(a, trade('A', false, 40n), 1_000); // vente partielle : A reste holder
  assert.equal(a.holders, 2);
  applyTrade(a, trade('B', false, 50n), 1_000); // vente totale : B sort
  assert.equal(a.holders, 1);
  applyTrade(a, trade('C', false, 10n), 1_000); // vente sans achat observé : ignorée, jamais négatif
  assert.equal(a.holders, 1);
  assert.equal(a.trades, 5);
  assert.equal(a.buys, 2);
  assert.equal(a.sells, 3);
  assert.equal(a.volumeLamports, 5_000_000_000n);
});

test('activité : momentum sur 60 s et métriques de marché de la curve', () => {
  const a = newActivity();
  applyTrade(a, trade('A', true, 1n), 0);
  applyTrade(a, trade('B', true, 1n), 50_000);
  applyTrade(a, trade('C', true, 1n), 70_000);
  assert.equal(tradesLastMinute(a, 70_000), 2);
  const m = marketMetrics(a, 1_000_000_000_000_000n);
  // prix = 40 SOL / 804,75 M tokens ; mcap = prix × 1 Md ≈ 49,7 SOL
  assert.ok(Math.abs(m.marketCapSol - 49.7) < 0.1, `mcap ${m.marketCapSol}`);
  // réserve réelle = 804,75 M − 279,9 M = 524,85 M sur 793,1 M → ≈ 33,8 % vendus
  assert.ok(Math.abs(m.progressPct - 33.8) < 0.1, `progression ${m.progressPct}`);
});

const engines: StreamEngine[] = [];
afterEach(() => engines.splice(0).forEach((e) => e.stop()));

function setup(now = () => Date.now()) {
  const engine = new StreamEngine({
    bundleSlots: 1,
    trackSeconds: 1_800,
    reputation: new ReputationStore(),
    activity: { minTrades: 6 },
    inactiveTtlSeconds: 60,
    now,
  });
  engines.push(engine);
  const verdicts: VerdictEvent[] = [];
  engine.on('verdict', (v) => verdicts.push(v));
  let slot = 1_000;
  const send = (logs: string[]) => {
    const tx: StreamTx = { signature: signature(), slot: slot++, logs, failed: false, source: 't', receivedAt: process.hrtime.bigint() };
    engine.handleTx(tx);
  };
  return { engine, verdicts, send };
}

test('ACTIF : seul le nombre de trades compte, pas le nombre de holders', () => {
  const { verdicts, send, engine } = setup();
  const mint = key();
  const trader = key();
  send(createTxLogs({ mint, creator: key(), symbol: 'LIVE' }));
  for (let i = 0; i < 5; i++) send(tradeTxLogs({ mint, user: trader, sol: 100_000_000n, tokens: 1_000_000_000_000n }));
  assert.equal(verdicts.filter((v) => v.phase === 'ACTIF').length, 0); // 5 trades < 6
  send(tradeTxLogs({ mint, user: trader, sol: 100_000_000n, tokens: 1_000_000_000_000n }));
  const actif = verdicts.filter((v) => v.phase === 'ACTIF');
  assert.equal(actif.length, 1);
  assert.equal(actif[0]!.token.activity.holders, 1); // un seul wallet : actif quand même
  send(tradeTxLogs({ mint, user: key(), sol: 100_000_000n, tokens: 1_000_000_000_000n }));
  assert.equal(verdicts.filter((v) => v.phase === 'ACTIF').length, 1); // émis une seule fois
  assert.equal(engine.stats().active, 1);
});

test('classement : seuls les tokens actifs, triés par la clé demandée', () => {
  const { send, engine } = setup();
  const make = (symbol: string, buyers: number, solPerBuyer: bigint, extraTrades: number) => {
    const mint = key();
    send(createTxLogs({ mint, creator: key(), symbol }));
    const users = Array.from({ length: buyers }, key);
    for (const u of users) send(tradeTxLogs({ mint, user: u, sol: solPerBuyer, tokens: 1_000_000_000_000n }));
    for (let i = 0; i < extraTrades; i++) send(tradeTxLogs({ mint, user: users[0]!, sol: 100_000_000n, tokens: 1_000_000_000n }));
    return mint;
  };
  make('BIGVOL', 20, 1_000_000_000n, 0); // 20 trades, 20 SOL
  make('MANYTRADE', 6, 200_000_000n, 60); // 66 trades, 7,2 SOL
  make('DEAD', 1, 200_000_000n, 0); // 1 trade : jamais actif
  const byTrades = buildBoard(engine, { sort: 'trades', limit: 10, now: Date.now() });
  assert.deepEqual(byTrades.map((r) => r.token.symbol), ['MANYTRADE', 'BIGVOL']);
  const byVolume = buildBoard(engine, { sort: 'volume', limit: 10, now: Date.now() });
  assert.deepEqual(byVolume.map((r) => r.token.symbol), ['BIGVOL', 'MANYTRADE']);
  const onlyRed = buildBoard(engine, { sort: 'trades', limit: 10, only: new Set(['ROUGE']), now: Date.now() });
  assert.equal(onlyRed.length, 0);
  const lines = renderBoard(byTrades, 'trades');
  assert.equal(lines.length, 3);
  assert.match(lines[1]!, /MANYTRADE/);
});

test('concentration réelle : une baleine non-dev fait monter le risque', () => {
  const { send, engine } = setup();
  const mint = key();
  send(createTxLogs({ mint, creator: key(), symbol: 'WHALE' }));
  send(tradeTxLogs({ mint, user: key(), sol: 20_000_000_000n, tokens: 350_000_000_000_000n })); // 35 %
  for (let i = 0; i < 6; i++) send(tradeTxLogs({ mint, user: key(), sol: 100_000_000n, tokens: 2_000_000_000_000n }));
  const row = buildBoard(engine, { sort: 'trades', limit: 5, now: Date.now() })[0]!;
  assert.ok(row.top10Pct > 35);
  assert.equal(row.verdict.level, 'ROUGE');
  assert.ok(row.verdict.findings.some((f) => f.message.includes('Un wallet détient')));
});

test('les lancements morts sont oubliés après le délai d’inactivité', () => {
  let now = 1_000_000;
  const { send, engine } = setup(() => now);
  send(createTxLogs({ mint: key(), creator: key(), symbol: 'GHOST' }));
  assert.equal(engine.stats().tracked, 1);
  now += 61_000;
  (engine as unknown as { cleanup(): void }).cleanup();
  assert.equal(engine.stats().tracked, 0);
});
