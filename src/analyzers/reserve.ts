/**
 * Module "Réserve réelle" : SOL effectivement détenus par la bonding curve
 * ou par les pools AMM, comparés à la capitalisation théorique du token.
 *
 * Stratégies, dans l'ordre :
 *   1. Bonding curve Pump.fun active (PDA ["bonding-curve", mint]).
 *   2. Pools SOL connus trouvés par getProgramAccounts filtré sur le mint :
 *      PumpSwap, Raydium AMM v4, Raydium CPMM.
 *   3. Repli générique : pools détectés parmi les plus gros holders (Orca,
 *      Meteora...) dont le compte de pool possède un vault WSOL.
 */
import { PublicKey, type Connection } from '@solana/web3.js';
import { unpackAccount } from '@solana/spl-token';
import {
  KNOWN_POOL_AUTHORITIES,
  PUMP_FUN_PROGRAM_ID,
  PUMPSWAP_PROGRAM_ID,
  RAYDIUM_AMM_V4_PROGRAM_ID,
  RAYDIUM_CPMM_PROGRAM_ID,
  WSOL_MINT,
} from '../constants.js';
import type { RpcClient } from '../rpc/client.js';
import type { HoldersAnalysis, PoolReserve, ReserveAnalysis, TokenInfo } from '../types.js';
import { bn, lamportsToSol, toUiAmount } from '../utils/math.js';
import {
  anchorAccountDiscriminator,
  bondingCurvePda,
  bondingCurvePriceSol,
  bondingCurveProgress,
  decodeBondingCurve,
} from './pumpfun.js';

/**
 * Description minimale d'un compte de pool : positions des deux mints et des
 * deux vaults. Le slot "A" est le premier mint du layout (base / token_0).
 */
export interface PoolLayout {
  venue: string;
  programId: PublicKey;
  dataSize?: number;
  discriminator?: Buffer;
  mintAOffset: number;
  mintBOffset: number;
  vaultAOffset: number;
  vaultBOffset: number;
}

export const POOL_LAYOUTS: PoolLayout[] = [
  {
    // Pool { pool_bump u8, index u16, creator, base_mint, quote_mint, lp_mint,
    //        pool_base_token_account, pool_quote_token_account, ... }
    venue: 'PumpSwap',
    programId: PUMPSWAP_PROGRAM_ID,
    discriminator: anchorAccountDiscriminator('Pool'),
    mintAOffset: 43,
    mintBOffset: 75,
    vaultAOffset: 139,
    vaultBOffset: 171,
  },
  {
    // LIQUIDITY_STATE_LAYOUT_V4 (752 octets) : baseVault 336, quoteVault 368, baseMint 400, quoteMint 432
    venue: 'Raydium AMM v4',
    programId: RAYDIUM_AMM_V4_PROGRAM_ID,
    dataSize: 752,
    mintAOffset: 400,
    mintBOffset: 432,
    vaultAOffset: 336,
    vaultBOffset: 368,
  },
  {
    // PoolState : amm_config, pool_creator, token_0_vault, token_1_vault, lp_mint, token_0_mint, token_1_mint...
    venue: 'Raydium CPMM',
    programId: RAYDIUM_CPMM_PROGRAM_ID,
    discriminator: anchorAccountDiscriminator('PoolState'),
    mintAOffset: 168,
    mintBOffset: 200,
    vaultAOffset: 72,
    vaultBOffset: 104,
  },
];

interface PoolCandidate {
  venue: string;
  address: string;
  tokenVault: PublicKey;
  solVault: PublicKey;
}

const readKey = (data: Buffer, offset: number) => new PublicKey(data.subarray(offset, offset + 32));

