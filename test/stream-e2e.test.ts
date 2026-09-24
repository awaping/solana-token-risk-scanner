/**
 * Bout en bout du mode stream : un faux nœud WebSocket Solana répond à
 * `logsSubscribe` et pousse des notifications Pump.fun.
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import { PUMP_FUN_PROGRAM_ID } from '../src/constants.js';
import { WebSocketLogsSource } from '../src/stream/sources/websocket.js';
import type { StreamTx } from '../src/stream/sources/types.js';
import { createTxLogs, key, signature, tradeTxLogs } from './fixtures/pump-logs.js';

interface MockNode {
  url: string;
  clients: Set<WebSocket>;
  subscriptions: unknown[];
  push(logs: string[], slot: number): void;
  dropAll(): void;
  close(): Promise<void>;
}

async function startMockNode(): Promise<MockNode> {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const clients = new Set<WebSocket>();
  const subscriptions: unknown[] = [];
  server.on('connection', (socket) => {
    socket.on('message', (raw) => {
      const msg = JSON.parse(raw.toString()) as { id: number; method: string; params: unknown[] };
      if (msg.method === 'logsSubscribe') {
        subscriptions.push(msg.params);
        clients.add(socket);
        socket.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: 42 }));
      }
    });
    socket.on('close', () => clients.delete(socket));
  });
  const address = server.address() as { port: number };
  return {
    url: `ws://127.0.0.1:${address.port}`,
    clients,
    subscriptions,
    push(logs, slot) {
      const payload = JSON.stringify({
        jsonrpc: '2.0',
        method: 'logsNotification',
        params: { result: { context: { slot }, value: { signature: signature(), err: null, logs } }, subscription: 42 },
      });
      for (const client of clients) client.send(payload);
    },
    dropAll() {
      for (const client of clients) client.terminate();
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const nodes: MockNode[] = [];
after(async () => {
  for (const node of nodes) await node.close();
});

const waitFor = async (predicate: () => boolean, timeoutMs = 5_000) => {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('délai dépassé');
    await new Promise((r) => setTimeout(r, 20));
  }
};

test('source WebSocket : abonnement processed, réception et reconnexion automatique', async () => {
  const node = await startMockNode();
  nodes.push(node);
  const received: StreamTx[] = [];
  const source = new WebSocketLogsSource({ url: node.url, programId: PUMP_FUN_PROGRAM_ID.toBase58() });
  await source.start((tx) => received.push(tx), () => undefined);

  await waitFor(() => node.clients.size === 1);
  assert.deepEqual(node.subscriptions[0], [{ mentions: [PUMP_FUN_PROGRAM_ID.toBase58()] }, { commitment: 'processed' }]);

  node.push(tradeTxLogs({ mint: key(), user: key() }), 123);
  await waitFor(() => received.length === 1);
  assert.equal(received[0]!.slot, 123);
  assert.equal(received[0]!.failed, false);
  assert.equal(typeof received[0]!.receivedAt, 'bigint');

  node.dropAll(); // coupure réseau
  await waitFor(() => node.clients.size === 1 && node.subscriptions.length === 2);
  node.push(tradeTxLogs({ mint: key(), user: key() }), 124);
  await waitFor(() => received.length === 2);
  await source.stop();
});

test('CLI stream : verdicts JSONL en temps réel puis arrêt propre sur SIGINT', async () => {
  const node = await startMockNode();
  nodes.push(node);
  const cache = join(mkdtempSync(join(tmpdir(), 'sol-risk-')), 'creators.json');
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', 'src/index.ts', 'stream', '--ws', node.url, '--no-enrich', '--jsonl', '--stats', '0', '--cache', cache, '--bundle-slots', '1'],
    { env: { ...process.env, NO_COLOR: '1', SOLANA_RPC_URL: 'http://127.0.0.1:1' }, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let stdout = '';
  child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
  const exited = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)));

  await waitFor(() => node.clients.size === 1, 20_000);
  const mint = key();
  const creator = key();
  node.push(createTxLogs({ mint, creator, symbol: 'RUG', devBuyTokens: 350_000_000_000_000n }), 5000);
  for (let i = 0; i < 4; i++) node.push(tradeTxLogs({ mint, user: key(), sol: 1_500_000_000n }), 5000);
  node.push(tradeTxLogs({ mint: key(), user: key() }), 5002);

  const lines = () => stdout.split('\n').filter(Boolean).map((l) => JSON.parse(l) as { phase: string; mint: string; level: string; decisionMicros: number | null });
  await waitFor(() => lines().some((l) => l.phase === 'T1'), 10_000);

  const t0 = lines().find((l) => l.phase === 'T0')!;
  assert.equal(t0.mint, mint);
  assert.equal(t0.level, 'ROUGE'); // dev à 35 % dès la création
  assert.ok(typeof t0.decisionMicros === 'number');
  const t1 = lines().find((l) => l.phase === 'T1')!;
  assert.equal(t1.level, 'ROUGE');

  child.kill('SIGINT');
  assert.equal(await exited, 0);
});
