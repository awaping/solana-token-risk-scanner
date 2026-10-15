/**
 * Garde-fous financiers + deduplication + config.
 * `node --test src/core/guards.test.ts`
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { Keypair, LAMPORTS_PER_SOL } from '@solana/web3.js';
import type { Connection } from '@solana/web3.js';
import pino from 'pino';

import { Guards } from './guards.ts';
import { MemoryStore } from './store.ts';
import { loadConfig, type GuardConfig } from './config.ts';
import { PipelineQueue } from '../listener/queue.ts';

const log = pino({ level: 'silent' });
const SOL = LAMPORTS_PER_SOL;

/** Connection minimale : les garde-fous n'appellent que getBalance. */
function fakeConnection(balanceSol: number): Connection {
  return { getBalance: async () => Math.round(balanceSol * SOL) } as unknown as Connection;
}

function newGuards(balanceSol = 10, over: Partial<GuardConfig> = {}) {
  const store = new MemoryStore();
  const guards = new Guards(
    store,
    fakeConnection(balanceSol),
    Keypair.generate().publicKey,
    { maxDailySpendLamports: BigInt(3 * SOL), maxDeploysPerHour: 4, minDeployerBalanceLamports: BigInt(0.1 * SOL), ...over },
    log,
  );
  return { store, guards };
}

// ---------------------------------------------------------------------------

test('autorise un deploiement dans les clous', async () => {
  const { guards } = newGuards();
  assert.deepEqual(await guards.canDeploy(BigInt(0.15 * SOL)), { allowed: true });
});

test('plafond de depense 24h : bloque le deploiement de trop', async () => {
  const { guards } = newGuards();
  // 2.9 SOL deja depenses sur un plafond de 3.
  await guards.recordDeploy(BigInt(2.9 * SOL));
  const v = await guards.canDeploy(BigInt(0.15 * SOL));
  assert.equal(v.allowed, false);
  assert.equal(v.allowed === false && v.rule, 'daily-spend');
  // Une depense qui rentre encore passe.
  assert.equal((await guards.canDeploy(BigInt(0.05 * SOL))).allowed, true);
});

test('les depenses de plus de 24h sortent de la fenetre', async () => {
  const { store, guards } = newGuards();
  // Evenement date d'il y a 25 h : hors fenetre glissante.
  await store.addEvent('guards:spend', Date.now() - 25 * 3600_000, 2.9 * SOL);
  assert.equal((await guards.canDeploy(BigInt(0.5 * SOL))).allowed, true);
});

test('plafond horaire de lancements', async () => {
  const { guards } = newGuards();
  for (let i = 0; i < 4; i++) await guards.recordDeploy(BigInt(0.01 * SOL));
  const v = await guards.canDeploy(BigInt(0.01 * SOL));
  assert.equal(v.allowed, false);
  assert.equal(v.allowed === false && v.rule, 'hourly-deploys');
});

test('solde minimum : teste le solde PROJETE, pas le courant', async () => {
  // 0.2 SOL en caisse, achat de 0.15 -> il resterait 0.05, sous le plancher
  // de 0.1. Le solde courant seul aurait laisse passer.
  const { guards } = newGuards(0.2);
  const v = await guards.canDeploy(BigInt(0.15 * SOL));
  assert.equal(v.allowed, false);
  assert.equal(v.allowed === false && v.rule, 'min-balance');
});

test('un solde insuffisant arrete le bot definitivement', async () => {
  const { guards } = newGuards(0.2);
  await guards.canDeploy(BigInt(0.15 * SOL));
  assert.equal(guards.isHalted, true);
  // Meme un tout petit achat est desormais refuse : l'arret est a sens unique.
  const v = await guards.canDeploy(BigInt(0.001 * SOL));
  assert.equal(v.allowed === false && v.rule, 'halted');
});

test('halt conserve la premiere raison', async () => {
  const { guards } = newGuards();
  guards.halt('first');
  guards.halt('second');
  const status = await guards.status();
  assert.equal(status.haltReason, 'first');
});

// ---------------------------------------------------------------------------
// Deduplication
// ---------------------------------------------------------------------------

