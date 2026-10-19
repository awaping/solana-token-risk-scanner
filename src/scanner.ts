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
import type { ScanCache } from './cache.js';
import { analyzeCreator, findMintOrigin, resolveCreator, type CreatorIdentity, type MintOrigin } from './analyzers/creator.js';
import { dustingFromCensus, fetchCensus, type CensusAccount } from './analyzers/dusting.js';
import { analyzeFreshWallets } from './analyzers/fresh.js';
import { analyzeHolders, holdersFromCensus } from './analyzers/holders.js';
import { decodeBondingCurve } from './analyzers/pumpfun.js';
import { analyzeReserve } from './analyzers/reserve.js';
import { resolveMintFromAccount } from './analyzers/resolve.js';
import { loadToken, NotAMintError } from './analyzers/token.js';
import { computeRiskScore } from './scoring/engine.js';
import { PUMP_FUN_PROGRAM_ID } from './constants.js';
import type { CreatorAnalysis, DustingAnalysis, FreshWalletsAnalysis, HoldersAnalysis, ModuleOutcome, ReserveAnalysis, ScanResult, TokenAge } from './types.js';

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

export interface ScanOptions {
  rpc?: RpcClient;
  onProgress?: ProgressCallback;
  /**
   * Résultat provisoire, émis dès que holders, dusting et réserve sont connus,
   * quand l'historique du dev et les wallets frais sont encore en cours
   * (`result.pending`). Permet d'afficher une note en une fraction du temps.
   */
  onPartial?: (result: ScanResult) => void;
  /** Cache des transactions de créateurs et de l'activité des wallets. */
  cache?: ScanCache;
}

/** Délai après lequel les holders sont aussi demandés par getTokenLargestAccounts si le recensement tarde. */
const CENSUS_HEDGE_MS = 1_500;

/**
 * Premier résultat entre `primary` et un relais lancé après `delayMs`, ou dès
 * l'échec de `primary`. Échoue seulement si les deux échouent.
 */
export function hedge<T>(primary: Promise<T>, fallback: () => Promise<T>, delayMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let done = false;
    let failures = 0;
    let fallbackStarted = false;
    const win = (value: T) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(value);
    };
    const lose = (error: unknown) => {
      failures++;
      if (!done && failures === 2) reject(error);
      else startFallback();
    };
    const startFallback = () => {
      if (fallbackStarted || done) return;
      fallbackStarted = true;
      fallback().then(win, lose);
    };
    const timer = setTimeout(startFallback, delayMs);
    primary.then(win, lose);
  });
}

const unavailable = (reason: string) => ({ status: 'unavailable' as const, reason });

