/**
 * Module "Traçabilité du créateur".
 *
 * 1. Identification du déployeur : option --creator, champ `creator` de la
 *    bonding curve Pump.fun, sinon signataire de la toute première
 *    transaction du mint (pagination de getSignaturesForAddress), sinon
 *    mint authority.
 * 2. Historique : solde SOL restant, part du token encore détenue, âge et
 *    activité du wallet, et nombre de tokens déployés (instructions
 *    InitializeMint / InitializeMint2 signées par le créateur).
 */
import {
  PublicKey,
  type ConfirmedSignatureInfo,
  type ParsedInstruction,
  type ParsedTransactionWithMeta,
  type PartiallyDecodedInstruction,
} from '@solana/web3.js';
import { unpackAccount } from '@solana/spl-token';
import type { ScanCache } from '../cache.js';
import type { ScannerConfig } from '../config.js';
import type { RpcClient } from '../rpc/client.js';
import type { CreatorAnalysis, ReserveAnalysis, TokenInfo } from '../types.js';
import { lamportsToSol, percentOf } from '../utils/math.js';

const PAGE_SIZE = 1000;
const MINT_INIT_TYPES = new Set(['initializeMint', 'initializeMint2']);
const TOKEN_PROGRAM_NAMES = new Set(['spl-token', 'spl-token-2022']);

export interface CreatorIdentity {
  address: string;
  source: CreatorAnalysis['source'];
}

/** Récupère jusqu'à `limit` signatures d'une adresse, des plus récentes aux plus anciennes. */
async function fetchSignatures(rpc: RpcClient, address: PublicKey, limit: number): Promise<ConfirmedSignatureInfo[]> {
  const all: ConfirmedSignatureInfo[] = [];
  let before: string | undefined;
  while (all.length < limit) {
    const pageLimit = Math.min(PAGE_SIZE, limit - all.length);
    const page = await rpc.call((c) => c.getSignaturesForAddress(address, { limit: pageLimit, before }));
    all.push(...page);
    if (page.length < pageLimit) break;
    before = page[page.length - 1]!.signature;
  }
  return all;
}

/** Début de l'historique d'un mint : sa transaction de création, et donc sa date de naissance. */
export interface MintOrigin {
  /** Plus ancienne transaction réussie trouvée. */
  oldest?: { signature: string; blockTime?: number };
  /** true : le début de l'historique a été atteint (`oldest` est la création du mint). */
  complete: boolean;
  /** Transactions vues (borne basse si l'historique n'a pas été lu jusqu'au bout). */
  count: number;
}

/**
 * Remonte l'historique du mint jusqu'à sa plus ancienne signature (dans la
 * limite de `maxPages` pages de 1000). Un token de quelques minutes tient en
 * une seule requête ; au-delà de la limite, `oldest` n'est qu'une borne.
 */
export async function findMintOrigin(rpc: RpcClient, mint: PublicKey, maxPages: number): Promise<MintOrigin> {
  let before: string | undefined;
  let oldest: MintOrigin['oldest'];
  let count = 0;
  for (let page = 0; page < maxPages; page++) {
    const signatures = await rpc.call((c) => c.getSignaturesForAddress(mint, { limit: PAGE_SIZE, before }));
    count += signatures.length;
    const ok = [...signatures].reverse().find((s) => s.err === null);
    if (ok) oldest = { signature: ok.signature, ...(ok.blockTime ? { blockTime: ok.blockTime } : {}) };
    if (signatures.length < PAGE_SIZE) return { ...(oldest ? { oldest } : {}), complete: true, count };
    before = signatures[signatures.length - 1]!.signature;
  }
  return { ...(oldest ? { oldest } : {}), complete: false, count };
}

/**
 * Retrouve la transaction de création du mint en remontant l'historique
 * jusqu'à la plus ancienne signature (dans la limite de `maxPages` pages).
 */
async function findMintCreator(rpc: RpcClient, origin: Promise<MintOrigin>): Promise<string | null> {
  const { oldest, complete } = await origin;
  // Historique trop long pour être parcouru : la plus ancienne transaction vue n'est pas la création.
  if (!complete || !oldest) return null;
  const tx = await rpc.call((c) => c.getParsedTransaction(oldest.signature, { maxSupportedTransactionVersion: 0 }));
  const feePayer = tx?.transaction.message.accountKeys.find((k) => k.signer);
  return feePayer?.pubkey.toBase58() ?? null;
}

