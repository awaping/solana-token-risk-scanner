import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { StreamEngine, type VerdictEvent } from '../src/stream/engine.js';
import { computeBundleStats, computeFastScore } from '../src/stream/fast-score.js';
import { ReputationStore } from '../src/stream/reputation.js';
import type { StreamTx } from '../src/stream/sources/types.js';
import { createTxLogs, key, signature, tradeTxLogs } from './fixtures/pump-logs.js';

const SUPPLY = 1_000_000_000_000_000n;
const engines: StreamEngine[] = [];

function setup(opts: Partial<ConstructorParameters<typeof StreamEngine>[0]> = {}) {
  const reputation = new ReputationStore();
  const engine = new StreamEngine({ bundleSlots: 2, trackSeconds: 300, reputation, ...opts });
  const verdicts: VerdictEvent[] = [];
  engine.on('verdict', (v) => verdicts.push(v));
  engines.push(engine);
  const send = (logs: string[], slot: number, extra: Partial<StreamTx> = {}) => {
    const tx: StreamTx = { signature: signature(), slot, logs, failed: false, source: 'test', receivedAt: process.hrtime.bigint(), ...extra };
    engine.handleTx(tx);
    return tx;
  };
  return { engine, reputation, verdicts, send };
}

afterEach(() => engines.splice(0).forEach((e) => e.stop()));

test('T0 immédiat à la création, avec l’achat du dev de la même transaction', () => {
  const { verdicts, send } = setup();
  const mint = key();
  send(createTxLogs({ mint, creator: key(), symbol: 'FAST', devBuyTokens: 30_000_000_000_000n }), 100);

  assert.equal(verdicts.length, 1);
  const t0 = verdicts[0]!;
  assert.equal(t0.phase, 'T0');
  assert.equal(t0.token.symbol, 'FAST');
  assert.equal(t0.token.devBuyTokens, 30_000_000_000_000n);
  assert.ok(t0.decisionMicros !== undefined && t0.decisionMicros >= 0 && t0.decisionMicros < 50_000);
  assert.equal(t0.verdict.level, 'VERT');
});

test('T1 : bundle de wallets clonés dans le slot de création → ROUGE', () => {
  const { verdicts, send } = setup();
  const mint = key();
  const creator = key();
  send(createTxLogs({ mint, creator }), 100);
  for (let i = 0; i < 6; i++) send(tradeTxLogs({ mint, user: key(), sol: 1_000_000_000n, tokens: 30_000_000_000_000n }), 100);
  send(tradeTxLogs({ mint: key(), user: key() }), 102); // un slot plus récent ferme la fenêtre

  const t1 = verdicts.find((v) => v.phase === 'T1');
  assert.ok(t1, 'verdict T1 attendu');
  assert.equal(t1.token.bundle?.sameSlotBuyers, 6);
  assert.equal(t1.token.bundle?.cloneGroupSize, 6);
  assert.ok(Math.abs((t1.token.bundle?.bundlePct ?? 0) - 18) < 1e-9);
  assert.equal(t1.verdict.level, 'ROUGE');
  assert.ok(t1.verdict.floors.some((f) => f.reason.includes('clonés')));
});

test('T1 : lancement organique (achats variés, hors fenêtre) → VERT', () => {
  const { verdicts, send } = setup();
  const mint = key();
  send(createTxLogs({ mint, creator: key(), devBuyTokens: 20_000_000_000_000n }), 200);
  send(tradeTxLogs({ mint, user: key(), sol: 300_000_000n, tokens: 9_000_000_000_000n }), 201);
  send(tradeTxLogs({ mint, user: key(), sol: 1_700_000_000n, tokens: 40_000_000_000_000n }), 205);
  send(tradeTxLogs({ mint: key(), user: key() }), 203);
  const t1 = verdicts.find((v) => v.phase === 'T1')!;
  assert.equal(t1.token.bundle?.windowBuyers, 1);
  assert.equal(t1.verdict.level, 'VERT');
});

test('T1 déclenché par le minuteur si aucun slot plus récent n’arrive', async () => {
  const { verdicts, send } = setup({ bundleSlots: 1 });
  send(createTxLogs({ mint: key(), creator: key() }), 300);
  await new Promise((r) => setTimeout(r, 1_300));
  assert.ok(verdicts.some((v) => v.phase === 'T1'));
});

test('ALERTE : le dev vend → plancher ROUGE et réputation mise à jour', () => {
  const { verdicts, send, reputation } = setup();
  const mint = key();
  const creator = key();
  send(createTxLogs({ mint, creator, devBuyTokens: 20_000_000_000_000n }), 400);
  send(tradeTxLogs({ mint, user: creator, isBuy: false, tokens: 20_000_000_000_000n }), 410);
  const alert = verdicts.find((v) => v.phase === 'ALERTE');
  assert.ok(alert);
  assert.equal(alert.verdict.level, 'ROUGE');
  assert.equal(reputation.snapshot(creator).devSellsSeen, 1);
});

