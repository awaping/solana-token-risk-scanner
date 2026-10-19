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
import { analyzeCreator, findMintOrigin, resolveCreator, type MintOrigin } from './analyzers/creator.js';
import { analyzeDusting } from './analyzers/dusting.js';
import { analyzeHolders } from './analyzers/holders.js';
import { analyzeReserve } from './analyzers/reserve.js';
import { resolveMintFromAccount } from './analyzers/resolve.js';
import { analyzeToken, NotAMintError } from './analyzers/token.js';
import { computeRiskScore } from './scoring/engine.js';
import type { ModuleOutcome, ScanResult, TokenAge } from './types.js';

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

const BASE58_ADDRESS = /[1-9A-HJ-NP-Za-km-z]{32,44}/g;

/**
 * Lit une adresse Solana. Accepte aussi un lien copié depuis un explorateur ou
 * un agrégateur (pump.fun/coin/…, dexscreener.com/solana/…, solscan.io/token/…) :
 * la dernière adresse du lien est retenue.
 */
export function parseMint(address: string): PublicKey {
  const input = address.trim();
  const candidate = /[/?=]/.test(input) ? (input.match(BASE58_ADDRESS)?.at(-1) ?? input) : input;
  try {
    return new PublicKey(candidate);
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

  // Le mint est indispensable : une erreur ici interrompt l'analyse. Si l'adresse
  // est une bonding curve, une pool ou un compte de token, on remonte jusqu'au mint.
  const tokenStarted = Date.now();
  let resolvedFrom: ScanResult['resolvedFrom'];
  let token: Awaited<ReturnType<typeof analyzeToken>>;
  try {
    token = await analyzeToken(rpc, mint);
  } catch (error) {
    if (!(error instanceof NotAMintError)) throw error;
    const resolved = await resolveMintFromAccount(rpc, error.address, error.account);
    token = await analyzeToken(rpc, resolved.mint);
    resolvedFrom = { address: mint.toBase58(), kind: resolved.from };
  }
  onProgress?.('Mint & autorités', Date.now() - tokenStarted, true);

  // Historique du mint, lu une seule fois : il date la création du token et, au
  // besoin, désigne son créateur. Un token de quelques minutes tient en une requête.
  let originP: Promise<MintOrigin> | undefined;
  const origin = () => (originP ??= findMintOrigin(rpc, new PublicKey(token.mint), Math.max(1, config.mintHistoryMaxPages)));
  const ageP: Promise<TokenAge | undefined> = origin()
    .then(({ oldest, complete, count }) => (oldest?.blockTime ? { createdAt: new Date(oldest.blockTime * 1000), exact: complete, transactions: count } : undefined))
    .catch(() => undefined);

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
        const identity = await resolveCreator(rpc, config, token, reserve.status === 'ok' ? reserve.data : null, origin);
        if (!identity) {
          throw new Error('créateur introuvable (historique du mint trop long) — précisez-le avec --creator <adresse>');
        }
        return analyzeCreator(rpc, config, token, identity);
      })(),
    ),
    onProgress,
  );

  const [holders, dusting, reserve, creator, tokenAge] = await Promise.all([holdersP, dustingP, reserveP, creatorP, ageP]);

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
    ...(resolvedFrom ? { resolvedFrom } : {}),
    generatedAt: new Date(),
    durationMs: Date.now() - started,
    rpcEndpoint: maskRpcUrl(rpc.url),
    rpcRequests: rpc.requestCount - requestsBefore,
    token,
    ...(tokenAge ? { tokenAge } : {}),
    holders,
    clustering,
    dusting,
    reserve,
    creator,
    risk,
  };
}
