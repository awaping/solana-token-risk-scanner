/**
 * Module "Wallets frais" : part de la supply détenue par des wallets tout neufs
 * parmi les plus gros holders.
 *
 * Un wallet est « frais » si son historique complet tient en moins de 30
 * transactions et que la première date de moins de 24 h. C'est la signature
 * d'un lancement « bundlé » : le dev crée et finance des wallets juste avant le
 * lancement, achète avec, puis revend par eux. Une requête par wallet examiné
 * (getSignaturesForAddress), mise en cache quelques minutes.
 */
import { PublicKey } from '@solana/web3.js';
import type { ScanCache } from '../cache.js';
import type { RpcClient } from '../rpc/client.js';
import type { FreshWallet, FreshWalletsAnalysis, HoldersAnalysis } from '../types.js';

export const FRESH = {
  MAX_AGE_HOURS: 24,
  MAX_TRANSACTIONS: 30,
  /** Wallets examinés au plus (les plus gros, qui portent l'essentiel de la part), et part minimale pour l'être. */
  CHECK_TOP: 8,
  MIN_PCT: 0.5,
  CACHE_MS: 5 * 60_000,
} as const;

/** Activité d'un wallet : nombre de transactions (borné) et date de la première si l'historique est complet. */
export interface WalletActivity {
  transactions: number;
  complete: boolean;
  /** Plus ancienne transaction (s, horodatage Unix). */
  oldest?: number;
}

export function isFresh(activity: WalletActivity, now = Date.now()): boolean {
  if (!activity.complete || activity.oldest === undefined || activity.transactions >= FRESH.MAX_TRANSACTIONS) return false;
  return now / 1000 - activity.oldest < FRESH.MAX_AGE_HOURS * 3600;
}

async function activityOf(rpc: RpcClient, owner: string, cache?: ScanCache): Promise<WalletActivity> {
  const key = `wallet:${owner}`;
  const cached = await cache?.get<WalletActivity>(key);
  if (cached) return cached;
  const signatures = await rpc.call((c) => c.getSignaturesForAddress(new PublicKey(owner), { limit: FRESH.MAX_TRANSACTIONS }));
  const oldest = signatures[signatures.length - 1]?.blockTime ?? undefined;
  const activity: WalletActivity = {
    transactions: signatures.length,
    complete: signatures.length < FRESH.MAX_TRANSACTIONS,
    ...(oldest ? { oldest } : {}),
  };
  await cache?.set(key, activity, FRESH.CACHE_MS);
  return activity;
}

export async function analyzeFreshWallets(
  rpc: RpcClient,
  holders: HoldersAnalysis,
  options: { creator?: string; cache?: ScanCache; now?: number } = {},
): Promise<FreshWalletsAnalysis> {
  const now = options.now ?? Date.now();
  const candidates = holders.wallets
    .filter((h) => h.kind === 'wallet' && h.owner !== options.creator && h.pct >= FRESH.MIN_PCT)
    .slice(0, FRESH.CHECK_TOP);
  const activities = await Promise.all(candidates.map((h) => activityOf(rpc, h.owner, options.cache).catch(() => null)));
  const fresh: FreshWallet[] = [];
  candidates.forEach((holder, i) => {
    const activity = activities[i];
    if (!activity || !isFresh(activity, now)) return;
    fresh.push({ owner: holder.owner, pct: holder.pct, ageHours: (now / 1000 - activity.oldest!) / 3600, transactions: activity.transactions });
  });
  return {
    checked: activities.filter(Boolean).length,
    fresh,
    freshPct: fresh.reduce((sum, w) => sum + w.pct, 0),
    maxAgeHours: FRESH.MAX_AGE_HOURS,
    maxTransactions: FRESH.MAX_TRANSACTIONS,
  };
}
