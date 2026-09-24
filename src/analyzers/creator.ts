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

/**
 * Retrouve la transaction de création du mint en remontant l'historique
 * jusqu'à la plus ancienne signature (dans la limite de `maxPages` pages).
 */
async function findMintCreator(rpc: RpcClient, mint: PublicKey, maxPages: number): Promise<string | null> {
  let before: string | undefined;
  for (let page = 0; page < maxPages; page++) {
    const signatures = await rpc.call((c) => c.getSignaturesForAddress(mint, { limit: PAGE_SIZE, before }));
    if (signatures.length === 0) return null;
    if (signatures.length === PAGE_SIZE) {
      before = signatures[signatures.length - 1]!.signature;
      continue;
    }
    // Dernière page atteinte : la plus ancienne transaction réussie est la création.
    const oldest = [...signatures].reverse().find((s) => s.err === null);
    if (!oldest) return null;
    const tx = await rpc.call((c) => c.getParsedTransaction(oldest.signature, { maxSupportedTransactionVersion: 0 }));
    const feePayer = tx?.transaction.message.accountKeys.find((k) => k.signer);
    return feePayer?.pubkey.toBase58() ?? null;
  }
  return null; // historique trop long pour être parcouru
}

/** Détermine l'adresse du créateur par ordre de fiabilité décroissante. */
export async function resolveCreator(
  rpc: RpcClient,
  config: ScannerConfig,
  token: TokenInfo,
  reserve: ReserveAnalysis | null,
): Promise<CreatorIdentity | null> {
  if (config.creatorOverride) return { address: config.creatorOverride, source: 'override' };
  if (reserve?.bondingCurve?.creator) return { address: reserve.bondingCurve.creator, source: 'pump.fun bonding curve' };

  if (config.mintHistoryMaxPages > 0) {
    const fromHistory = await findMintCreator(rpc, new PublicKey(token.mint), config.mintHistoryMaxPages);
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
export async function scanCreatorHistory(rpc: RpcClient, creator: PublicKey, scanLimit: number): Promise<CreatorHistory> {
  const [lamports, signatures] = await Promise.all([
    rpc.call((c) => c.getBalance(creator)),
    // Au moins 1 signature pour estimer l'activité même si le scan est désactivé.
    fetchSignatures(rpc, creator, Math.max(scanLimit, 1)),
  ]);

  const created = new Set<string>();
  const toScan = scanLimit > 0 ? signatures.filter((s) => s.err === null).slice(0, scanLimit) : [];
  let txScanned = 0;
  await Promise.all(
    toScan.map(async ({ signature }) => {
      const tx = await rpc
        .call((c) => c.getParsedTransaction(signature, { maxSupportedTransactionVersion: 0 }))
        .catch(() => null);
      if (!tx) return;
      txScanned++;
      const signedByCreator = tx.transaction.message.accountKeys.some((k) => k.signer && k.pubkey.equals(creator));
      if (!signedByCreator) return;
      for (const m of extractInitializedMints(tx)) created.add(m);
    }),
  );

  const fullHistory = signatures.length < Math.max(scanLimit, 1);
  const oldest = signatures[signatures.length - 1];
  const oldestActivity = oldest?.blockTime ? new Date(oldest.blockTime * 1000) : undefined;

  return {
    solBalance: lamportsToSol(BigInt(lamports)),
    createdMints: [...created],
    txScanned,
    fullHistory,
    signatureCount: signatures.length,
    walletAgeDays: fullHistory && oldestActivity ? (Date.now() - oldestActivity.getTime()) / 86_400_000 : undefined,
    oldestActivity,
  };
}

export async function analyzeCreator(
  rpc: RpcClient,
  config: ScannerConfig,
  token: TokenInfo,
  identity: CreatorIdentity,
): Promise<CreatorAnalysis> {
  const creator = new PublicKey(identity.address);
  const mint = new PublicKey(token.mint);

  const [history, tokenAccounts] = await Promise.all([
    scanCreatorHistory(rpc, creator, config.creatorTxScanLimit),
    rpc.call((c) => c.getTokenAccountsByOwner(creator, { mint })),
  ]);

  let held = 0n;
  for (const { pubkey, account } of tokenAccounts.value) {
    try {
      held += unpackAccount(pubkey, account, account.owner).amount;
    } catch {
      // compte illisible ignoré
    }
  }

  return {
    address: identity.address,
    source: identity.source,
    ...history,
    holdingPct: percentOf(held, token.supply),
    previousTokensCreated: history.createdMints.filter((m) => m !== token.mint).length,
  };
}
