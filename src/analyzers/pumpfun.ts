/**
 * Décodage de la bonding curve Pump.fun.
 *
 * Compte Anchor `BondingCurve` (PDA ["bonding-curve", mint]) :
 *   0   discriminator            [u8; 8]
 *   8   virtual_token_reserves   u64
 *   16  virtual_sol_reserves     u64
 *   24  real_token_reserves      u64
 *   32  real_sol_reserves        u64
 *   40  token_total_supply       u64
 *   48  complete                 bool
 *   49  creator                  Pubkey  (ajouté en 2025, absent des anciens comptes)
 */
import { createHash } from 'node:crypto';
import { PublicKey } from '@solana/web3.js';
import { PUMP_FUN, PUMP_FUN_PROGRAM_ID } from '../constants.js';
import type { BondingCurveState } from '../types.js';
import { bn, BigNumber } from '../utils/math.js';

/** Discriminateur Anchor d'un compte : sha256("account:<Nom>")[0..8]. */
export function anchorAccountDiscriminator(name: string): Buffer {
  return createHash('sha256').update(`account:${name}`).digest().subarray(0, 8);
}

export const BONDING_CURVE_DISCRIMINATOR = anchorAccountDiscriminator('BondingCurve');

/** Rent exemption minimale d'un compte de `dataLength` octets (formule du runtime). */
export function rentExemptMinimum(dataLength: number): bigint {
  // (ACCOUNT_STORAGE_OVERHEAD + len) * lamports_per_byte_year * exemption_threshold
  return BigInt(128 + dataLength) * 3480n * 2n;
}

export function bondingCurvePda(mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from('bonding-curve'), mint.toBuffer()], PUMP_FUN_PROGRAM_ID)[0];
}

/** Décode un compte BondingCurve ; renvoie null si le format ne correspond pas. */
export function decodeBondingCurve(address: PublicKey, data: Buffer, lamports: bigint): BondingCurveState | null {
  if (data.length < 49 || !data.subarray(0, 8).equals(BONDING_CURVE_DISCRIMINATOR)) return null;

  let creator: string | null = null;
  if (data.length >= 81) {
    const key = new PublicKey(data.subarray(49, 81));
    if (!key.equals(PublicKey.default)) creator = key.toBase58();
  }

  const rent = rentExemptMinimum(data.length);
  return {
    address: address.toBase58(),
    virtualTokenReserves: data.readBigUInt64LE(8),
    virtualSolReserves: data.readBigUInt64LE(16),
    realTokenReserves: data.readBigUInt64LE(24),
    realSolReserves: data.readBigUInt64LE(32),
    tokenTotalSupply: data.readBigUInt64LE(40),
    complete: data.readUInt8(48) === 1,
    creator,
    lamports,
    backingLamports: lamports > rent ? lamports - rent : 0n,
  };
}

/** Prix spot (SOL par token UI) dérivé des réserves virtuelles : x·y = k. */
export function bondingCurvePriceSol(curve: BondingCurveState, tokenDecimals: number): BigNumber {
  if (curve.virtualTokenReserves === 0n) return bn(0);
  const sol = bn(curve.virtualSolReserves).shiftedBy(-9);
  const tokens = bn(curve.virtualTokenReserves).shiftedBy(-tokenDecimals);
  return sol.div(tokens);
}

/** Progression de la curve vers la graduation (0-100 %). */
export function bondingCurveProgress(curve: BondingCurveState): number {
  if (curve.complete) return 100;
  const initial = PUMP_FUN.INITIAL_REAL_TOKEN_RESERVES;
  if (curve.realTokenReserves >= initial) return 0;
  return bn(initial - curve.realTokenReserves).times(100).div(bn(initial)).toNumber();
}
