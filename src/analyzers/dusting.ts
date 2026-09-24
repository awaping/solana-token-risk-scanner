/**
 * Module "Dusting check" : détection de faux compteurs de holders.
 *
 * Envoyer une quantité infinitésimale de tokens à des milliers d'adresses
 * gonfle artificiellement le "nombre de holders" affiché par les explorateurs.
 * On recense tous les comptes de token du mint (getProgramAccounts filtré sur
 * le mint, en ne rapatriant que owner + amount) puis on compare le nombre de
 * holders au nombre de soldes inférieurs au seuil de poussière (0,001 % de la
 * supply par défaut).
 */
import { PublicKey } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID } from '../constants.js';
import type { RpcClient } from '../rpc/client.js';
import type { DustingAnalysis, TokenInfo } from '../types.js';
import { bn, BigNumber } from '../utils/math.js';

/** Taille d'un compte SPL Token classique (sans extension). */
const TOKEN_ACCOUNT_SIZE = 165;

export const DEFAULT_DUST_THRESHOLD_PCT = 0.001;

export interface TokenAccountBalance {
  owner: string;
  amount: bigint;
}

/** Seuil de poussière en unités brutes : supply × pct / 100. */
export function dustThresholdRaw(supply: bigint, thresholdPct: number): bigint {
  return BigInt(bn(supply).times(thresholdPct).div(100).integerValue(BigNumber.ROUND_FLOOR).toFixed(0));
}

/** Agrège les comptes par propriétaire et calcule les métriques de dusting. */
export function summarizeDusting(
  balances: TokenAccountBalance[],
  supply: bigint,
  thresholdPct = DEFAULT_DUST_THRESHOLD_PCT,
): DustingAnalysis {
  const byOwner = new Map<string, bigint>();
  let emptyAccounts = 0;
  for (const { owner, amount } of balances) {
    if (amount === 0n) emptyAccounts++;
    byOwner.set(owner, (byOwner.get(owner) ?? 0n) + amount);
  }

  const threshold = dustThresholdRaw(supply, thresholdPct);
  let totalHolders = 0;
  let dustHolders = 0;
  for (const amount of byOwner.values()) {
    if (amount === 0n) continue;
    totalHolders++;
    if (amount < threshold) dustHolders++;
  }

  return {
    totalHolders,
    dustHolders,
    emptyAccounts,
    dustRatio: totalHolders === 0 ? 0 : dustHolders / totalHolders,
    effectiveHolders: totalHolders - dustHolders,
    dustThresholdPct: thresholdPct,
    dustThresholdRaw: threshold,
  };
}

export async function analyzeDusting(
  rpc: RpcClient,
  token: TokenInfo,
  thresholdPct = DEFAULT_DUST_THRESHOLD_PCT,
): Promise<DustingAnalysis> {
  const programId = new PublicKey(token.programId);
  const isLegacyToken = programId.equals(TOKEN_PROGRAM_ID);

  const accounts = await rpc.call((c) =>
    c.getProgramAccounts(programId, {
      encoding: 'base64',
      // owner (offset 32, 32 octets) + amount (offset 64, u64) = 40 octets par compte
      dataSlice: { offset: 32, length: 40 },
      filters: [
        // Les comptes Token-2022 ont une taille variable (extensions) : pas de filtre de taille.
        ...(isLegacyToken ? [{ dataSize: TOKEN_ACCOUNT_SIZE }] : []),
        { memcmp: { offset: 0, bytes: token.mint } },
      ],
    }),
  );

  const balances: TokenAccountBalance[] = [];
  for (const { account } of accounts) {
    const data = account.data;
    if (data.length < 40) continue;
    balances.push({
      owner: new PublicKey(data.subarray(0, 32)).toBase58(),
      amount: data.readBigUInt64LE(32),
    });
  }

  return summarizeDusting(balances, token.supply, thresholdPct);
}
