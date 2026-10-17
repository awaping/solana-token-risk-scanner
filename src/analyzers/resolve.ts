/**
 * Retrouve le mint d'un token à partir d'une adresse qui n'en est pas un.
 *
 * Les explorateurs et agrégateurs affichent souvent une autre adresse que le
 * mint (CA) : la bonding curve Pump.fun ou la pool (DexScreener, Birdeye…), un
 * compte de token (Solscan), voire un lien complet. Plutôt que d'échouer, le
 * scanner remonte jusqu'au mint quand c'est possible, et explique sinon.
 */
import { unpackAccount, NATIVE_MINT } from '@solana/spl-token';
import { PublicKey, type AccountInfo } from '@solana/web3.js';
import {
  KNOWN_LIQUIDITY_PROGRAMS,
  PUMP_FUN_PROGRAM_ID,
  SYSTEM_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from '../constants.js';
import type { RpcClient } from '../rpc/client.js';
import { anchorAccountDiscriminator, bondingCurvePda } from './pumpfun.js';
import { POOL_LAYOUTS } from './reserve.js';

export interface ResolvedMint {
  mint: PublicKey;
  /** Nature de l'adresse fournie, pour l'affichage (« bonding curve Pump.fun »…). */
  from: string;
}

const BONDING_CURVE_DISCRIMINATOR = anchorAccountDiscriminator('BondingCurve');

/** Mint détenu par la bonding curve Pump.fun (son compte de token associé). */
async function mintOfBondingCurve(rpc: RpcClient, curve: PublicKey): Promise<PublicKey | null> {
  const lists = await Promise.all(
    [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID].map((programId) =>
      rpc.call((c) => c.getTokenAccountsByOwner(curve, { programId })).then((r) => r.value).catch(() => []),
    ),
  );
  for (const { account } of lists.flat()) {
    const mint = new PublicKey(account.data.subarray(0, 32));
    // La bonding curve est la PDA ["bonding-curve", mint] : on vérifie que c'est bien la sienne.
    if (bondingCurvePda(mint).equals(curve)) return mint;
  }
  return null;
}

/**
 * Déduit le mint d'un compte qui n'est pas un mint. Lève une erreur explicite
 * (wallet, programme inconnu…) si ce n'est pas possible.
 */
export async function resolveMintFromAccount(rpc: RpcClient, address: PublicKey, info: AccountInfo<Buffer>): Promise<ResolvedMint> {
  const owner = info.owner;
  const data = info.data;
  const given = address.toBase58();

  // Compte de token (Solscan affiche souvent celui d'un holder) : le mint est dans le compte.
  if (owner.equals(TOKEN_PROGRAM_ID) || owner.equals(TOKEN_2022_PROGRAM_ID)) {
    try {
      const account = unpackAccount(address, info, owner);
      return { mint: account.mint, from: 'compte de token' };
    } catch {
      throw new Error(`${given} appartient au programme Token mais n'est ni un mint ni un compte de token`);
    }
  }

  if (owner.equals(PUMP_FUN_PROGRAM_ID)) {
    if (data.length >= 8 && data.subarray(0, 8).equals(BONDING_CURVE_DISCRIMINATOR)) {
      const mint = await mintOfBondingCurve(rpc, address);
      if (mint) return { mint, from: 'bonding curve Pump.fun' };
      throw new Error(`${given} est une bonding curve Pump.fun, mais son mint est introuvable : collez l'adresse du token (CA, elle finit souvent par « pump »)`);
    }
    throw new Error(`${given} est un compte interne de Pump.fun, pas un token : collez l'adresse du token (CA, elle finit souvent par « pump »)`);
  }

  const layout = POOL_LAYOUTS.find(
    (l) =>
      owner.equals(l.programId) &&
      (l.dataSize === undefined || data.length === l.dataSize) &&
      (!l.discriminator || data.subarray(0, 8).equals(l.discriminator)) &&
      data.length >= Math.max(l.mintAOffset, l.mintBOffset) + 32,
  );
  if (layout) {
    const mintA = new PublicKey(data.subarray(layout.mintAOffset, layout.mintAOffset + 32));
    const mintB = new PublicKey(data.subarray(layout.mintBOffset, layout.mintBOffset + 32));
    // Le token analysé est le côté qui n'est pas du SOL (WSOL).
    const mint = mintA.equals(NATIVE_MINT) ? mintB : mintA;
    return { mint, from: `pool ${layout.venue}` };
  }

  if (owner.equals(SYSTEM_PROGRAM_ID)) {
    throw new Error(`${given} est un wallet, pas un token : collez l'adresse du token (CA)`);
  }
  const program = KNOWN_LIQUIDITY_PROGRAMS.get(owner.toBase58());
  throw new Error(
    program
      ? `${given} est un compte ${program} (pool ou position), pas un token : collez l'adresse du token (CA)`
      : `${given} n'est pas un mint SPL (propriétaire : ${owner.toBase58()}) : collez l'adresse du token (CA)`,
  );
}
