/**
 * Démo hors-ligne du mode stream : un faux nœud WebSocket rejoue une
 * séquence de lancements Pump.fun typiques, analysés en temps réel par la
 * vraie commande (tableau de bord trié par activité).
 *
 *   npm run demo:stream
 *   npm run demo:stream -- --all      (journal complet de chaque lancement)
 *   npm run demo:stream -- robinhood  (démo EVM : Robinhood Chain, Base, BSC…)
 */
import '../src/utils/quiet-warnings.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import { runStream } from '../src/stream/cli.js';
import { createTxLogs, key, signature, SimulatedCurve } from '../src/stream/synthetic.js';
import { findChain } from '../src/chains/registry.js';
import { runEvmDemo } from './demo-stream-evm.js';

// `npm run demo:stream -- robinhood` : démo EVM sur la chaîne demandée.
const requested = process.argv[2] && !process.argv[2].startsWith('--') ? findChain(process.argv[2]) : null;
if (requested?.kind === 'evm') {
  await runEvmDemo(requested, process.argv.slice(3));
  process.exit(0);
}

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
const push = (logs: string[]) =>
  client?.send(
    JSON.stringify({
      jsonrpc: '2.0',
      method: 'logsNotification',
      params: { result: { context: { slot }, value: { signature: signature(), err: null, logs } }, subscription: 1 },
    }),
  );
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const nextSlot = async (ms = 150) => {
  slot++;
  await sleep(ms);
};
const curves = new Map<string, SimulatedCurve>();
const curve = (mint: string) => curves.get(mint) ?? curves.set(mint, new SimulatedCurve(mint)).get(mint)!;
const holdings = new Map<string, bigint>();
const buy = (mint: string, user: string, sol: number) => {
  const lamports = BigInt(Math.round(sol * 1e9));
  holdings.set(`${mint}:${user}`, (holdings.get(`${mint}:${user}`) ?? 0n) + curve(mint).quote(lamports));
  push(curve(mint).buy(user, lamports));
};
const sellAll = (mint: string, user: string) => {
  const amount = holdings.get(`${mint}:${user}`) ?? 0n;
  holdings.delete(`${mint}:${user}`);
  if (amount > 0n) push(curve(mint).sell(user, amount));
};
/** Création avec achat initial du dev (dans la même transaction, comme sur Pump.fun). */
const launch = (mint: string, creator: string, name: string, symbol: string, devSol = 0) => {
  const devTokens = devSol > 0 ? curve(mint).quote(BigInt(Math.round(devSol * 1e9))) : 0n;
  push(createTxLogs({ mint, creator, name, symbol, devBuyTokens: devTokens, devBuySol: BigInt(Math.round(devSol * 1e9)) }));
  if (devSol > 0) {
    curve(mint).buy(creator, BigInt(Math.round(devSol * 1e9))); // met à jour la courbe
    holdings.set(`${mint}:${creator}`, devTokens);
  }
};

const { port } = server.address() as { port: number };
const cache = join(mkdtempSync(join(tmpdir(), 'sol-risk-demo-')), 'creators.json');
const extra = process.argv.slice(2).filter((a) => a !== 'solana' && a !== 'sol');
const run = runStream(['solana', '--ws', `ws://127.0.0.1:${port}`, '--no-enrich', '--refresh', '1', '--cache', cache, ...extra]);
await subscribed;
await sleep(300);

// Lancements
const organic = key();
const rug = key();
const rugDev = key();
const whaleToken = key();
launch(organic, key(), 'Honest Frog', 'HFROG', 0.5);
launch(rug, rugDev, 'Moon Rocket', 'MOON', 4);
for (let i = 0; i < 7; i++) buy(rug, key(), 1.5); // 7 wallets clonés dans le slot de création
launch(whaleToken, key(), 'Big Whale', 'WHALE');
// 12 lancements morts : personne n'achète, ils n'apparaîtront jamais dans le classement.
for (let i = 0; i < 12; i++) launch(key(), key(), `Dead ${i}`, `DEAD${i}`);
await nextSlot();

// Activité sur plusieurs secondes
const organicHolders: string[] = [];
for (let round = 0; round < 25; round++) {
  const u = key();
  organicHolders.push(u);
  buy(organic, u, 0.1 + (round % 7) * 0.13);
  if (round % 4 === 3) sellAll(organic, organicHolders[round - 2]!);
  if (round < 14) buy(rug, key(), 0.4 + (round % 5) * 0.2);
  if (round === 2) buy(whaleToken, key(), 18); // une baleine rafle ~40 % de la supply
  if (round > 2 && round < 18) buy(whaleToken, key(), 0.05 + (round % 3) * 0.04);
  await nextSlot(round < 20 ? 150 : 250);
}

// Le dev du rug revend : alerte en temps réel.
sellAll(rug, rugDev);
await sleep(1_500);

process.emit('SIGINT');
await run;
server.close();
