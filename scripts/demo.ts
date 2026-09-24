/**
 * Démo hors-ligne : lance le scanner complet contre un nœud RPC simulé
 * (scénarios de test) pour visualiser le rapport sans endpoint Solana.
 *
 *   npm run demo            # scénario "rug" (wallets clonés)
 *   npm run demo -- healthy # bonding curve saine
 *   npm run demo -- raydium # pool Raydium + mint authority active
 */
import '../src/utils/quiet-warnings.js';
import { renderReport } from '../src/report/console.js';
import { scanToken } from '../src/scanner.js';
import { SCENARIOS } from '../test/fixtures/scenarios.js';
import { startMockRpc } from '../test/fixtures/mock-rpc.js';

const name = (process.argv[2] ?? 'rug') as keyof typeof SCENARIOS;
const build = SCENARIOS[name];
if (!build) {
  console.error(`Scénario inconnu : ${name} (disponibles : ${Object.keys(SCENARIOS).join(', ')})`);
  process.exit(1);
}

const { chain, mint } = build();
const { url, server } = await startMockRpc(chain);
try {
  const result = await scanToken(mint.toBase58(), {
    rpcUrl: url,
    concurrency: 8,
    maxRetries: 0,
    creatorTxScanLimit: 150,
    mintHistoryMaxPages: 3,
    holderCensus: true,
  });
  console.log(renderReport(result));
} finally {
  server.close();
}