/** Détermine l'adresse du créateur par ordre de fiabilité décroissante. */
export async function resolveCreator(
  rpc: RpcClient,
  config: ScannerConfig,
  token: TokenInfo,
  reserve: ReserveAnalysis | null,
  origin?: () => Promise<MintOrigin>,
): Promise<CreatorIdentity | null> {
  if (config.creatorOverride) return { address: config.creatorOverride, source: 'override' };
  if (reserve?.bondingCurve?.creator) return { address: reserve.bondingCurve.creator, source: 'pump.fun bonding curve' };

  if (config.mintHistoryMaxPages > 0) {
    const fromHistory = await findMintCreator(rpc, origin ? origin() : findMintOrigin(rpc, new PublicKey(token.mint), config.mintHistoryMaxPages));
    if (fromHistory) return { address: fromHistory, source: 'mint creation tx' };
  }
  if (token.mintAuthority) return { address: token.mintAuthority, source: 'mint authority' };
  return null;
}

type AnyInstruction = ParsedInstruction | PartiallyDecodedInstruction;

/** Mints initialisés dans une transaction (instructions de premier niveau et CPI). */
export function extractInitializedMints(tx: ParsedTransactionWithMeta): string[] {
  const instructions: AnyInstruction[] = [
    ...tx.transaction.message.instructions,
    ...(tx.meta?.innerInstructions ?? []).flatMap((inner) => inner.instructions),
  ];
  const mints: string[] = [];
  for (const ix of instructions) {
    if (!('parsed' in ix) || !TOKEN_PROGRAM_NAMES.has(ix.program)) continue;
    const parsed = ix.parsed as { type?: string; info?: { mint?: string } } | undefined;
    if (parsed?.type && MINT_INIT_TYPES.has(parsed.type) && parsed.info?.mint) mints.push(parsed.info.mint);
  }
  return mints;
}

/** Historique d'un wallet : activité, âge et mints qu'il a lui-même initialisés. */
export interface CreatorHistory {
  solBalance: number;
  createdMints: string[];
  /** Tokens entrés (achat, réception) et sortis (vente, cession) du wallet, par mint, dans les transactions inspectées. */
  tokenFlows: Map<string, { in: bigint; out: bigint }>;
  txScanned: number;
  fullHistory: boolean;
  signatureCount: number;
  walletAgeDays?: number;
  oldestActivity?: Date;
}

/**
 * Parcourt les `scanLimit` dernières transactions d'un wallet et recense les
 * mints qu'il a initialisés (InitializeMint / InitializeMint2 signés par lui).
 * Partagé par le scan complet et l'enrichissement asynchrone du mode stream.
 */
/**
 * Ce qu'une transaction du créateur a fait : mints qu'il y a initialisés (`m`),
 * et variation de ses soldes de tokens par mint, en unités brutes (`d`).
 */
interface TxFacts {
  m: string[];
  d: Record<string, string>;
}
type KnownTransactions = Record<string, TxFacts>;
const CREATOR_CACHE_MS = 30 * 60_000;

/** Variation des soldes de tokens d'un wallet dans une transaction (post − pre, par mint). */
export function tokenDeltas(tx: ParsedTransactionWithMeta, owner: string): Record<string, string> {
  const sum = new Map<string, bigint>();
  for (const b of tx.meta?.preTokenBalances ?? []) if (b.owner === owner) sum.set(b.mint, (sum.get(b.mint) ?? 0n) - BigInt(b.uiTokenAmount.amount));
  for (const b of tx.meta?.postTokenBalances ?? []) if (b.owner === owner) sum.set(b.mint, (sum.get(b.mint) ?? 0n) + BigInt(b.uiTokenAmount.amount));
  return Object.fromEntries([...sum].filter(([, v]) => v !== 0n).map(([k, v]) => [k, v.toString()]));
}

