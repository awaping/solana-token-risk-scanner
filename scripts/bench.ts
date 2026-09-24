/**
 * Benchmark du chemin critique du mode stream, hors réseau :
 * message WebSocket brut → JSON.parse → décodage des logs → score → verdict T0.
 *
 *   npm run bench              # 200 000 transactions simulées
 *   npm run bench -- 1000000
 */
import '../src/utils/quiet-warnings.js';
import { StreamEngine } from '../src/stream/engine.js';
import { ReputationStore } from '../src/stream/reputation.js';
import type { StreamTx } from '../src/stream/sources/types.js';
import { createTxLogs, key, tradeTxLogs } from '../src/stream/synthetic.js';

const total = Number(process.argv[2] ?? 200_000);
const CREATE_EVERY = 50;

// 1. Pool d'adresses pré-générées (la génération de clés est lente et hors sujet ici).
const pool = Array.from({ length: 4_000 }, key);
const pick = (i: number) => pool[(i * 2_654_435_761) % pool.length]!;
const creators = pool.slice(0, 200);
const recentMints: string[] = [];
let slot = 300_000_000;

/** Construit le message WebSocket brut n° i (non mesuré). */
function buildMessage(i: number): string {
  if (i % 100 === 0) slot++;
  let logs: string[];
  if (i % CREATE_EVERY === 0) {
    const mint = key();
    recentMints.push(mint);
    if (recentMints.length > 20) recentMints.shift();
    logs = createTxLogs({ mint, creator: creators[i % creators.length]!, symbol: `B${i}`, devBuyTokens: 25_000_000_000_000n });
  } else {
    const mint = i % 10 < 3 && recentMints.length ? recentMints[i % recentMints.length]! : pick(i);
    logs = tradeTxLogs({ mint, user: pick(i + 7), isBuy: i % 5 !== 0, sol: BigInt(100_000_000 + ((i * 7_919) % 2_000_000_000)) });
  }
  return JSON.stringify({
    jsonrpc: '2.0',
    method: 'logsNotification',
    params: { result: { context: { slot }, value: { signature: `bench${i}`, err: null, logs } }, subscription: 1 },
  });
}

// 2. Rejeu mesuré.
const engine = new StreamEngine({ bundleSlots: 2, trackSeconds: 300, reputation: new ReputationStore() });
// Les 10 % premiers messages servent à chauffer le JIT de V8 et ne sont pas mesurés.
const warmup = Math.floor(total / 10);
let measuring = false;
const t0: number[] = [];
engine.on('verdict', (v) => {
  if (measuring && v.phase === 'T0' && v.decisionMicros !== undefined) t0.push(v.decisionMicros);
});
engine.start();

const perTx: number[] = [];
let busyNs = 0n;
for (let i = 0; i < total; i++) {
  measuring = i >= warmup;
  const raw = buildMessage(i);
  const receivedAt = process.hrtime.bigint();
  const msg = JSON.parse(raw) as { params: { result: { context: { slot: number }; value: { signature: string; logs: string[] } } } };
  const { context, value } = msg.params.result;
  const tx: StreamTx = { signature: value.signature, slot: context.slot, logs: value.logs, failed: false, source: 'bench', receivedAt };
  engine.handleTx(tx);
  const spent = process.hrtime.bigint() - receivedAt;
  if (measuring) {
    busyNs += spent;
    perTx.push(Number(spent) / 1_000);
  }
  if (i % 5_000 === 4_999) await new Promise((r) => setImmediate(r)); // laisse tourner les minuteurs
}
const elapsedS = Number(busyNs) / 1e9;
engine.stop();

const pct = (values: ArrayLike<number>, q: number) => {
  const sorted = Array.from(values).sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
};
const f = (n: number) => n.toFixed(1).padStart(7);

console.log(`\nBenchmark du chemin critique (${total.toLocaleString('fr-FR')} transactions, Node ${process.version})\n`);
console.log(`  Capacité                   : ${Math.round(perTx.length / elapsedS).toLocaleString('fr-FR')} tx/s sur un cœur (le flux Pump.fun réel : quelques centaines de tx/s)`);
console.log(`  Traitement d'une tx        : p50 ${f(pct(perTx, 0.5))} µs · p99 ${f(pct(perTx, 0.99))} µs`);
console.log(`  Décision T0 (création)     : p50 ${f(pct(t0, 0.5))} µs · p99 ${f(pct(t0, 0.99))} µs · max ${f(pct(t0, 1))} µs  (${t0.length} lancements)`);
console.log('\n  Mesure : réception du message brut → JSON.parse → décodage → score → verdict émis (affichage exclu).\n');
