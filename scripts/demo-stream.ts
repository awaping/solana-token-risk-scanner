/**
 * Démo hors-ligne du mode stream : un faux nœud WebSocket rejoue quatre
 * lancements Pump.fun typiques, analysés en temps réel par la vraie commande.
 *
 *   npm run demo:stream
 */
import '../src/utils/quiet-warnings.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import { runStream } from '../src/stream/cli.js';
import { createTxLogs, key, signature, tradeTxLogs } from '../src/stream/synthetic.js';

const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
await new Promise<void>((resolve) => server.once('listening', () => resolve()));
let client: WebSocket | undefined;
const subscribed = new Promise<void>((resolve) => {
  server.on('connection', (socket) => {
    socket.on('message', (raw) => {
      const msg = JSON.parse(raw.toString()) as { id: number };
      socket.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: 1 }));
      client = socket;
      resolve();
    });
  });
});

let slot = 330_000_000;
const push = (logs: string[], atSlot = slot) =>
  client?.send(
    JSON.stringify({
      jsonrpc: '2.0',
      method: 'logsNotification',
      params: { result: { context: { slot: atSlot }, value: { signature: signature(), err: null, logs } }, subscription: 1 },
    }),
  );
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const tick = async () => {
  slot++;
  push(tradeTxLogs({ mint: key(), user: key() })); // trafic de fond qui fait avancer les slots
  await sleep(400);
};

const { port } = server.address() as { port: number };
const cache = join(mkdtempSync(join(tmpdir(), 'sol-risk-demo-')), 'creators.json');
const run = runStream(['--ws', `ws://127.0.0.1:${port}`, '--no-enrich', '--stats', '0', '--cache', cache]);
await subscribed;
await sleep(300);

// 1. Lancement propre : petit achat du dev, acheteurs dispersés dans le temps.
const clean = key();
push(createTxLogs({ mint: clean, creator: key(), name: 'Honest Frog', symbol: 'HFROG', devBuyTokens: 15_000_000_000_000n }));
await tick();
push(tradeTxLogs({ mint: clean, user: key(), sol: 250_000_000n, tokens: 8_000_000_000_000n }));
await tick();
await tick();

// 2. Rug bundlé : le dev prend 12 %, 7 wallets clonés achètent 1,5 SOL dans le même slot.
const rug = key();
const rugDev = key();
push(createTxLogs({ mint: rug, creator: rugDev, name: 'Moon Rocket', symbol: 'MOON', devBuyTokens: 120_000_000_000_000n }));
for (let i = 0; i < 7; i++) push(tradeTxLogs({ mint: rug, user: key(), sol: 1_500_000_000n, tokens: 40_000_000_000_000n }));
await tick();
await tick();
await tick();

// 3. Déployeur en série : le même wallet lance son 3e token en quelques secondes.
const serial = key();
for (const symbol of ['CAT1', 'CAT2', 'CAT3']) {
  push(createTxLogs({ mint: key(), creator: serial, name: `Serial ${symbol}`, symbol }));
  await tick();
}
await tick();

// 4. Le dev du rug revend : alerte en temps réel.
push(tradeTxLogs({ mint: rug, user: rugDev, isBuy: false, tokens: 120_000_000_000_000n }));
await sleep(500);

process.emit('SIGINT');
await run;
server.close();
