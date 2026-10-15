/**
 * src/core/config.ts
 * ---------------------------------------------------------------------------
 * Validation de l'environnement, une fois, au demarrage.
 *
 * PRINCIPE : un bot qui manipule de l'argent ne doit jamais decouvrir qu'une
 * variable manque au moment ou il en a besoin. Une cle absente ne se
 * remarquerait sinon qu'au premier signal - c'est-a-dire au pire moment, apres
 * avoir laisse passer le seul tweet de la journee qui valait quelque chose.
 * Tout est donc valide, coerce et type ici, et le processus refuse de demarrer
 * si quoi que ce soit cloche.
 *
 * Les secrets ne sont exiges qu'en mode reel : `DRY_RUN=true` doit pouvoir
 * tourner sur une machine de developpement sans cle privee ni cle d'API.
 * ---------------------------------------------------------------------------
 */

import { Keypair, LAMPORTS_PER_SOL } from '@solana/web3.js';
import bs58 from 'bs58';
import { z } from 'zod';

import type { AnalyzerConfig } from '../agent/analyzer.ts';
import type { JitoConfig } from '../solana/jitoBundle.ts';
import type { KeypairPoolConfig } from '../solana/keypairPool.ts';
import type { ExitConfig } from '../trader/exit.ts';
import type { FeeClaimConfig } from '../trader/fees.ts';
import { type TakeProfitTier, parseTiers } from '../trader/position.ts';

// ---------------------------------------------------------------------------
// Helpers de coercition
// ---------------------------------------------------------------------------

/** "true"/"1" -> true. Tout le reste -> false. Absent -> defaut. */
const bool = (def: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined ? def : v === 'true' || v === '1'));

const num = (def?: number) =>
  z
    .string()
    .optional()
    .transform((v, ctx) => {
      if (v === undefined || v === '') {
        if (def === undefined) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'required' });
          return z.NEVER;
        }
        return def;
      }
      const n = Number(v);
      if (!Number.isFinite(n)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `not a number: "${v}"` });
        return z.NEVER;
      }
      return n;
    });

/** Liste separee par des virgules, vide filtre. */
const list = (def: string[] = []) =>
  z
    .string()
    .optional()
    .transform((v) =>
      v === undefined || v.trim() === ''
        ? def
        : v
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean),
    );

/**
 * Cle privee base58 (format export Phantom).
 * On valide la LONGUEUR ici plutot que de laisser `Keypair.fromSecretKey`
 * lever une erreur cryptique trois modules plus loin.
 */
