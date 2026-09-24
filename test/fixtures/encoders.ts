/** Encodeurs de comptes on-chain utilisés par les tests. */
import { PublicKey } from '@solana/web3.js';
import { BONDING_CURVE_DISCRIMINATOR } from '../../src/analyzers/pumpfun.js';
import { PUMP_FUN } from '../../src/constants.js';

export function encodeBondingCurve(fields: {
  virtualTokenReserves: bigint;
  virtualSolReserves: bigint;
  realTokenReserves: bigint;
  realSolReserves: bigint;
  tokenTotalSupply?: bigint;
  complete?: boolean;
  creator?: PublicKey;
}): Buffer {
  const data = Buffer.alloc(150);
  BONDING_CURVE_DISCRIMINATOR.copy(data, 0);
  data.writeBigUInt64LE(fields.virtualTokenReserves, 8);
  data.writeBigUInt64LE(fields.virtualSolReserves, 16);
  data.writeBigUInt64LE(fields.realTokenReserves, 24);
  data.writeBigUInt64LE(fields.realSolReserves, 32);
  data.writeBigUInt64LE(fields.tokenTotalSupply ?? PUMP_FUN.TOKEN_TOTAL_SUPPLY, 40);
  data.writeUInt8(fields.complete ? 1 : 0, 48);
  (fields.creator ?? PublicKey.default).toBuffer().copy(data, 49);
  return data;
}

/** État de curve cohérent (x·y = k) après `virtualSol` lamports de réserve virtuelle. */
export function curveStateAt(virtualSol: bigint) {
  const k = PUMP_FUN.INITIAL_VIRTUAL_TOKEN_RESERVES * PUMP_FUN.INITIAL_VIRTUAL_SOL_RESERVES;
  const virtualTokenReserves = k / virtualSol;
  const sold = PUMP_FUN.INITIAL_VIRTUAL_TOKEN_RESERVES - virtualTokenReserves;
  return {
    virtualTokenReserves,
    virtualSolReserves: virtualSol,
    realTokenReserves: PUMP_FUN.INITIAL_REAL_TOKEN_RESERVES - sold,
    realSolReserves: virtualSol - PUMP_FUN.INITIAL_VIRTUAL_SOL_RESERVES,
  };
}

/** Compte Metaplex Token Metadata minimal (Borsh). */
export function encodeMetaplexMetadata(opts: {
  updateAuthority: PublicKey;
  mint: PublicKey;
  name: string;
  symbol: string;
  uri?: string;
  isMutable: boolean;
}): Buffer {
  const str = (value: string, padTo: number) => {
    const bytes = Buffer.alloc(padTo);
    Buffer.from(value, 'utf8').copy(bytes);
    const len = Buffer.alloc(4);
    len.writeUInt32LE(padTo);
    return Buffer.concat([len, bytes]);
  };
  return Buffer.concat([
    Buffer.from([4]),
    opts.updateAuthority.toBuffer(),
    opts.mint.toBuffer(),
    str(opts.name, 32),
    str(opts.symbol, 10),
    str(opts.uri ?? 'https://example.org/meta.json', 200),
    Buffer.from([0, 0]), // seller_fee_basis_points
    Buffer.from([0]), // creators: None
    Buffer.from([0]), // primary_sale_happened
    Buffer.from([opts.isMutable ? 1 : 0]),
  ]);
}

/** Écrit des clés publiques à des offsets donnés dans un buffer. */
export function withKeys(size: number, keys: Array<[number, PublicKey]>, discriminator?: Buffer): Buffer {
  const data = Buffer.alloc(size);
  discriminator?.copy(data, 0);
  for (const [offset, key] of keys) key.toBuffer().copy(data, offset);
  return data;
}
