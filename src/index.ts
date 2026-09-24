#!/usr/bin/env node
/**
 * Point d'entrée CLI.
 *
 *   npm run scan -- <MINT_ADDRESS> [options]
 *   npx tsx src/index.ts <MINT_ADDRESS> --json
 */
import './utils/quiet-warnings.js';
import { parseArgs } from 'node:util';
import { configFromEnv, loadDotEnv, type ScannerConfig } from './config.js';
import { renderJson, renderReport } from './report/console.js';
import { RpcClient } from './rpc/client.js';
import { parseMint, scanToken, type ProgressCallback } from './scanner.js';
import type { RiskLevel, ScanResult } from './types.js';
import { c, fmtNum, setColorEnabled } from './utils/format.js';

const VERSION = '1.0.0';

const help = () => `
${c.bold('Solana Token Risk Scanner')} — diagnostic de sécurité on-chain d'un token SPL

${c.bold('Usage')}
  npm run scan -- <MINT_ADDRESS> [options]
  sol-risk <MINT_ADDRESS> [options]            (après npm run build && npm link)

${c.bold('Options')}
  --rpc <url>           Endpoint RPC (défaut : $SOLANA_RPC_URL ou mainnet-beta public)
  --creator <adresse>   Force l'adresse du créateur (sinon détection automatique)
  --tx-limit <n>        Transactions du créateur inspectées (défaut : $CREATOR_TX_SCAN_LIMIT ou 100)
  --no-census           Désactive le recensement complet des holders (dusting check)
  --watch <secondes>    Relance l'analyse en continu (minimum 15 s)
  --fail-on <niveau>    Code de sortie 2 si le niveau atteint "orange" ou "rouge"
  --json                Sortie JSON (pour scripts / bots)
  --no-color            Désactive les couleurs
  -h, --help            Affiche cette aide
  -v, --version         Affiche la version

${c.bold('Exemples')}
  npm run scan -- 7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr
  npm run scan -- <MINT> --rpc https://mainnet.helius-rpc.com/?api-key=XXX --json
  npm run scan -- <MINT> --watch 60 --fail-on rouge
`;

const LEVEL_RANK: Record<RiskLevel, number> = { VERT: 0, ORANGE: 1, ROUGE: 2 };

function parseLevel(value: string | undefined): RiskLevel | undefined {
  if (!value) return undefined;
  const normalized = value.trim().toUpperCase();
  const map: Record<string, RiskLevel> = { ORANGE: 'ORANGE', ROUGE: 'ROUGE', RED: 'ROUGE', VERT: 'VERT', GREEN: 'VERT' };
  const level = map[normalized];
  if (!level) throw new Error(`--fail-on invalide : "${value}" (orange | rouge)`);
  return level;
}

function positiveInt(value: string | undefined, flag: string, min = 0): number | undefined {
  if (value === undefined) return undefined;
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || n < min) throw new Error(`${flag} invalide : "${value}" (entier >= ${min} attendu)`);
  return n;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function main(): Promise<number> {
  loadDotEnv();

  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      rpc: { type: 'string' },
      creator: { type: 'string' },
      'tx-limit': { type: 'string' },
      'no-census': { type: 'boolean', default: false },
      watch: { type: 'string' },
      'fail-on': { type: 'string' },
      json: { type: 'boolean', default: false },
      'no-color': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
      version: { type: 'boolean', short: 'v', default: false },
    },
  });

  if (values['no-color'] || values.json) setColorEnabled(false);
  if (values.version) {
    console.log(VERSION);
    return 0;
  }
  const mintArg = positionals[0];
  if (values.help || !mintArg) {
    console.log(help());
    return values.help ? 0 : 1;
  }

  const config: ScannerConfig = configFromEnv();
  if (values.rpc) config.rpcUrl = values.rpc;
  if (values.creator) config.creatorOverride = parseMint(values.creator).toBase58();
  if (values['no-census']) config.holderCensus = false;
  const txLimit = positiveInt(values['tx-limit'], '--tx-limit');
  if (txLimit !== undefined) config.creatorTxScanLimit = txLimit;
  const watchSeconds = positiveInt(values.watch, '--watch', 15);
  const failOn = parseLevel(values['fail-on']);

  const mint = parseMint(mintArg).toBase58();
  const rpc = new RpcClient({ url: config.rpcUrl, concurrency: config.concurrency, maxRetries: config.maxRetries });

  // Progression sur stderr (n'interfère pas avec la sortie JSON sur stdout).
  const showProgress = !values.json && process.stderr.isTTY;
  const onProgress: ProgressCallback | undefined = showProgress
    ? (step, ms, ok) =>
        process.stderr.write(`  ${ok ? c.green('✔') : c.yellow('○')} ${step} ${c.gray(`(${fmtNum(ms / 1000, 1)} s)`)}\n`)
    : undefined;

  let previous: ScanResult | undefined;
  for (;;) {
    if (showProgress) process.stderr.write(c.gray(`\nAnalyse de ${mint}…\n`));
    let result: ScanResult;
    try {
      result = await scanToken(mint, config, { rpc, onProgress });
    } catch (error) {
      // En mode watch, une erreur réseau ponctuelle ne doit pas arrêter la surveillance.
      if (!watchSeconds) throw error;
      console.error(c.red(`Erreur : ${error instanceof Error ? error.message : String(error)}`));
      await sleep(watchSeconds * 1000);
      continue;
    }

    if (values.json) {
      console.log(renderJson(result));
    } else {
      console.log(renderReport(result));
      if (previous) {
        const delta = result.risk.score - previous.risk.score;
        const sign = delta > 0 ? c.red(`+${delta}`) : delta < 0 ? c.green(String(delta)) : c.gray('±0');
        console.log(`  Évolution depuis le scan précédent : ${sign} point(s)\n`);
      }
    }

    if (!watchSeconds) {
      return failOn && LEVEL_RANK[result.risk.level] >= LEVEL_RANK[failOn] ? 2 : 0;
    }
    previous = result;
    if (showProgress) process.stderr.write(c.gray(`Prochaine analyse dans ${watchSeconds} s (Ctrl+C pour quitter)\n`));
    await sleep(watchSeconds * 1000);
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    console.error(c.red(`Erreur : ${error instanceof Error ? error.message : String(error)}`));
    process.exitCode = 1;
  });