/** Recherche les pools token/WSOL d'un layout donné (dans les deux sens). */
async function findPoolsForLayout(rpc: RpcClient, layout: PoolLayout, mint: PublicKey): Promise<PoolCandidate[]> {
  const query = (mintA: PublicKey, mintB: PublicKey) =>
    rpc.call((c: Connection) =>
      c.getProgramAccounts(layout.programId, {
        encoding: 'base64',
        filters: [
          ...(layout.dataSize ? [{ dataSize: layout.dataSize }] : []),
          { memcmp: { offset: layout.mintAOffset, bytes: mintA.toBase58() } },
          { memcmp: { offset: layout.mintBOffset, bytes: mintB.toBase58() } },
        ],
      }),
    );

  const [tokenFirst, solFirst] = await Promise.all([query(mint, WSOL_MINT), query(WSOL_MINT, mint)]);
  const candidates: PoolCandidate[] = [];

  const collect = (results: typeof tokenFirst, tokenIsA: boolean) => {
    for (const { pubkey, account } of results) {
      const data = account.data;
      const minLength = Math.max(layout.vaultAOffset, layout.vaultBOffset, layout.mintAOffset, layout.mintBOffset) + 32;
      if (data.length < minLength) continue;
      if (layout.discriminator && !data.subarray(0, 8).equals(layout.discriminator)) continue;
      const vaultA = readKey(data, layout.vaultAOffset);
      const vaultB = readKey(data, layout.vaultBOffset);
      candidates.push({
        venue: layout.venue,
        address: pubkey.toBase58(),
        tokenVault: tokenIsA ? vaultA : vaultB,
        solVault: tokenIsA ? vaultB : vaultA,
      });
    }
  };
  collect(tokenFirst, true);
  collect(solFirst, false);
  return candidates;
}

/** Lit les soldes des vaults (token + WSOL) de chaque pool candidate. */
async function loadPoolReserves(rpc: RpcClient, candidates: PoolCandidate[]): Promise<PoolReserve[]> {
  if (candidates.length === 0) return [];
  const vaults = candidates.flatMap((c) => [c.tokenVault, c.solVault]);
  const balances = new Map<string, bigint>();

  for (let i = 0; i < vaults.length; i += 100) {
    const chunk = vaults.slice(i, i + 100);
    const infos = await rpc.call((c) => c.getMultipleAccountsInfo(chunk));
    chunk.forEach((vault, j) => {
      const info = infos[j];
      if (!info) return;
      try {
        balances.set(vault.toBase58(), unpackAccount(vault, info, info.owner).amount);
      } catch {
        // vault illisible : ignoré
      }
    });
  }

  return candidates
    .filter((c) => balances.has(c.tokenVault.toBase58()) && balances.has(c.solVault.toBase58()))
    .map((c) => ({
      venue: c.venue,
      address: c.address,
      tokenVault: c.tokenVault.toBase58(),
      solVault: c.solVault.toBase58(),
      tokenReserve: balances.get(c.tokenVault.toBase58())!,
      solReserveLamports: balances.get(c.solVault.toBase58())!,
    }));
}

/**
 * Repli générique : pour les pools repérées dans le top holders (Orca,
 * Meteora...), le compte de pool possède souvent directement son vault WSOL.
 * Les autorités partagées (Raydium) sont ignorées : elles possèdent des
 * milliers de vaults.
 */
async function findPoolsFromHolders(rpc: RpcClient, holders: HoldersAnalysis): Promise<PoolReserve[]> {
  const poolHolders = holders.top.filter(
    (h) => h.kind === 'liquidity-pool' && !KNOWN_POOL_AUTHORITIES.has(h.owner),
  );
  const pools: PoolReserve[] = [];
  for (const holder of poolHolders.slice(0, 5)) {
    const owner = new PublicKey(holder.owner);
    const wsolAccounts = await rpc.call((c) => c.getTokenAccountsByOwner(owner, { mint: WSOL_MINT }));
    if (wsolAccounts.value.length === 0 || wsolAccounts.value.length > 3) continue;
    let solReserve = 0n;
    for (const { pubkey, account } of wsolAccounts.value) {
      solReserve += unpackAccount(pubkey, account, account.owner).amount;
    }
    pools.push({
      venue: holder.label ?? 'Pool',
      address: holder.owner,
      tokenVault: holder.tokenAccounts[0] ?? '',
      solVault: wsolAccounts.value[0]!.pubkey.toBase58(),
      tokenReserve: holder.amount,
      solReserveLamports: solReserve,
    });
  }
  return pools;
}

