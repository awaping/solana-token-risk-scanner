/**
 * Scénarios on-chain simulés, partagés par les tests de bout en bout et la
 * démo hors-ligne (npm run demo).
 */
import { PublicKey, SystemProgram } from '@solana/web3.js';
import { anchorAccountDiscriminator, bondingCurvePda, rentExemptMinimum } from '../../src/analyzers/pumpfun.js';
import { metaplexMetadataPda } from '../../src/analyzers/token.js';
import {
  METAPLEX_METADATA_PROGRAM_ID,
  PUMP_FUN,
  PUMP_FUN_PROGRAM_ID,
  PUMPSWAP_PROGRAM_ID,
  RAYDIUM_AMM_V4_AUTHORITY,
  RAYDIUM_AMM_V4_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  WSOL_MINT,
} from '../../src/constants.js';
import { curveStateAt, encodeBondingCurve, encodeMetaplexMetadata, withKeys } from './encoders.js';
import { MockChain, randomKey } from './mock-rpc.js';

const SUPPLY = PUMP_FUN.TOKEN_TOTAL_SUPPLY;
const pctOf = (pct: number) => (SUPPLY * BigInt(Math.round(pct * 1e6))) / 100_000_000n;
const SOL = 1_000_000_000n;

const initMint2 = (mint: PublicKey) => ({
  program: 'spl-token',
  programId: TOKEN_PROGRAM_ID.toBase58(),
  parsed: { type: 'initializeMint2', info: { mint: mint.toBase58(), decimals: 6 } },
  stackHeight: 2,
});

/** Scénario 1 : token Pump.fun gradué, wallets clonés, dusting, liquidité minuscule. */
export function buildRugChain() {
  const chain = new MockChain();
  const mint = randomKey();
  const creator = randomKey();
  chain.addMint({ mint, supply: SUPPLY });
  chain.setAccount(creator, SystemProgram.programId, Buffer.alloc(0), 10_000_000); // 0,01 SOL

  const curveData = encodeBondingCurve({ ...curveStateAt(115n * SOL), realTokenReserves: 0n, complete: true, creator });
  chain.setAccount(bondingCurvePda(mint), PUMP_FUN_PROGRAM_ID, curveData, Number(rentExemptMinimum(150)));

  // Pool PumpSwap : base = token, quote = WSOL
  const pool = randomKey();
  const baseVault = randomKey();
  const quoteVault = randomKey();
  chain.setAccount(
    pool,
    PUMPSWAP_PROGRAM_ID,
    withKeys(
      300,
      [[43, mint], [75, WSOL_MINT], [139, baseVault], [171, quoteVault]],
      anchorAccountDiscriminator('Pool'),
    ),
  );
  chain.addTokenAccount(mint, pool, pctOf(20), baseVault);
  chain.addTokenAccount(WSOL_MINT, pool, 3n * SOL, quoteVault);

  chain.addTokenAccount(mint, creator, pctOf(5));
  const clones = Array.from({ length: 10 }, () => randomKey());
  for (const clone of clones) chain.addTokenAccount(mint, clone, pctOf(3));
  for (const pct of [1.5, 1.0, 0.8]) chain.addTokenAccount(mint, randomKey(), pctOf(pct));
  for (let i = 0; i < 800; i++) chain.addTokenAccount(mint, randomKey(), 1n);

  // Le créateur a déployé 3 autres tokens avant celui-ci.
  for (let i = 0; i < 3; i++) chain.addTransaction([creator], { signer: creator, innerInstructions: [initMint2(randomKey())] });
  chain.addTransaction([creator, mint], { signer: creator, innerInstructions: [initMint2(mint)] });
  return { chain, mint, creator, clones };
}

/** Scénario 2 : bonding curve active, distribution organique, créateur ancien. */
export function buildHealthyChain() {
  const chain = new MockChain();
  const mint = randomKey();
  const creator = randomKey();
  chain.addMint({ mint, supply: SUPPLY });
  chain.setAccount(creator, SystemProgram.programId, Buffer.alloc(0), Number(5n * SOL));
  chain.setAccount(
    metaplexMetadataPda(mint),
    METAPLEX_METADATA_PROGRAM_ID,
    encodeMetaplexMetadata({ updateAuthority: randomKey(), mint, name: 'Healthy Token', symbol: 'HLTH', isMutable: false }),
  );

  const state = curveStateAt(70n * SOL); // 40 SOL réels
  const curve = bondingCurvePda(mint);
  chain.setAccount(
    curve,
    PUMP_FUN_PROGRAM_ID,
    encodeBondingCurve({ ...state, creator }),
    Number(state.realSolReserves + rentExemptMinimum(150)),
  );
  chain.addTokenAccount(mint, curve, state.realTokenReserves + 206_900_000_000_000n);

  chain.addTokenAccount(mint, creator, pctOf(1));
  for (let k = 1; k <= 30; k++) chain.addTokenAccount(mint, randomKey(), pctOf(3 / k));
  for (let i = 0; i < 4; i++) chain.addTokenAccount(mint, randomKey(), 5n);

  chain.addTransaction([creator, mint], { signer: creator, innerInstructions: [initMint2(mint)] });
  for (let i = 0; i < 40; i++) chain.addTransaction([creator], { signer: creator, blockTime: 1_600_000_000 + i });
  return { chain, mint, creator };
}

/** Scénario 3 : token hors Pump.fun, pool Raydium AMM v4 (WSOL en base), mint authority active. */
export function buildRaydiumChain() {
  const chain = new MockChain();
  const mint = randomKey();
  const creator = randomKey();
  chain.addMint({ mint, supply: SUPPLY, mintAuthority: creator });
  chain.setAccount(creator, SystemProgram.programId, Buffer.alloc(0), Number(50n * SOL));

  const amm = randomKey();
  const solVault = randomKey();
  const tokenVault = randomKey();
  const ammData = withKeys(752, [[336, solVault], [368, tokenVault], [400, WSOL_MINT], [432, mint]]);
  chain.setAccount(amm, RAYDIUM_AMM_V4_PROGRAM_ID, ammData);
  chain.addTokenAccount(WSOL_MINT, RAYDIUM_AMM_V4_AUTHORITY, 500n * SOL, solVault);
  chain.addTokenAccount(mint, RAYDIUM_AMM_V4_AUTHORITY, pctOf(30), tokenVault);
  for (let k = 1; k <= 25; k++) chain.addTokenAccount(mint, randomKey(), pctOf(4 / k));

  // Historique du mint : la plus ancienne transaction est signée par le créateur.
  chain.addTransaction([mint, creator], { signer: creator, innerInstructions: [initMint2(mint)] });
  for (let i = 0; i < 5; i++) chain.addTransaction([mint], { signer: randomKey() });
  return { chain, mint, creator };
}

export const SCENARIOS = {
  rug: buildRugChain,
  healthy: buildHealthyChain,
  raydium: buildRaydiumChain,
} as const;
