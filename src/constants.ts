/**
 * Adresses de programmes et comptes connus de l'écosystème Solana.
 *
 * Ces adresses servent à classer les détenteurs (bonding curve, pool AMM,
 * adresse de burn...) et à localiser les réserves de liquidité.
 */
import { PublicKey } from '@solana/web3.js';
import { NATIVE_MINT, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from '@solana/spl-token';

export { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID };

/** Mint du Wrapped SOL (quote asset des pools SOL). */
export const WSOL_MINT = NATIVE_MINT;

export const LAMPORTS_PER_SOL = 1_000_000_000n;
export const SOL_DECIMALS = 9;

export const SYSTEM_PROGRAM_ID = new PublicKey('11111111111111111111111111111111');

/** Programme Metaplex Token Metadata (nom / symbole des tokens SPL classiques). */
export const METAPLEX_METADATA_PROGRAM_ID = new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s');

/** Programme de bonding curve Pump.fun. */
export const PUMP_FUN_PROGRAM_ID = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');

/** AMM PumpSwap (destination des tokens Pump.fun après graduation). */
export const PUMPSWAP_PROGRAM_ID = new PublicKey('pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA');

/** Raydium AMM v4 (constant product historique). */
export const RAYDIUM_AMM_V4_PROGRAM_ID = new PublicKey('675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8');
/** Autorité (PDA) qui possède tous les vaults Raydium AMM v4. */
export const RAYDIUM_AMM_V4_AUTHORITY = new PublicKey('5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1');

/** Raydium CPMM (constant product, compatible Token-2022). */
export const RAYDIUM_CPMM_PROGRAM_ID = new PublicKey('CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C');
/** Autorité (PDA) qui possède tous les vaults Raydium CPMM. */
export const RAYDIUM_CPMM_AUTHORITY = new PublicKey('GpMZbSM2GgvTKHJirzeGfMFoaZ8UR2X7F4v8vHTvxFbL');

export const RAYDIUM_CLMM_PROGRAM_ID = new PublicKey('CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK');
export const RAYDIUM_LAUNCHLAB_PROGRAM_ID = new PublicKey('LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj');
export const ORCA_WHIRLPOOL_PROGRAM_ID = new PublicKey('whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc');
export const METEORA_DLMM_PROGRAM_ID = new PublicKey('LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo');
export const METEORA_DAMM_V1_PROGRAM_ID = new PublicKey('Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB');
export const METEORA_DAMM_V2_PROGRAM_ID = new PublicKey('cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG');
export const METEORA_DBC_PROGRAM_ID = new PublicKey('dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN');

/** Adresse "incinérateur" : les tokens envoyés ici sont considérés brûlés. */
export const INCINERATOR_ADDRESS = new PublicKey('1nc1nerator11111111111111111111111111111111');

/**
 * Programmes AMM / launchpad connus : un détenteur dont le propriétaire est un
 * compte appartenant à l'un de ces programmes est classé comme "protocole"
 * (réserve de liquidité) et exclu des statistiques de concentration.
 */
export const KNOWN_LIQUIDITY_PROGRAMS: ReadonlyMap<string, string> = new Map([
  [PUMP_FUN_PROGRAM_ID.toBase58(), 'Pump.fun bonding curve'],
  [PUMPSWAP_PROGRAM_ID.toBase58(), 'PumpSwap'],
  [RAYDIUM_AMM_V4_PROGRAM_ID.toBase58(), 'Raydium AMM v4'],
  [RAYDIUM_CPMM_PROGRAM_ID.toBase58(), 'Raydium CPMM'],
  [RAYDIUM_CLMM_PROGRAM_ID.toBase58(), 'Raydium CLMM'],
  [RAYDIUM_LAUNCHLAB_PROGRAM_ID.toBase58(), 'Raydium LaunchLab'],
  [ORCA_WHIRLPOOL_PROGRAM_ID.toBase58(), 'Orca Whirlpool'],
  [METEORA_DLMM_PROGRAM_ID.toBase58(), 'Meteora DLMM'],
  [METEORA_DAMM_V1_PROGRAM_ID.toBase58(), 'Meteora DAMM v1'],
  [METEORA_DAMM_V2_PROGRAM_ID.toBase58(), 'Meteora DAMM v2'],
  [METEORA_DBC_PROGRAM_ID.toBase58(), 'Meteora DBC'],
]);

/** Autorités partagées connues (propriétaires directs des vaults de pool). */
export const KNOWN_POOL_AUTHORITIES: ReadonlyMap<string, string> = new Map([
  [RAYDIUM_AMM_V4_AUTHORITY.toBase58(), 'Raydium AMM v4'],
  [RAYDIUM_CPMM_AUTHORITY.toBase58(), 'Raydium CPMM'],
]);

/** Adresses de burn reconnues. */
export const BURN_ADDRESSES: ReadonlySet<string> = new Set([INCINERATOR_ADDRESS.toBase58()]);

/**
 * Constantes de la bonding curve Pump.fun (valeurs par défaut du programme,
 * token à 6 décimales et supply de 1 milliard).
 */
export const PUMP_FUN = {
  INITIAL_VIRTUAL_TOKEN_RESERVES: 1_073_000_000_000_000n,
  INITIAL_VIRTUAL_SOL_RESERVES: 30_000_000_000n,
  INITIAL_REAL_TOKEN_RESERVES: 793_100_000_000_000n,
  TOKEN_TOTAL_SUPPLY: 1_000_000_000_000_000n,
} as const;