export async function scanCreatorHistory(rpc: RpcClient, creator: PublicKey, scanLimit: number, cache?: ScanCache): Promise<CreatorHistory> {
  const cacheKey = `creator-tx:${creator.toBase58()}`;
  const [lamports, signatures, known = {}] = await Promise.all([
    rpc.call((c) => c.getBalance(creator)),
    // Au moins 1 signature pour estimer l'activité même si le scan est désactivé.
    fetchSignatures(rpc, creator, Math.max(scanLimit, 1)),
    cache?.get<KnownTransactions>(cacheKey),
  ]);

  const created = new Set<string>();
  const tokenFlows = new Map<string, { in: bigint; out: bigint }>();
  const owner = creator.toBase58();
  const toScan = scanLimit > 0 ? signatures.filter((s) => s.err === null).slice(0, scanLimit) : [];
  const seen: KnownTransactions = {};
  // Transactions déjà lues lors d'une analyse précédente (même dev, ↻, suivi) : pas relues.
  await Promise.all(
    toScan.map(async ({ signature }) => {
      const cached = known[signature];
      let facts = cached && !Array.isArray(cached) ? cached : undefined;
      if (!facts) {
        const tx = await rpc
          .call((c) => c.getParsedTransaction(signature, { maxSupportedTransactionVersion: 0 }))
          .catch(() => null);
        if (!tx) return;
        const signedByCreator = tx.transaction.message.accountKeys.some((k) => k.signer && k.pubkey.equals(creator));
        facts = { m: signedByCreator ? extractInitializedMints(tx) : [], d: tokenDeltas(tx, owner) };
      }
      seen[signature] = facts;
      for (const m of facts.m) created.add(m);
      for (const [mint, raw] of Object.entries(facts.d)) {
        const delta = BigInt(raw);
        const flow = tokenFlows.get(mint) ?? { in: 0n, out: 0n };
        if (delta > 0n) flow.in += delta;
        else flow.out -= delta;
        tokenFlows.set(mint, flow);
      }
    }),
  );
  const txScanned = Object.keys(seen).length;
  if (cache && txScanned > 0) await cache.set(cacheKey, seen, CREATOR_CACHE_MS);

  const fullHistory = signatures.length < Math.max(scanLimit, 1);
  const oldest = signatures[signatures.length - 1];
  const oldestActivity = oldest?.blockTime ? new Date(oldest.blockTime * 1000) : undefined;

  return {
    solBalance: lamportsToSol(BigInt(lamports)),
    createdMints: [...created],
    tokenFlows,
    txScanned,
    fullHistory,
    signatureCount: signatures.length,
    walletAgeDays: fullHistory && oldestActivity ? (Date.now() - oldestActivity.getTime()) / 86_400_000 : undefined,
    oldestActivity,
  };
}

/**
 * `holding` : tokens détenus par le créateur, quand on les connaît déjà (par le
 * recensement des holders) ; sinon une requête de plus.
 */
export async function analyzeCreator(
  rpc: RpcClient,
  config: ScannerConfig,
  token: TokenInfo,
  identity: CreatorIdentity,
  options: { holding?: Promise<bigint | null>; cache?: ScanCache } = {},
): Promise<CreatorAnalysis> {
  const creator = new PublicKey(identity.address);
  const mint = new PublicKey(token.mint);

  const heldFromAccounts = async () => {
    const tokenAccounts = await rpc.call((c) => c.getTokenAccountsByOwner(creator, { mint }));
    let total = 0n;
    for (const { pubkey, account } of tokenAccounts.value) {
      try {
        total += unpackAccount(pubkey, account, account.owner).amount;
      } catch {
        // compte illisible ignoré
      }
    }
    return total;
  };
  const [history, held] = await Promise.all([
    scanCreatorHistory(rpc, creator, config.creatorTxScanLimit, options.cache),
    (options.holding ?? Promise.resolve(null)).then((known) => known ?? heldFromAccounts()),
  ]);

  const { tokenFlows, ...rest } = history;
  const flow = tokenFlows.get(token.mint);
  return {
    address: identity.address,
    source: identity.source,
    ...rest,
    ...(flow && flow.in > 0n ? { boughtPct: percentOf(flow.in, token.supply) } : {}),
    ...(flow && flow.out > 0n ? { soldPct: percentOf(flow.out, token.supply) } : {}),
    holdingPct: percentOf(held, token.supply),
    previousTokensCreated: history.createdMints.filter((m) => m !== token.mint).length,
  };
}