export function parseKeypair(secret: string, label: string): Keypair {
  let bytes: Uint8Array;
  try {
    bytes = bs58.decode(secret.trim());
  } catch {
    throw new Error(`${label}: not valid base58`);
  }
  if (bytes.length !== 64) {
    throw new Error(`${label}: expected a 64-byte secret key, got ${bytes.length} bytes`);
  }
  return Keypair.fromSecretKey(bytes);
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const EnvSchema = z
  .object({
    NODE_ENV: z.string().optional().default('production'),
    LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error']).optional().default('info'),
    DRY_RUN: bool(true),

    // Listener
    LISTENER_MODE: z.enum(['twitter-api', 'ws-relay', 'none']).optional().default('ws-relay'),
    TWITTER_BEARER_TOKEN: z.string().optional(),
    TWITTER_WS_URL: z.string().optional(),
    TWITTER_WS_API_KEY: z.string().optional(),
    WHITELIST_USER_IDS: list(),
    IGNORE_RETWEETS: bool(true),
    IGNORE_REPLIES: bool(true),
    MAX_TWEET_AGE_MS: num(15_000),
    ANALYZER_CONCURRENCY: num(4),

    // Store
    REDIS_URL: z.string().optional().default('redis://127.0.0.1:6379'),
    REDIS_KEY_PREFIX: z.string().optional().default('msniper:'),
    DEDUPE_TTL_SECONDS: num(86_400),

    // LLM
    LLM_BASE_URL: z.string().optional().default('https://api.groq.com/openai/v1'),
    LLM_API_KEY: z.string().optional(),
    LLM_MODEL: z.string().optional().default('llama-3.3-70b-versatile'),
    LLM_VISION_MODEL: z.string().optional().default('meta-llama/llama-4-scout-17b-16e-instruct'),
    LLM_TIMEOUT_MS: num(2_500),
    LLM_MAX_RETRIES: num(2),
    LLM_TEMPERATURE: num(0.4),
    MIN_CONFIDENCE: num(0.72),
    NAME_BLOCKLIST: list(),

    // Assets
    FAL_KEY: z.string().optional(),
    FAL_MODEL: z.string().optional().default('fal-ai/flux/schnell'),
    FAL_TIMEOUT_MS: num(1_500),
    PUMP_IPFS_URL: z.string().optional().default('https://pump.fun/api/ipfs'),
    PUMP_IPFS_TIMEOUT_MS: num(4_000),
    IRYS_PRIVATE_KEY: z.string().optional(),
    IRYS_RPC_URL: z.string().optional().default('https://api.mainnet-beta.solana.com'),
    IRYS_TIMEOUT_MS: num(8_000),

    // Solana
    RPC_URL: z.string().optional().default('https://api.mainnet-beta.solana.com'),
    DEPLOYER_PRIVATE_KEY: z.string().optional(),
    INITIAL_BUY_SOL: num(0.15),
    SLIPPAGE_BPS: num(500),
    COMPUTE_UNIT_LIMIT: num(350_000),
    COMPUTE_UNIT_PRICE_MICROLAMPORTS: num(150_000),
    MINT_KEYPAIR_POOL_SIZE: num(10),
    MINT_VANITY_SUFFIX: z.string().optional(),

    // Jito
    JITO_BLOCK_ENGINES: list(['ny.mainnet.block-engine.jito.wtf']),
    JITO_HTTP_URL: z.string().optional().default('https://mainnet.block-engine.jito.wtf'),
    JITO_TIP_FLOOR_URL: z
      .string()
      .optional()
      .default('https://bundles.jito.wtf/api/v1/bundles/tip_floor'),
    JITO_AUTH_PRIVATE_KEY: z.string().optional(),
    JITO_DYNAMIC_TIP: bool(true),
    JITO_TIP_PERCENTILE: num(75),
    JITO_TIP_MIN_LAMPORTS: num(1_000_000),
    JITO_TIP_MAX_LAMPORTS: num(20_000_000),
    JITO_TIP_MULTIPLIER: num(1.3),
    JITO_BUNDLE_TIMEOUT_MS: num(25_000),

    // Trader
    TAKE_PROFIT_MULTIPLIERS: z.string().optional().default('2,3,5'),
    TAKE_PROFIT_SELL_PCT: z.string().optional().default('33,33,34'),
    STOP_LOSS_PCT: num(40),
    TRAILING_STOP_PCT: num(25),
    TRAILING_ARMS_AT_MULTIPLE: num(2),
    VOLUME_DRY_UP_SECONDS: num(30),
    MAX_HOLD_SECONDS: num(900),
    PRICE_POLL_INTERVAL_MS: num(400),
    SELL_SLIPPAGE_BPS: num(500),
    SELL_COMPUTE_UNIT_LIMIT: num(220_000),
    SELL_COMPUTE_UNIT_PRICE_MICROLAMPORTS: num(120_000),
    AUTO_CLAIM_CREATOR_FEES: bool(true),
    CLAIM_FEES_INTERVAL_MS: num(300_000),
    MIN_CLAIM_SOL: num(0.005),

    // Garde-fous
    MAX_DAILY_SPEND_SOL: num(3),
    MAX_DEPLOYS_PER_HOUR: num(4),
    MIN_DEPLOYER_BALANCE_SOL: num(0.1),
  })
  .superRefine((env, ctx) => {
    const require = (path: string, value: unknown, why: string) => {
      if (value === undefined || value === '') {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: [path], message: why });
      }
    };

    // Les secrets ne sont exiges qu'en mode reel : DRY_RUN doit tourner nu.
    if (!env.DRY_RUN) {
      require('DEPLOYER_PRIVATE_KEY', env.DEPLOYER_PRIVATE_KEY, 'required when DRY_RUN=false');
      require('LLM_API_KEY', env.LLM_API_KEY, 'required when DRY_RUN=false');
      if (env.RPC_URL.includes('api.mainnet-beta.solana.com')) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['RPC_URL'],
          message:
            'the public mainnet endpoint is rate-limited and unusable for sniping - ' +
            'set a private RPC (Helius / Triton / QuickNode)',
        });
      }
    }

    if (env.LISTENER_MODE === 'twitter-api') {
      require('TWITTER_BEARER_TOKEN', env.TWITTER_BEARER_TOKEN, 'required for LISTENER_MODE=twitter-api');
    }
    if (env.LISTENER_MODE === 'ws-relay') {
      require('TWITTER_WS_URL', env.TWITTER_WS_URL, 'required for LISTENER_MODE=ws-relay');
    }
    if (env.LISTENER_MODE !== 'none' && env.WHITELIST_USER_IDS.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['WHITELIST_USER_IDS'],
        message: 'at least one numeric author id is required, otherwise the bot listens to nobody',
      });
    }
    // Un handle a la place d'un ID numerique : erreur silencieuse classique,
    // le filtre ne matcherait jamais.
    for (const id of env.WHITELIST_USER_IDS) {
      if (!/^\d+$/.test(id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['WHITELIST_USER_IDS'],
          message: `"${id}" is not a numeric user id (a @handle will never match)`,
        });
      }
    }

    if (![25, 50, 75, 95, 99].includes(env.JITO_TIP_PERCENTILE)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['JITO_TIP_PERCENTILE'],
        message: 'must be one of 25, 50, 75, 95, 99',
      });
    }
    if (env.JITO_TIP_MIN_LAMPORTS > env.JITO_TIP_MAX_LAMPORTS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['JITO_TIP_MIN_LAMPORTS'],
        message: 'cannot exceed JITO_TIP_MAX_LAMPORTS',
      });
    }
    if (env.INITIAL_BUY_SOL > env.MAX_DAILY_SPEND_SOL) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['INITIAL_BUY_SOL'],
        message: 'a single buy exceeds the 24h spend cap - no deploy could ever pass the guards',
      });
    }
    try {
      parseTiers(env.TAKE_PROFIT_MULTIPLIERS, env.TAKE_PROFIT_SELL_PCT);
    } catch (err) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['TAKE_PROFIT_MULTIPLIERS'],
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });

