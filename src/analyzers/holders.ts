/**
 * Module "Distribution des holders" : Top 20 des comptes de token, agrégés
 * par propriétaire et classés (wallet, bonding curve, pool, burn, créateur).
 *
 * Les comptes protocolaires (bonding curve, vaults de pool, burn) ne sont pas
 * des "baleines" : ils sont exclus des métriques de concentration.
 */
import { PublicKey, type AccountInfo } from '@solana/web3.js';
import { unpackAccount } from '@solana/spl-token';
import {
  BURN_ADDRESSES,
  KNOWN_LIQUIDITY_PROGRAMS,
  KNOWN_POOL_AUTHORITIES,
  PUMP_FUN_PROGRAM_ID,
  SYSTEM_PROGRAM_ID,
} from '../constants.js';
import type { RpcClient } from '../rpc/client.js';
import type { Holder, HolderKind, HoldersAnalysis, TokenInfo } from '../types.js';
import { percentOf } from '../utils/math.js';
import { bondingCurvePda } from './pumpfun.js';

export interface HolderContext {
  /** Adresse du créateur (si connue) pour le signaler dans le classement. */
  creator?: string;
}

const PROTOCOL_KINDS: ReadonlySet<HolderKind> = new Set(['bonding-curve', 'liquidity-pool', 'burn']);

export const isProtocolHolder = (holder: Holder): boolean => PROTOCOL_KINDS.has(holder.kind);

const short = (address: string) => `${address.slice(0, 4)}…${address.slice(-4)}`;

/**
 * Classe un propriétaire de compte de token.
 * @param ownerProgram programme propriétaire du compte "owner" (null si le compte n'existe pas)
 */
export function classifyOwner(
  owner: string,
  ownerProgram: string | null,
  ctx: { bondingCurve: string; creator?: string },
): { kind: HolderKind; label?: string } {
  if (BURN_ADDRESSES.has(owner)) return { kind: 'burn', label: 'Burn (incinérateur)' };
  if (owner === ctx.bondingCurve) return { kind: 'bonding-curve', label: 'Pump.fun bonding curve' };

  const authorityLabel = KNOWN_POOL_AUTHORITIES.get(owner);
  if (authorityLabel) return { kind: 'liquidity-pool', label: authorityLabel };

  if (ownerProgram) {
    const programLabel = KNOWN_LIQUIDITY_PROGRAMS.get(ownerProgram);
    if (programLabel) {
      return ownerProgram === PUMP_FUN_PROGRAM_ID.toBase58()
        ? { kind: 'bonding-curve', label: programLabel }
        : { kind: 'liquidity-pool', label: programLabel };
    }
  }

  if (ctx.creator && owner === ctx.creator) return { kind: 'creator', label: 'Créateur' };

  if (ownerProgram && ownerProgram !== SYSTEM_PROGRAM_ID.toBase58()) {
    return { kind: 'program', label: `Programme ${short(ownerProgram)}` };
  }
  if (!ownerProgram && !PublicKey.isOnCurve(new PublicKey(owner).toBytes())) {
    return { kind: 'program', label: 'PDA' };
  }
  return { kind: 'wallet' };
}

/** Somme des parts (en %) d'une liste de holders. */
const sumPct = (holders: Holder[]) => holders.reduce((acc, h) => acc + h.pct, 0);

/** Calcule les métriques de concentration à partir d'une liste de holders classés. */
export function summarizeHolders(top: Holder[]): HoldersAnalysis {
  const sorted = [...top].sort((a, b) => (b.amount > a.amount ? 1 : b.amount < a.amount ? -1 : 0));
  const wallets = sorted.filter((h) => !isProtocolHolder(h));
  const protocolPct = sumPct(sorted.filter((h) => h.kind === 'bonding-curve' || h.kind === 'liquidity-pool'));
  const burnedPct = sumPct(sorted.filter((h) => h.kind === 'burn'));
  const top20Pct = sumPct(wallets.slice(0, 20));
  const circulating = 100 - protocolPct - burnedPct;

  return {
    top: sorted,
    wallets,
    top10Pct: sumPct(wallets.slice(0, 10)),
    top20Pct,
    maxWalletPct: wallets[0]?.pct ?? 0,
    protocolPct,
    burnedPct,
    top20CirculatingPct: circulating > 0 ? Math.min(100, (top20Pct / circulating) * 100) : 0,
  };
}

export async function analyzeHolders(
  rpc: RpcClient,
  token: TokenInfo,
  ctx: HolderContext = {},
): Promise<HoldersAnalysis> {
  const mint = new PublicKey(token.mint);
  const programId = new PublicKey(token.programId);

  const largest = await rpc.call((c) => c.getTokenLargestAccounts(mint));
  const accounts = largest.value.filter((entry) => BigInt(entry.amount) > 0n);
  if (accounts.length === 0) return summarizeHolders([]);

  // 1. Propriétaire de chaque compte de token.
  const tokenInfos = await rpc.call((c) => c.getMultipleAccountsInfo(accounts.map((a) => a.address)));
  const byOwner = new Map<string, { amount: bigint; tokenAccounts: string[] }>();
  accounts.forEach((entry, i) => {
    const info = tokenInfos[i] ?? null;
    let owner: string;
    try {
      owner = unpackAccount(entry.address, info, info?.owner ?? programId).owner.toBase58();
    } catch {
      owner = entry.address.toBase58(); // compte illisible : on l'agrège sur lui-même
    }
    const current = byOwner.get(owner) ?? { amount: 0n, tokenAccounts: [] };
    current.amount += BigInt(entry.amount);
    current.tokenAccounts.push(entry.address.toBase58());
    byOwner.set(owner, current);
  });

  // 2. Nature de chaque propriétaire (wallet, PDA de pool, bonding curve...).
  const owners = [...byOwner.keys()];
  const ownerInfos: Array<AccountInfo<Buffer> | null> = await rpc.call((c) =>
    c.getMultipleAccountsInfo(owners.map((o) => new PublicKey(o))),
  );
  const bondingCurve = bondingCurvePda(mint).toBase58();

  const holders: Holder[] = owners.map((owner, i) => {
    const { amount, tokenAccounts } = byOwner.get(owner)!;
    const ownerProgram = ownerInfos[i]?.owner.toBase58() ?? null;
    const { kind, label } = classifyOwner(owner, ownerProgram, { bondingCurve, creator: ctx.creator });
    return { owner, tokenAccounts, amount, pct: percentOf(amount, token.supply), kind, label };
  });

  return summarizeHolders(holders);
}