export async function scanToken(mintAddress: string, config: ScannerConfig, options: ScanOptions = {}): Promise<ScanResult> {
  const started = Date.now();
  const mint = parseMint(mintAddress);
  const rpc =
    options.rpc ?? new RpcClient({ url: config.rpcUrl, concurrency: config.concurrency, maxRetries: config.maxRetries });
  const { onProgress, cache } = options;
  const requestsBefore = rpc.requestCount;
  // Requêtes secondaires (historique du dev, wallets frais, âge) : après celles qui donnent la note provisoire.
  const later = rpc.secondary();

  // 1. Mint, métadonnées, bonding curve et pool PumpSwap : une seule requête. Si
  // l'adresse est une bonding curve, une pool ou un compte de token, on remonte au mint.
  const tokenStarted = Date.now();
  let resolvedFrom: ScanResult['resolvedFrom'];
  let loaded: Awaited<ReturnType<typeof loadToken>>;
  try {
    loaded = await loadToken(rpc, mint);
  } catch (error) {
    if (!(error instanceof NotAMintError)) throw error;
    const resolved = await resolveMintFromAccount(rpc, error.address, error.account);
    loaded = await loadToken(rpc, resolved.mint);
    resolvedFrom = { address: mint.toBase58(), kind: resolved.from };
  }
  const { token, markets } = loaded;
  const mintKey = new PublicKey(token.mint);
  onProgress?.('Mint & autorités', Date.now() - tokenStarted, true);

  // Créateur inscrit dans la bonding curve : connu dès maintenant.
  const curveInfo = markets.bondingCurve.info;
  const curve = curveInfo?.owner.equals(PUMP_FUN_PROGRAM_ID)
    ? decodeBondingCurve(markets.bondingCurve.address, curveInfo.data, BigInt(curveInfo.lamports))
    : null;
  const earlyCreator: CreatorIdentity | null = config.creatorOverride
    ? { address: config.creatorOverride, source: 'override' }
    : curve?.creator
      ? { address: curve.creator, source: 'pump.fun bonding curve' }
      : null;

  // Historique du mint, lu une seule fois : il date la création du token et, au
  // besoin, désigne son créateur. Un token de quelques minutes tient en une requête.
  let originP: Promise<MintOrigin> | undefined;
  const origin = () => (originP ??= findMintOrigin(later, mintKey, Math.max(1, config.mintHistoryMaxPages)));
  const ageP: Promise<TokenAge | undefined> = origin()
    .then(({ oldest, complete, count }) => (oldest?.blockTime ? { createdAt: new Date(oldest.blockTime * 1000), exact: complete, transactions: count } : undefined))
    .catch(() => undefined);

  // 2. Recensement de tous les comptes du token : sert au dusting ET au top holders.
  const censusP: Promise<ModuleOutcome<CensusAccount[]>> = config.holderCensus
    ? settle(fetchCensus(rpc, token))
    : Promise.resolve(unavailable('recensement désactivé (--no-census / HOLDER_CENSUS=false)'));
  const dustingP = track(
    'Recensement des holders (dusting)',
    censusP.then((census): ModuleOutcome<DustingAnalysis> => (census.status === 'ok' ? { status: 'ok', data: dustingFromCensus(census.data, token.supply) } : census)),
    onProgress,
  );

  // 3. Holders depuis le recensement ; getTokenLargestAccounts en relais s'il échoue ou tarde.
  const holdersP = track(
    'Top 20 holders',
    settle(
      config.holderCensus
        ? hedge(
            censusP.then((census) => (census.status === 'ok' ? holdersFromCensus(rpc, token, census.data) : Promise.reject(new Error(census.reason)))),
            () => analyzeHolders(rpc, token),
            CENSUS_HEDGE_MS,
          )
        : analyzeHolders(rpc, token),
    ),
    onProgress,
  );

  // 4. Réserve : bonding curve et pool canonique déjà lues.
  const reserveP = track(
    'Réserve & liquidité',
    settle(
      analyzeReserve(
        rpc,
        token,
        async () => {
          const holders = await holdersP;
          return holders.status === 'ok' ? holders.data : null;
        },
        markets,
      ),
    ),
    onProgress,
  );

  // 5. Créateur : démarre tout de suite quand la bonding curve le nomme.
  const creatorP = track(
    'Historique du créateur',
    settle(
      (async () => {
        const reserve = earlyCreator ? null : await reserveP;
        const identity =
          earlyCreator ?? (await resolveCreator(later, config, token, reserve?.status === 'ok' ? reserve.data : null, origin));
        if (!identity) {
          throw new Error('créateur introuvable (historique du mint trop long) — précisez-le avec --creator <adresse>');
        }
        // Tokens encore détenus par le créateur : lus dans le recensement s'il a réussi.
        const owner = new PublicKey(identity.address).toBuffer();
        const holding = censusP.then((census) =>
          census.status === 'ok' ? census.data.reduce((sum, a) => (a.owner.equals(owner) ? sum + a.amount : sum), 0n) : null,
        );
        return analyzeCreator(later, config, token, identity, { holding, ...(cache ? { cache } : {}) });
      })(),
    ),
    onProgress,
  );

  // 6. Wallets frais parmi les plus gros holders.
  const freshP = track(
    'Wallets frais',
    holdersP.then((holders) =>
      holders.status === 'ok'
        ? settle(analyzeFreshWallets(later, holders.data, { ...(earlyCreator ? { creator: earlyCreator.address } : {}), ...(cache ? { cache } : {}) }))
        : unavailable('dépend du module holders (indisponible)'),
    ),
    onProgress,
  );

  const build = (parts: {
    holders: ModuleOutcome<HoldersAnalysis>;
    dusting: ModuleOutcome<DustingAnalysis>;
    reserve: ModuleOutcome<ReserveAnalysis>;
    creator: ModuleOutcome<CreatorAnalysis>;
    fresh?: ModuleOutcome<FreshWalletsAnalysis>;
    tokenAge?: TokenAge;
    pending?: Array<'creator' | 'fresh'>;
  }): ScanResult => {
    const { holders, dusting, reserve, creator, fresh, tokenAge, pending } = parts;
    // Signale le créateur dans le classement des holders.
    const creatorAddress = creator.status === 'ok' ? creator.data.address : earlyCreator?.address;
    if (holders.status === 'ok' && creatorAddress) {
      for (const holder of holders.data.top) {
        if (holder.owner === creatorAddress && (holder.kind === 'wallet' || holder.kind === 'program')) {
          holder.kind = 'creator';
          holder.label = 'Créateur';
        }
      }
    }
    const clustering: ScanResult['clustering'] =
      holders.status === 'ok' ? { status: 'ok', data: analyzeClustering(holders.data.wallets) } : unavailable('dépend du module holders (indisponible)');
    const risk = computeRiskScore({ token, holders, clustering, ...(fresh ? { fresh } : {}), dusting, reserve, creator });
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
      ...(fresh ? { fresh } : {}),
      dusting,
      reserve,
      creator,
      risk,
      ...(pending?.length ? { pending } : {}),
      ...(pending?.length && earlyCreator ? { earlyCreator: earlyCreator.address } : {}),
    };
  };

  // Note provisoire dès que holders, dusting et réserve sont là.
  let finished = false;
  let creatorDone = false;
  let freshDone = false;
  void creatorP.then(() => (creatorDone = true));
  void freshP.then(() => (freshDone = true));
  if (options.onPartial) {
    void Promise.all([holdersP, dustingP, reserveP, ageP]).then(([holders, dusting, reserve, tokenAge]) => {
      const pending = [...(creatorDone ? [] : ['creator' as const]), ...(freshDone ? [] : ['fresh' as const])];
      if (finished || pending.length === 0) return;
      try {
        options.onPartial!(build({ holders, dusting, reserve, creator: unavailable('analyse en cours'), ...(tokenAge ? { tokenAge } : {}), pending }));
      } catch {
        // un affichage provisoire raté ne doit jamais faire échouer l'analyse
      }
    });
  }

  const [holders, dusting, reserve, creator, fresh, tokenAge] = await Promise.all([holdersP, dustingP, reserveP, creatorP, freshP, ageP]);
  finished = true;
  return build({ holders, dusting, reserve, creator, fresh, ...(tokenAge ? { tokenAge } : {}) });
}
