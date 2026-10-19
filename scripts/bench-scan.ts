/**
 * Benchmark du scan complet (celui de l'extension à l'ouverture d'un token),
 * contre un RPC simulé qui reproduit un fournisseur réel :
 *
 *   - latence par requête (aller-retour réseau + coût serveur de la méthode) ;
 *   - limite de débit côté serveur (Helius gratuit : 10 requêtes/s) → 429 ;
 *
 * avec les réglages client de l'extension (3 requêtes en parallèle, 8/s).
 * Mesure la durée totale, le nombre de requêtes, et la durée de chaque module.
 *
 *   npm run bench:scan            # 5 répétitions par scénario
 *   npm run bench:scan -- 10      # 10 répétitions
 *   RTT=150 RPS=50 npm run bench:scan
 */
import '../src/utils/quiet-warnings.js';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { memoryCache } from '../src/cache.js';
import { EXTENSION_SCAN } from '../src/config.js';
import { RpcClient } from '../src/rpc/client.js';
import { scanToken } from '../src/scanner.js';
import type { MockChain } from '../test/fixtures/mock-rpc.js';
import { buildDevRugChain, buildHealthyChain, buildRaydiumChain, buildRugChain } from '../test/fixtures/scenarios.js';

const RUNS = Number(process.argv[2] ?? 5);
const RTT = Number(process.env.RTT ?? 90);
const SERVER_RPS = Number(process.env.RPS ?? 10);
const CLIENT = { concurrency: Number(process.env.CONCURRENCY ?? 3), maxRps: Number(process.env.MAX_RPS ?? 8) };

/** Coût serveur ajouté à l'aller-retour, par méthode (ordres de grandeur observés sur mainnet). */
const SERVER_MS: Record<string, number> = {
  getProgramAccounts: 260,
  getTokenLargestAccounts: 220,
  getSignaturesForAddress: 60,
  getTransaction: 40,
  getTokenAccountsByOwner: 40,
};

async function serve(chain: MockChain) {
  const recent: number[] = [];
  const stats = { requests: 0, rateLimited: 0, byMethod: new Map<string, number>() };
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const now = Date.now();
      while (recent.length && now - recent[0]! >= 1_000) recent.shift();
      const calls = [JSON.parse(body)].flat() as Array<{ id: number; method: string; params?: unknown[] }>;
      // Limite de débit : chaque appel d'un lot compte (comme chez Helius).
      if (recent.length + calls.length > SERVER_RPS) {
        stats.rateLimited++;
        setTimeout(() => {
          res.statusCode = 429;
          res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: 429, message: 'Too many requests' } }));
        }, RTT / 2);
        return;
      }
      for (const _ of calls) recent.push(now);
      const answers = calls.map((call) => {
        stats.requests++;
        stats.byMethod.set(call.method, (stats.byMethod.get(call.method) ?? 0) + 1);
        try {
          return { jsonrpc: '2.0', id: call.id, result: chain.handle(call.method, call.params ?? []) };
        } catch (error) {
          return { jsonrpc: '2.0', id: call.id, error: { code: -32601, message: (error as Error).message } };
        }
      });
      // Coût serveur : par méthode, plus la taille de la réponse (1000 signatures : ~0,4 s de plus).
      const size = (a: { result?: unknown }) => (Array.isArray(a.result) ? a.result.length : 0);
      const delay = RTT + Math.max(...calls.map((c, i) => (SERVER_MS[c.method] ?? 10) + 0.4 * size(answers[i]!)));
      setTimeout(() => {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(Array.isArray(JSON.parse(body)) ? answers : answers[0]));
      }, delay);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, server, stats };
}

const SCENARIOS: Array<[string, () => { chain: MockChain; mint: { toBase58(): string } }]> = [
  ['pump.fun, bonding curve active', buildHealthyChain],
  ['pump.fun migré (PumpSwap)', buildRugChain],
  ['Raydium AMM v4', buildRaydiumChain],
  ['rug du dev, wallet spammé, 2100 trades', () => buildDevRugChain({ spam: 80, trades: 2_100 })],
];

const median = (v: number[]) => [...v].sort((a, b) => a - b)[Math.floor(v.length / 2)]!;

console.log(`RTT ${RTT} ms · serveur ${SERVER_RPS} req/s · client ${CLIENT.concurrency} en parallèle, ${CLIENT.maxRps} req/s · ${RUNS} essais\n`);
for (const [name, build] of SCENARIOS) {
  const { chain, mint } = build();
  const { url, server, stats } = await serve(chain);
  const totals: number[] = [];
  const partials: number[] = [];
  const rescans: number[] = [];
  const steps = new Map<string, number[]>();
  let requests = 0;
  for (let run = 0; run < RUNS; run++) {
    // Pause entre deux essais : la fenêtre de débit du serveur se vide.
    await new Promise((r) => setTimeout(r, 1_100));
    const rpc = new RpcClient({ url, concurrency: CLIENT.concurrency, maxRetries: 4, maxRps: CLIENT.maxRps });
    const started = Date.now();
    const cache = memoryCache();
    const scanConfig = { rpcUrl: url, concurrency: CLIENT.concurrency, maxRetries: 4, ...EXTENSION_SCAN, holderCensus: true };
    const result = await scanToken(mint.toBase58(), scanConfig, {
      rpc,
      cache,
      onProgress: (step) => steps.set(step, [...(steps.get(step) ?? []), Date.now() - started]),
      onPartial: () => partials.push(Date.now() - started),
    });
    totals.push(Date.now() - started);
    requests = result.rpcRequests;
    // Actualisation (bouton ↻) juste après : transactions du dev et wallets déjà en cache.
    await new Promise((r) => setTimeout(r, 1_100));
    const again = Date.now();
    await scanToken(mint.toBase58(), scanConfig, { rpc, cache });
    rescans.push(Date.now() - again);
  }
  console.log(`■ ${name} : note provisoire à ${partials.length ? `${median(partials)} ms` : '–'} · note définitive à ${median(totals)} ms (min ${Math.min(...totals)}, max ${Math.max(...totals)}) · ${requests} requêtes · ${stats.rateLimited} refus 429 · actualisation ${median(rescans)} ms`);
  for (const [step, times] of steps) console.log(`    ${step.padEnd(36)} prêt à ${median(times)} ms`);
  console.log(`    méthodes : ${[...stats.byMethod].map(([m, n]) => `${m} ${Math.round(n / RUNS)}`).join(', ')}\n`);
  server.close();
}