export type Env = z.infer<typeof EnvSchema>;

// ---------------------------------------------------------------------------
// Configuration applicative
// ---------------------------------------------------------------------------

export interface GuardConfig {
  maxDailySpendLamports: bigint;
  maxDeploysPerHour: number;
  minDeployerBalanceLamports: bigint;
}

export interface ListenerConfig {
  mode: 'twitter-api' | 'ws-relay' | 'none';
  bearerToken?: string;
  wsUrl?: string;
  wsApiKey?: string;
  whitelistUserIds: string[];
  ignoreRetweets: boolean;
  ignoreReplies: boolean;
  analyzerConcurrency: number;
  dedupeTtlSeconds: number;
}

export interface AssetsConfig {
  falKey?: string;
  falModel: string;
  falTimeoutMs: number;
  pumpIpfsUrl: string;
  pumpIpfsTimeoutMs: number;
  irysPrivateKey?: string;
  irysRpcUrl: string;
  irysTimeoutMs: number;
}

export interface AppConfig {
  nodeEnv: string;
  logLevel: 'trace' | 'debug' | 'info' | 'warn' | 'error';
  dryRun: boolean;
  rpcUrl: string;
  redisUrl: string;
  redisKeyPrefix: string;

  deployer: Keypair;
  /** true si la keypair a ete generee a la volee (DRY_RUN sans cle fournie). */
  deployerIsEphemeral: boolean;

  initialBuyLamports: bigint;
  slippageBps: number;
  computeUnitLimit: number;
  computeUnitPriceMicroLamports: number;

  analyzer: AnalyzerConfig;
  assets: AssetsConfig;
  listener: ListenerConfig;
  jito: JitoConfig;
  keypairPool: KeypairPoolConfig;
  exit: ExitConfig;
  tiers: TakeProfitTier[];
  monitorPollIntervalMs: number;
  feeClaim: FeeClaimConfig;
  autoClaimFees: boolean;
  claimFeesIntervalMs: number;
  guards: GuardConfig;
}

const solToLamports = (sol: number) => BigInt(Math.round(sol * LAMPORTS_PER_SOL));

