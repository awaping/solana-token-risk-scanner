/**
 * Orchestrateur : enchaîne les analyseurs (en parallèle quand c'est possible),
 * isole les échecs de chaque module et calcule le score global.
 *
 *   token ──┬── holders ──┬── clustering
 *           ├── dusting   │
 *           └── reserve ──┴── créateur (identité puis historique)
 */
import { PublicKey } from '@solana/web3.js';
import type { ScannerConfig } from './config.js';
import { maskRpcUrl } from './config.js';
import { RpcClient } from './rpc/client.js';
import { analyzeClustering } from './analyzers/clustering.js';
import { analyzeCreator, resolveCreator } from './analyzers/creator.js';
import { analyzeDusting } from './analyzers/dusting.js';
import { analyzeHolders } from './analyzers/holders.js';
import { analyzeReserve } from './analyzers/reserve.js';
import { analyzeToken } from './analyzers/token.js';
import { computeRiskScore } from './scoring/engine.js';
import type { ModuleOutcome, ScanResult } from './types.js';

export type ProgressCallback = (step: string, durationMs: number, ok: boolean) => void;

/** Traduit les erreurs RPC fréquentes en message exploitable. */
export function describeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/secondary ind(ex|ices)/i.test(message)) {
    return 'getProgramAccounts refusé par ce RPC (index secondaire désactivé) — utilisez un RPC dédié';
  }
  if (/429|too many requests|rate limit/i.test(message)) {
    return 'RPC saturé (erreur 429) — utilisez un RPC dédié ou baissez RPC_CONCURRENCY';
  }
  if (/method not found|not supported|disabled|-32601/i.test(message)) {
    return `méthode RPC non supportée par cet endpoint (${message.slice(0, 120)})`;
  }
  if (/timed? ?out|timeout/i.test(message)) return 'délai dépassé : requête trop lourde pour ce RPC';
  return message.length > 200 ? `${message.slice(0, 200)}…` : message;
}

async function settle<T>(promise: Promise<T>): Promise<ModuleOutcome<T>> {
  try {
    return { status: 'ok', data: await promise };
  } catch (error) {
    return { status: 'unavailable', reason: describeError(error) };
  }
}

/** Mesure la durée d'une étape et la signale au callback de progression. */
function track<T>(step: string, outcome: Promise<ModuleOutcome<T>>, onProgress?: ProgressCallback) {
  const started = Date.now();
  return outcome.then((result) => {
    onProgress?.(step, Date.now() - started, result.status === 'ok');
    return result;
  });
}

export function parseMint(address: string): PublicKey {
  try {
    return new PublicKey(address.trim());
  } catch {
    throw new Error(`Adresse de mint invalide : "${address}"`);
  }
}

export async function scanToken(
  mintAddress: string,
  config: ScannerConfig,
  options: { rpc?: RpcClient; onProgress?: ProgressCallback } = {},
): Promise<ScanResult> {
  const started = Date.now();
  const mint = parseMint(mintAddress);
  const rpc =
    options.rpc ?? new RpcClient({ url: config.rpcUrl, concurrency: config.concurrency, maxRetries: config.maxRetries });
  const { onProgress } = options;
  const requestsBefore = rpc.requestCount;

  // Le mint est indispensable : une erreur ici interrompt l'analyse.
  const tokenStarted = Date.now();
  const token = await analyzeToken(rpc, mint);
  onProgress?.('Mint & autorités', Date.now() - tokenStarted, true);

  const holdersP = track('Top 20 holders', settle(analyzeHolders(rpc, token)), onProgress);

  const dustingP: Promise<ModuleOutcome<Awaited<ReturnType<typeof analyzeDusting>>>> = config.holderCensus
    ? track('Recensement des holders (dusting)', settle(analyzeDusting(rpc, token)), onProgress)
    : Promise.resolve({ status: 'unavailable', reason: 'recensement désactivé (--no-census / HOLDER_CENSUS=false)' });

  const reserveP = track(
    'Réserve & liquidité',
    settle(
      analyzeReserve(rpc, token, async () => {
        const holders = await holdersP;
        return holders.status === 'ok' ? holders.data : null;
      }),
    ),
    onProgress,
  );

  const creatorP = track(
    'Historique du créateur',
    settle(
      (async () => {
        const reserve = await reserveP;
        const identity = await resolveCreator(rpc, config, token, reserve.status === 'ok' ? reserve.data : null);
        if (!identity) {
          throw new Error('créateur introuvable (historique du mint trop long) — précisez-le avec --creator <adresse>');
        }
        return analyzeCreator(rpc, config, token, identity);
      })(),
    ),
    onProgress,
  );

  const [holders, dusting, reserve, creator] = await Promise.all([holdersP, dustingP, reserveP, creatorP]);

  // Signale le créateur dans le classement des holders.
  if (holders.status === 'ok' && creator.status === 'ok') {
    for (const holder of holders.data.top) {
      if (holder.owner === creator.data.address && (holder.kind === 'wallet' || holder.kind === 'program')) {
        holder.kind = 'creator';
        holder.label = 'Créateur';
      }
    }
  }

  const clustering: ScanResult['clustering'] =
    holders.status === 'ok'
      ? { status: 'ok', data: analyzeClustering(holders.data.wallets) }
      : { status: 'unavailable', reason: 'dépend du module holders (indisponible)' };

  const risk = computeRiskScore({ token, holders, clustering, dusting, reserve, creator });

  return {
    mint: token.mint,
    generatedAt: new Date(),
    durationMs: Date.now() - started,
    rpcEndpoint: maskRpcUrl(rpc.url),
    rpcRequests: rpc.requestCount - requestsBefore,
    token,
    holders,
    clustering,
    dusting,
    reserve,
    creator,
    risk,
  };
}
