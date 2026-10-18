/**
 * Historique des analyses de l'extension : instantanés d'un vrai scan, analyse
 * initiale + actualisations, index, plafonds, suppression.
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { toSnapshot } from '../extension/src/history-snapshot.js';
import { HistoryStore, MAX_SCANS_PER_COIN, type KeyValueStore, type ScanSnapshot } from '../extension/src/history-store.js';
import { scanToken } from '../src/scanner.js';
import { startMockRpc } from './fixtures/mock-rpc.js';
import { buildRugChain } from './fixtures/scenarios.js';

/** Stockage en mémoire qui, comme chrome.storage, ne garde que du JSON. */
function memoryStore(): KeyValueStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    get: async (keys) => Object.fromEntries(keys.filter((k) => data.has(k)).map((k) => [k, JSON.parse(data.get(k)!)])),
    set: async (items) => {
      for (const [k, v] of Object.entries(items)) data.set(k, JSON.stringify(v));
    },
    remove: async (keys) => {
      for (const k of keys) data.delete(k);
    },
  };
}

function fakeSnapshot(mint: string, at: number, score: number): ScanSnapshot {
  const level = score >= 70 ? 'ROUGE' : score > 30 ? 'ORANGE' : 'VERT';
  return {
    mint,
    symbol: mint.slice(0, 4).toUpperCase(),
    point: { at, score, level, coverage: 1, modules: {}, metrics: { top10Pct: score / 2 }, alerts: [] },
    detail: {
      at,
      token: { mint, program: 'SPL Token', decimals: 6, supply: '1000', mintAuthority: null, freezeAuthority: null, dangerousExtensions: [] },
      modules: [],
      floors: [],
      durationMs: 10,
      rpcRequests: 1,
    },
  };
}

const servers: Server[] = [];
after(() => servers.forEach((s) => s.close()));

test('instantané d’un vrai scan : chiffres clés et détail, en JSON pur', async () => {
  const { chain, mint } = buildRugChain();
  const { url, server } = await startMockRpc(chain);
  servers.push(server);
  const result = await scanToken(mint.toBase58(), { rpcUrl: url, concurrency: 8, maxRetries: 0, creatorTxScanLimit: 50, mintHistoryMaxPages: 2, holderCensus: true });

  const snapshot = toSnapshot(result, 1_000);
  assert.deepEqual(JSON.parse(JSON.stringify(snapshot)), snapshot, 'aucun BigInt ni Date');
  assert.equal(snapshot.point.score, result.risk.score);
  assert.equal(snapshot.point.metrics.reserveSol, 3);
  assert.equal(snapshot.point.metrics.largestClusterSize, 10);
  assert.equal(snapshot.point.metrics.holders, 815);
  assert.ok(snapshot.point.alerts.some((a) => a.message.startsWith('Wallets clonés')));
  assert.equal(snapshot.detail.token.supply, result.token.supply.toString());
  assert.equal(snapshot.detail.holders?.length, 20);
  assert.equal(snapshot.detail.modules.length, 6);
});

test('analyse initiale puis actualisations : la première est la référence, la précédente est connue', async () => {
  const history = new HistoryStore(memoryStore());
  const first = await history.record(fakeSnapshot('AAAA1', 1_000, 40));
  assert.deepEqual(first, { count: 1, first: { at: 1_000, score: 40 } });

  await history.record(fakeSnapshot('AAAA1', 2_000, 55));
  const third = await history.record(fakeSnapshot('AAAA1', 3_000, 72));
  assert.deepEqual(third, { count: 3, first: { at: 1_000, score: 40 }, previous: { at: 2_000, score: 55 } });

  const coin = await history.get('AAAA1');
  assert.deepEqual(coin?.scans.map((s) => s.score), [40, 55, 72]);
  assert.equal(coin?.latest.at, 3_000);
  assert.equal(coin?.firstSeen, 1_000);
});

test('index : tokens du plus récent au plus ancien, avec évolution ; suppression et effacement', async () => {
  const history = new HistoryStore(memoryStore());
  await history.record(fakeSnapshot('AAAA1', 1_000, 40));
  await history.record(fakeSnapshot('BBBB2', 2_000, 80));
  await history.record(fakeSnapshot('AAAA1', 3_000, 20));

  const list = await history.list();
  assert.deepEqual(list.map((c) => c.mint), ['AAAA1', 'BBBB2']);
  assert.deepEqual([list[0]!.firstScore, list[0]!.lastScore, list[0]!.count, list[0]!.minScore, list[0]!.maxScore], [40, 20, 2, 20, 40]);
  assert.deepEqual(list[0]!.trend, [40, 20]);
  assert.equal((await history.exportAll()).length, 2);

  await history.remove('AAAA1');
  assert.deepEqual((await history.list()).map((c) => c.mint), ['BBBB2']);
  assert.equal(await history.get('AAAA1'), null);

  await history.clear();
  assert.deepEqual(await history.list(), []);
});

test('écritures simultanées sérialisées et plafond d’analyses (la première est conservée)', async () => {
  const history = new HistoryStore(memoryStore());
  await Promise.all(Array.from({ length: 20 }, (_, i) => history.record(fakeSnapshot(`COIN${i}`, i, i))));
  assert.equal((await history.list()).length, 20, 'aucune écriture perdue');

  for (let i = 0; i < MAX_SCANS_PER_COIN + 5; i++) await history.record(fakeSnapshot('LONG1', 10_000 + i, i % 100));
  const coin = await history.get('LONG1');
  assert.equal(coin?.scans.length, MAX_SCANS_PER_COIN);
  assert.equal(coin?.scans[0]!.at, 10_000, 'analyse initiale gardée');
  assert.equal(coin?.scans.at(-1)!.at, 10_000 + MAX_SCANS_PER_COIN + 4);
});