/** Prix spot d'une pool constant product : réserve SOL / réserve token. */
export function poolPriceSol(pool: PoolReserve, tokenDecimals: number): number {
  const tokens = toUiAmount(pool.tokenReserve, tokenDecimals);
  if (tokens.isZero()) return 0;
  return bn(pool.solReserveLamports).shiftedBy(-9).div(tokens).toNumber();
}

export async function analyzeReserve(
  rpc: RpcClient,
  token: TokenInfo,
  getHolders: () => Promise<HoldersAnalysis | null>,
): Promise<ReserveAnalysis> {
  const mint = new PublicKey(token.mint);
  const supplyUi = toUiAmount(token.supply, token.decimals);
  const searchErrors: string[] = [];

  // 1. Bonding curve Pump.fun
  const curveAddress = bondingCurvePda(mint);
  const curveInfo = await rpc.call((c) => c.getAccountInfo(curveAddress));
  const curve =
    curveInfo && curveInfo.owner.equals(PUMP_FUN_PROGRAM_ID)
      ? decodeBondingCurve(curveAddress, curveInfo.data, BigInt(curveInfo.lamports))
      : null;

  if (curve && !curve.complete) {
    const price = bondingCurvePriceSol(curve, token.decimals);
    const marketCapSol = price.times(supplyUi).toNumber();
    const realReserveSol = lamportsToSol(curve.realSolReserves);
    const discrepancy =
      curve.realSolReserves > 0n
        ? bn(curve.backingLamports - curve.realSolReserves).times(100).div(bn(curve.realSolReserves)).toNumber()
        : undefined;
    return {
      marketType: 'bonding-curve',
      venue: 'Pump.fun bonding curve',
      bondingCurve: curve,
      bondingCurveProgressPct: bondingCurveProgress(curve),
      pools: [],
      realReserveSol,
      totalReserveSol: realReserveSol,
      priceSol: price.toNumber(),
      marketCapSol,
      reserveToMcapRatio: marketCapSol > 0 ? realReserveSol / marketCapSol : 0,
      reserveDiscrepancyPct: discrepancy,
      searchErrors,
    };
  }

  // 2. Pools AMM connues
  const candidateLists = await Promise.all(
    POOL_LAYOUTS.map((layout) =>
      findPoolsForLayout(rpc, layout, mint).catch((error: unknown) => {
        searchErrors.push(`${layout.venue} : ${error instanceof Error ? error.message : String(error)}`);
        return [] as PoolCandidate[];
      }),
    ),
  );
  let pools = await loadPoolReserves(rpc, candidateLists.flat());

  // 3. Repli générique via les plus gros holders
  if (pools.length === 0) {
    const holders = await getHolders();
    if (holders) {
      pools = await findPoolsFromHolders(rpc, holders).catch((error: unknown) => {
        searchErrors.push(`Pools génériques : ${error instanceof Error ? error.message : String(error)}`);
        return [];
      });
    }
  }

  pools.sort((a, b) => (b.solReserveLamports > a.solReserveLamports ? 1 : b.solReserveLamports < a.solReserveLamports ? -1 : 0));
  const main = pools[0];

  if (!main) {
    return {
      marketType: 'none',
      venue: curve?.complete ? 'Bonding curve terminée, pool introuvable' : 'Aucun marché SOL identifié',
      bondingCurve: curve ?? undefined,
      bondingCurveProgressPct: curve ? 100 : undefined,
      pools: [],
      realReserveSol: 0,
      totalReserveSol: 0,
      priceSol: 0,
      marketCapSol: 0,
      reserveToMcapRatio: 0,
      searchErrors,
    };
  }

  const priceSol = poolPriceSol(main, token.decimals);
  const marketCapSol = bn(priceSol).times(supplyUi).toNumber();
  const realReserveSol = lamportsToSol(main.solReserveLamports);
  const totalReserveSol = pools.reduce((acc, p) => acc + lamportsToSol(p.solReserveLamports), 0);

  return {
    marketType: 'amm-pool',
    venue: main.venue,
    bondingCurve: curve ?? undefined,
    bondingCurveProgressPct: curve ? 100 : undefined,
    pools,
    realReserveSol,
    totalReserveSol,
    priceSol,
    marketCapSol,
    reserveToMcapRatio: marketCapSol > 0 ? realReserveSol / marketCapSol : 0,
    searchErrors,
  };
}
