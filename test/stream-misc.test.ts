import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ReputationStore } from '../src/stream/reputation.js';
import { GrpcSource } from '../src/stream/sources/grpc.js';
import { httpToWs, parseLogsNotification } from '../src/stream/sources/websocket.js';
import { warmUpHotPath } from '../src/stream/warmup.js';
import { key } from './fixtures/pump-logs.js';

test('parseLogsNotification : notification, accusé, refus, bruit', () => {
  const t = process.hrtime.bigint();
  const tx = parseLogsNotification(
    JSON.stringify({ method: 'logsNotification', params: { result: { context: { slot: 9 }, value: { signature: 'abc', err: { x: 1 }, logs: ['a'] } } } }),
    'src',
    t,
  );
  assert.ok(tx && typeof tx !== 'string');
  assert.equal(tx.slot, 9);
  assert.equal(tx.failed, true);
  assert.equal(tx.receivedAt, t);
  assert.equal(parseLogsNotification('{"jsonrpc":"2.0","id":1,"result":7}', 's', t), 'subscribed');
  assert.equal(parseLogsNotification('{"jsonrpc":"2.0","id":1,"error":{"message":"interdit"}}', 's', t), 'interdit');
  assert.equal(parseLogsNotification('pas du json', 's', t), null);
});

test('httpToWs : dérive l’URL WebSocket en conservant la clé d’API', () => {
  assert.equal(httpToWs('https://mainnet.helius-rpc.com/?api-key=K'), 'wss://mainnet.helius-rpc.com/?api-key=K');
  assert.equal(httpToWs('http://127.0.0.1:8899'), 'ws://127.0.0.1:8899');
});

test('réputation : persistance atomique et rechargement', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'rep-')), 'sub', 'creators.json');
  const creator = key();
  const store = new ReputationStore(path);
  store.recordLaunch(creator, key());
  store.recordLaunch(creator, key());
  store.recordDevSell(creator);
  store.setEnrichment(creator, { previousTokensCreated: 4, signatureCount: 30, fullHistory: true, solBalance: 1, txScanned: 25 });
  store.save();

  const reloaded = new ReputationStore(path);
  assert.equal(reloaded.load(), 1);
  const snap = reloaded.snapshot(creator);
  assert.equal(snap.launches24h, 2);
  assert.equal(snap.devSellsSeen, 1);
  assert.equal(snap.enrichment?.previousTokensCreated, 4);
  assert.equal(reloaded.needsEnrichment(creator), false);
  assert.equal(reloaded.needsEnrichment(creator, Date.now() + 7 * 3_600_000), true);
});

test('source gRPC : message explicite si le paquet optionnel est absent', async () => {
  const source = new GrpcSource({ endpoint: 'https://grpc.example.org', programId: key() });
  await assert.rejects(() => source.start(() => undefined, () => undefined), /npm install @triton-one\/yellowstone-grpc/);
});

test('préchauffage JIT : exécute le chemin complet sans effet de bord', () => {
  let verdicts = 0;
  const result = warmUpHotPath(2_000, () => verdicts++);
  assert.equal(result.iterations, 2_000);
  assert.ok(verdicts > 80);
});