test('réputation : 3e lancement du même créateur signalé dès T0', () => {
  const { verdicts, send } = setup();
  const creator = key();
  for (let i = 0; i < 3; i++) send(createTxLogs({ mint: key(), creator, symbol: `S${i}` }), 500 + i);
  const third = verdicts.filter((v) => v.phase === 'T0')[2]!;
  assert.ok(third.verdict.findings.some((f) => f.message.includes('3 lancements en 24 h')));
  assert.ok(third.verdict.score >= 40);
});

test('copie de symbole récente signalée', () => {
  const { verdicts, send } = setup();
  send(createTxLogs({ mint: key(), creator: key(), symbol: 'PEPE' }), 600);
  send(createTxLogs({ mint: key(), creator: key(), symbol: 'pepe' }), 601);
  const second = verdicts.filter((v) => v.phase === 'T0')[1]!;
  assert.ok(second.token.copycatOf);
});

test('multi-sources : la même signature n’est traitée qu’une fois, victoires comptées', () => {
  const { engine, verdicts } = setup();
  const logs = createTxLogs({ mint: key(), creator: key() });
  const sig = signature();
  const t = process.hrtime.bigint();
  engine.handleTx({ signature: sig, slot: 700, logs, failed: false, source: 'rapide', receivedAt: t });
  engine.handleTx({ signature: sig, slot: 700, logs, failed: false, source: 'lent', receivedAt: t + 3_000_000n });
  assert.equal(verdicts.length, 1);
  const stats = engine.stats();
  assert.equal(stats.wins.rapide, 1);
  assert.equal(stats.txDuplicates, 1);
  assert.equal(stats.lagMs.lent, 3);
});

test('transactions échouées ignorées', () => {
  const { verdicts, send } = setup();
  send(createTxLogs({ mint: key(), creator: key() }), 800, { failed: true });
  assert.equal(verdicts.length, 0);
});

test('achats reçus avant la création (autre source) rattachés au token', () => {
  const { verdicts, send } = setup();
  const mint = key();
  for (let i = 0; i < 3; i++) send(tradeTxLogs({ mint, user: key(), sol: 2_000_000_000n }), 900);
  send(createTxLogs({ mint, creator: key() }), 900);
  send(tradeTxLogs({ mint: key(), user: key() }), 903);
  const t1 = verdicts.find((v) => v.phase === 'T1')!;
  assert.equal(t1.token.bundle?.sameSlotBuyers, 3);
  assert.equal(t1.token.bundle?.cloneGroupSize, 3);
});

test('T2 : enrichissement asynchrone du créateur', async () => {
  const { verdicts, send } = setup({
    enrich: async () => ({ previousTokensCreated: 12, signatureCount: 40, fullHistory: true, walletAgeDays: 0.5, solBalance: 0.2, txScanned: 25 }),
  });
  send(createTxLogs({ mint: key(), creator: key() }), 1000);
  await new Promise((r) => setImmediate(r));
  const t2 = verdicts.find((v) => v.phase === 'T2');
  assert.ok(t2);
  assert.ok(t2.verdict.score >= 60, `score ${t2.verdict.score}`);
  assert.ok(t2.verdict.findings.some((f) => f.message.includes('12 autres tokens')));
});

test('logs tronqués : création retrouvée via le RPC', async () => {
  const mint = key();
  const creator = key();
  const { verdicts, send } = setup({ resolveMissingCreate: async () => ({ mint, creator }) });
  send(createTxLogs({ mint, creator, truncated: true }), 1100);
  await new Promise((r) => setImmediate(r));
  const t0 = verdicts.find((v) => v.phase === 'T0');
  assert.equal(t0?.token.mint, mint);
  assert.equal(t0?.token.viaRpcFallback, true);
});

test('computeBundleStats : groupe de montants identiques à 0,1 % près', () => {
  const dev = key();
  const trades = [
    { signature: 'a', slot: 10, user: key(), isBuy: true, solAmount: 1_000_000_000n, tokenAmount: 10n },
    { signature: 'b', slot: 10, user: key(), isBuy: true, solAmount: 999_500_000n, tokenAmount: 10n },
    { signature: 'c', slot: 11, user: key(), isBuy: true, solAmount: 1_000_400_000n, tokenAmount: 10n },
    { signature: 'd', slot: 11, user: key(), isBuy: true, solAmount: 3_000_000_000n, tokenAmount: 10n },
    { signature: 'e', slot: 10, user: dev, isBuy: true, solAmount: 1_000_000_000n, tokenAmount: 10n },
    { signature: 'f', slot: 12, user: key(), isBuy: true, solAmount: 1_000_000_000n, tokenAmount: 10n },
  ];
  const stats = computeBundleStats(trades, 10, 2, new Set([dev]), SUPPLY);
  assert.equal(stats.sameSlotBuyers, 2);
  assert.equal(stats.windowBuyers, 4);
  assert.equal(stats.cloneGroupSize, 3);
});

test('computeFastScore : token inconnu sans signal → 0 VERT', () => {
  const verdict = computeFastScore({ creator: { address: key(), launches24h: 1, devSellsSeen: 0 }, devBuyPct: 0, devSold: false });
  assert.equal(verdict.score, 0);
  assert.equal(verdict.level, 'VERT');
});