/**
 * Charge et valide l'environnement. Leve une erreur unique agregeant TOUS les
 * problemes - corriger le .env en une passe plutot qu'en dix redemarrages.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map(
      (i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`,
    );
    throw new Error(`invalid environment:\n${lines.join('\n')}`);
  }
  const e = parsed.data;

  // En DRY_RUN sans cle, on genere une keypair jetable : le pipeline complet
  // reste executable sur une machine de developpement, sans secret.
  const deployerIsEphemeral = !e.DEPLOYER_PRIVATE_KEY;
  const deployer = e.DEPLOYER_PRIVATE_KEY
    ? parseKeypair(e.DEPLOYER_PRIVATE_KEY, 'DEPLOYER_PRIVATE_KEY')
    : Keypair.generate();

  return {
    nodeEnv: e.NODE_ENV,
    logLevel: e.LOG_LEVEL,
    dryRun: e.DRY_RUN,
    rpcUrl: e.RPC_URL,
    redisUrl: e.REDIS_URL,
    redisKeyPrefix: e.REDIS_KEY_PREFIX,

    deployer,
    deployerIsEphemeral,

    initialBuyLamports: solToLamports(e.INITIAL_BUY_SOL),
    slippageBps: e.SLIPPAGE_BPS,
    computeUnitLimit: e.COMPUTE_UNIT_LIMIT,
    computeUnitPriceMicroLamports: e.COMPUTE_UNIT_PRICE_MICROLAMPORTS,

    analyzer: {
      baseUrl: e.LLM_BASE_URL,
      apiKey: e.LLM_API_KEY ?? 'dry-run-no-key',
      model: e.LLM_MODEL,
      visionModel: e.LLM_VISION_MODEL,
      timeoutMs: e.LLM_TIMEOUT_MS,
      maxRetries: e.LLM_MAX_RETRIES,
      temperature: e.LLM_TEMPERATURE,
      minConfidence: e.MIN_CONFIDENCE,
      nameBlocklist: e.NAME_BLOCKLIST,
      maxTweetAgeMs: e.MAX_TWEET_AGE_MS,
    },

    assets: {
      falKey: e.FAL_KEY,
      falModel: e.FAL_MODEL,
      falTimeoutMs: e.FAL_TIMEOUT_MS,
      pumpIpfsUrl: e.PUMP_IPFS_URL,
      pumpIpfsTimeoutMs: e.PUMP_IPFS_TIMEOUT_MS,
      irysPrivateKey: e.IRYS_PRIVATE_KEY,
      irysRpcUrl: e.IRYS_RPC_URL,
      irysTimeoutMs: e.IRYS_TIMEOUT_MS,
    },

    listener: {
      mode: e.LISTENER_MODE,
      bearerToken: e.TWITTER_BEARER_TOKEN,
      wsUrl: e.TWITTER_WS_URL,
      wsApiKey: e.TWITTER_WS_API_KEY,
      whitelistUserIds: e.WHITELIST_USER_IDS,
      ignoreRetweets: e.IGNORE_RETWEETS,
      ignoreReplies: e.IGNORE_REPLIES,
      analyzerConcurrency: e.ANALYZER_CONCURRENCY,
      dedupeTtlSeconds: e.DEDUPE_TTL_SECONDS,
    },

    jito: {
      blockEngines: e.JITO_BLOCK_ENGINES,
      httpUrl: e.JITO_HTTP_URL,
      tipFloorUrl: e.JITO_TIP_FLOOR_URL,
      ...(e.JITO_AUTH_PRIVATE_KEY
        ? { authKeypair: parseKeypair(e.JITO_AUTH_PRIVATE_KEY, 'JITO_AUTH_PRIVATE_KEY') }
        : {}),
      dynamicTip: e.JITO_DYNAMIC_TIP,
      tipPercentile: e.JITO_TIP_PERCENTILE as 25 | 50 | 75 | 95 | 99,
      tipMinLamports: e.JITO_TIP_MIN_LAMPORTS,
      tipMaxLamports: e.JITO_TIP_MAX_LAMPORTS,
      tipMultiplier: e.JITO_TIP_MULTIPLIER,
      bundleTimeoutMs: e.JITO_BUNDLE_TIMEOUT_MS,
      dryRun: e.DRY_RUN,
    },

    keypairPool: {
      targetSize: e.MINT_KEYPAIR_POOL_SIZE,
      ...(e.MINT_VANITY_SUFFIX ? { vanitySuffix: e.MINT_VANITY_SUFFIX } : {}),
    },

    exit: {
      stopLossPct: e.STOP_LOSS_PCT,
      trailingStopPct: e.TRAILING_STOP_PCT,
      trailingArmsAtMultiple: e.TRAILING_ARMS_AT_MULTIPLE,
      volumeDryUpMs: e.VOLUME_DRY_UP_SECONDS * 1000,
      maxHoldMs: e.MAX_HOLD_SECONDS * 1000,
      slippageBps: e.SELL_SLIPPAGE_BPS,
      computeUnitLimit: e.SELL_COMPUTE_UNIT_LIMIT,
      computeUnitPriceMicroLamports: e.SELL_COMPUTE_UNIT_PRICE_MICROLAMPORTS,
    },
    tiers: parseTiers(e.TAKE_PROFIT_MULTIPLIERS, e.TAKE_PROFIT_SELL_PCT),
    monitorPollIntervalMs: e.PRICE_POLL_INTERVAL_MS,

    feeClaim: {
      minClaimLamports: solToLamports(e.MIN_CLAIM_SOL),
      computeUnitLimit: 60_000,
      computeUnitPriceMicroLamports: 50_000,
    },
    autoClaimFees: e.AUTO_CLAIM_CREATOR_FEES,
    claimFeesIntervalMs: e.CLAIM_FEES_INTERVAL_MS,

    guards: {
      maxDailySpendLamports: solToLamports(e.MAX_DAILY_SPEND_SOL),
      maxDeploysPerHour: e.MAX_DEPLOYS_PER_HOUR,
      minDeployerBalanceLamports: solToLamports(e.MIN_DEPLOYER_BALANCE_SOL),
    },
  };
}
