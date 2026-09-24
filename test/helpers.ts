import { Keypair } from '@solana/web3.js';
import type { Holder, HolderKind } from '../src/types.js';

export const SUPPLY = 1_000_000_000_000_000n; // 1 milliard de tokens à 6 décimales

/** Crée un holder détenant `pct` % de SUPPLY. */
export function holder(pct: number, kind: HolderKind = 'wallet', owner = Keypair.generate().publicKey.toBase58()): Holder {
  const amount = (SUPPLY * BigInt(Math.round(pct * 1e6))) / 100_000_000n;
  return { owner, tokenAccounts: [owner], amount, pct, kind };
}

/** Distribution organique (loi de Zipf) : parts décroissantes en 1/k. */
export function zipfHolders(count: number, topPct: number): Holder[] {
  return Array.from({ length: count }, (_, i) => holder(topPct / (i + 1)));
}