test('la deduplication est atomique et ne laisse passer qu une fois', async () => {
  const store = new MemoryStore();
  const q = new PipelineQueue(store, { analyzerConcurrency: 2, dedupeTtlSeconds: 60 }, log);

  assert.equal(await q.claim('tweet-1'), true);
  assert.equal(await q.claim('tweet-1'), false);
  assert.equal(await q.claim('tweet-2'), true);

  // Rafale concurrente sur le meme id : un seul gagnant.
  const results = await Promise.all(Array.from({ length: 10 }, () => q.claim('burst')));
  assert.equal(results.filter(Boolean).length, 1);
  assert.equal(q.stats.duplicates, 10);
});

test('un signal arrivant pendant un deploiement est abandonne, pas empile', async () => {
  const store = new MemoryStore();
  const q = new PipelineQueue(store, { analyzerConcurrency: 4, dedupeTtlSeconds: 60 }, log);

  let release!: () => void;
  const blocked = new Promise<void>((r) => (release = r));
  const deploy = q.submitDeploy(() => blocked);

  let analyzed = 0;
  q.submitAnalysis(
    { id: 'x', authorId: '1', authorHandle: 'a', text: 't', imageUrls: [], createdAt: Date.now(), isRetweet: false, isReply: false },
    async () => {
      analyzed++;
    },
  );
  assert.equal(analyzed, 0);
  assert.equal(q.stats.rejectedWhileDeploying, 1);

  release();
  await deploy;
});

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const BASE_ENV = {
  DRY_RUN: 'true',
  LISTENER_MODE: 'ws-relay',
  TWITTER_WS_URL: 'wss://relay.invalid',
  WHITELIST_USER_IDS: '44196397',
};

test('loadConfig accepte un environnement minimal en DRY_RUN', () => {
  const cfg = loadConfig({ ...BASE_ENV } as NodeJS.ProcessEnv);
  assert.equal(cfg.dryRun, true);
  assert.equal(cfg.deployerIsEphemeral, true);
  assert.equal(cfg.jito.dryRun, true);
  assert.equal(cfg.initialBuyLamports, BigInt(0.15 * SOL));
  assert.deepEqual(cfg.tiers, [
    { multiplier: 2, sellPct: 33 },
    { multiplier: 3, sellPct: 33 },
    { multiplier: 5, sellPct: 34 },
  ]);
});

test('loadConfig exige les secrets hors DRY_RUN', () => {
  assert.throws(
    () => loadConfig({ ...BASE_ENV, DRY_RUN: 'false' } as NodeJS.ProcessEnv),
    /DEPLOYER_PRIVATE_KEY[\s\S]*LLM_API_KEY/,
  );
});

test('loadConfig refuse le RPC public en mode reel', () => {
  assert.throws(
    () =>
      loadConfig({
        ...BASE_ENV,
        DRY_RUN: 'false',
        DEPLOYER_PRIVATE_KEY: 'x',
        LLM_API_KEY: 'y',
        RPC_URL: 'https://api.mainnet-beta.solana.com',
      } as NodeJS.ProcessEnv),
    /rate-limited and unusable/,
  );
});

test('loadConfig rejette un @handle dans la whitelist', () => {
  assert.throws(
    () => loadConfig({ ...BASE_ENV, WHITELIST_USER_IDS: 'elonmusk' } as NodeJS.ProcessEnv),
    /not a numeric user id/,
  );
});

test('loadConfig refuse un achat unitaire au-dessus du plafond 24h', () => {
  assert.throws(
    () => loadConfig({ ...BASE_ENV, INITIAL_BUY_SOL: '5', MAX_DAILY_SPEND_SOL: '3' } as NodeJS.ProcessEnv),
    /exceeds the 24h spend cap/,
  );
});

test('loadConfig agrege toutes les erreurs en une seule fois', () => {
  try {
    loadConfig({ DRY_RUN: 'true', LISTENER_MODE: 'twitter-api' } as NodeJS.ProcessEnv);
    assert.fail('should have thrown');
  } catch (err) {
    const msg = (err as Error).message;
    // Bearer token manquant ET whitelist vide, signales ensemble.
    assert.match(msg, /TWITTER_BEARER_TOKEN/);
    assert.match(msg, /WHITELIST_USER_IDS/);
  }
});

test('loadConfig valide les paliers de take-profit', () => {
  assert.throws(
    () => loadConfig({ ...BASE_ENV, TAKE_PROFIT_SELL_PCT: '60,60,60' } as NodeJS.ProcessEnv),
    /exceeds 100%/,
  );
});
