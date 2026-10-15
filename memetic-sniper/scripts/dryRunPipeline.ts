/**
 * scripts/dryRunPipeline.ts
 * ---------------------------------------------------------------------------
 * Injection d'un tweet factice a travers TOUT le pipeline, en DRY_RUN.
 *
 *   Signal -> dedupe -> Analyzer -> Assets -> Bundle Jito (simule)
 *          -> Monitor simule -> decision de sortie -> garde-fous
 *
 * Rien n'est diffuse. Aucun SOL n'est engage. Le store est en memoire, donc
 * aucun Redis n'est requis, et la keypair de deploiement est jetable.
 *
 *   node scripts/dryRunPipeline.ts
 *   MOCK_LLM=true node scripts/dryRunPipeline.ts      # sans cle LLM
 *   TWEET_TEXT="..." node scripts/dryRunPipeline.ts   # signal personnalise
 *
 * MOCK_LLM sert a deux choses : tourner sans cle d'API, et rendre la sortie
 * reproductible - un LLM reel ne donnera pas deux fois le meme ticker, ce qui
 * rend le script inutilisable comme controle de non-regression.
 * ---------------------------------------------------------------------------
 */

import { Connection, Keypair, LAMPORTS_PER_SOL } from '@solana/web3.js';
import pino from 'pino';

import { SemanticAnalyzer, type Analysis, type TweetSignal } from '../src/agent/analyzer.ts';
import { prepareAssets } from '../src/assets/index.ts';
import { loadConfig } from '../src/core/config.ts';
import { Guards } from '../src/core/guards.ts';
import { MemoryStore } from '../src/core/store.ts';
import { PipelineQueue } from '../src/listener/queue.ts';
import { normalizeTweet } from '../src/listener/normalize.ts';
import { JitoBundler } from '../src/solana/jitoBundle.ts';
import { KeypairPool } from '../src/solana/keypairPool.ts';
import {
  MAX_TX_BYTES,
  buildCreateAndBuyTx,
  curvePrice,
  fetchGlobal,
  quoteExactInputSell,
  type BondingCurveState,
} from '../src/solana/pumpfun.ts';
import { decideExit } from '../src/trader/exit.ts';
import { Position } from '../src/trader/position.ts';
import type { CurveSnapshot } from '../src/trader/monitor.ts';

const log = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  transport: { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss.l' } },
});

const MOCK_LLM = process.env.MOCK_LLM === 'true' || !process.env.LLM_API_KEY;
const ELON_ID = '44196397';

/** Payload brut, au format Twitter API v2, tel qu'un vrai flux l'enverrait. */
const MOCK_PAYLOAD = {
  data: {
    id: `dryrun-${Date.now()}`,
    text:
      process.env.TWEET_TEXT ??
      'I just met a gigachad frog at the factory. His name is Gorbo and he is now head of quality control.',
    author_id: ELON_ID,
    created_at: new Date().toISOString(),
  },
  includes: { users: [{ id: ELON_ID, username: 'elonmusk' }] },
};

/** Analyse canonique, utilisee quand le LLM n'est pas sollicite. */
const MOCK_ANALYSIS: Analysis = {
  shouldDeploy: true,
  confidence: 0.91,
  name: 'Gorbo The Frog',
  symbol: 'GORBO',
  description: 'Head of quality control at the factory.',
  imagePrompt: 'cartoon frog in a hard hat holding a clipboard, bold colors, centered, meme style',
  reasoning: 'mocked',
};

const sol = (l: bigint | number) => Number(l) / LAMPORTS_PER_SOL;
const step = (n: number, label: string, fields: object = {}) =>
  log.info(fields, `${n}/7 ${label}`);

async function main(): Promise<void> {
  // DRY_RUN et store memoire forces : ce script ne doit rien pouvoir envoyer,
  // quel que soit le .env de la machine.
  const cfg = loadConfig({
    ...process.env,
    DRY_RUN: 'true',
    LISTENER_MODE: 'none',
    REDIS_URL: 'memory://dry-run',
    WHITELIST_USER_IDS: ELON_ID,
  } as NodeJS.ProcessEnv);

  log.info(
    { mockLlm: MOCK_LLM, deployer: cfg.deployer.publicKey.toBase58(), buySol: sol(cfg.initialBuyLamports) },
    'DRY RUN PIPELINE - nothing will be broadcast',
  );

  const connection = new Connection(cfg.rpcUrl, 'confirmed');
  const store = new MemoryStore();
  const queue = new PipelineQueue(store, cfg.listener, log);
  const guards = new Guards(store, connection, cfg.deployer.publicKey, cfg.guards, log);
  const pool = new KeypairPool({ targetSize: 10 }, log);
  const bundler = new JitoBundler(cfg.jito, connection, log);

  const [, , global] = await Promise.all([pool.start(), bundler.init(), fetchGlobal(connection)]);
  const t0 = Date.now();

  // =========================================================================
  // 1. Ingestion + normalisation
  // =========================================================================
  const tweet = normalizeTweet(MOCK_PAYLOAD, { whitelistUserIds: cfg.listener.whitelistUserIds });
  if (!tweet) throw new Error('mock payload failed normalization - the schema drifted');
  step(1, 'signal normalized', {
    id: tweet.id,
    author: tweet.authorHandle,
    ageMs: Date.now() - tweet.createdAt,
    text: tweet.text.slice(0, 80),
  });

  // =========================================================================
  // 2. Deduplication
  // =========================================================================
  const first = await queue.claim(tweet.id);
  const second = await queue.claim(tweet.id);
  if (!first || second) throw new Error('dedupe is broken: a replay got through');
  step(2, 'dedupe verified', { firstClaim: first, replayClaim: second });

  // =========================================================================
  // 3. Analyse semantique
  // =========================================================================
  const analyzeStart = Date.now();
  let analysis: Analysis;
  if (MOCK_LLM) {
    analysis = MOCK_ANALYSIS;
    log.warn('MOCK_LLM: skipping the real LLM call');
  } else {
    const analyzer = new SemanticAnalyzer(cfg.analyzer, log);
    const result = await analyzer.analyze(tweet as TweetSignal);
    if (!result) {
      log.warn('the analyzer rejected this tweet - pipeline stops here, which is a valid outcome');
      await teardown();
      return;
    }
    analysis = result.analysis;
  }
  step(3, 'analysis', {
    latencyMs: Date.now() - analyzeStart,
    name: analysis.name,
    symbol: analysis.symbol,
    confidence: analysis.confidence,
  });

  // =========================================================================
  // 4. Garde-fous
  // =========================================================================
  const verdict = await guards.canDeploy(cfg.initialBuyLamports);
  step(4, 'guards', { verdict });
  if (!verdict.allowed) {
    // Attendu avec un deployeur jetable a 0 SOL : la barriere fonctionne.
    log.warn(
      { rule: verdict.allowed === false ? verdict.rule : undefined },
      'guards blocked the deploy (expected with an unfunded throwaway deployer) - continuing to exercise the rest',
    );
  }

  // =========================================================================
  // 5. Assets
  // =========================================================================
  const assets = await prepareAssets(analysis, tweet, cfg.assets, log);
  step(5, 'assets ready', {
    totalMs: assets.totalLatencyMs,
    imageSource: assets.image.source,
    imageBytes: assets.image.data.length,
    uploadSource: assets.upload.source,
    metadataUri: assets.metadataUri,
  });

  // =========================================================================
  // 6. Bundle create + buy (simule)
  // =========================================================================
  const { blockhash } = await connection.getLatestBlockhash('confirmed');
  const mint = pool.acquire();
  const built = buildCreateAndBuyTx({
    payer: cfg.deployer,
    mint,
    metadata: { name: analysis.name, symbol: analysis.symbol, uri: assets.metadataUri },
    solBudgetLamports: cfg.initialBuyLamports,
    slippageBps: cfg.slippageBps,
    global,
    recentBlockhash: blockhash,
    computeUnitLimit: cfg.computeUnitLimit,
    computeUnitPriceMicroLamports: cfg.computeUnitPriceMicroLamports,
    tipInstruction: bundler.buildTipInstruction(cfg.deployer.publicKey),
  });
  const submission = await bundler.submitSignedTransactions([built.tx]);
  step(6, 'bundle assembled (dry-run)', {
    mint: mint.publicKey.toBase58(),
    sizeBytes: built.size,
    headroom: MAX_TX_BYTES - built.size,
    tokens: (Number(built.quote.amount) / 1e6).toLocaleString('en-US'),
    tipSol: sol(submission.tipLamports),
    bundleId: submission.bundleId,
    signalToBundleMs: Date.now() - tweet.createdAt,
  });

  // =========================================================================
  // 7. Monitor simule + sorties
  // =========================================================================
  const postBuy: BondingCurveState = {
    virtualSolReserves: global.initialVirtualSolReserves + built.quote.solIntoCurve,
    virtualTokenReserves: global.initialVirtualTokenReserves - built.quote.amount,
    realSolReserves: built.quote.solIntoCurve,
    realTokenReserves: global.initialRealTokenReserves - built.quote.amount,
    tokenTotalSupply: global.tokenTotalSupply,
    complete: false,
    creator: cfg.deployer.publicKey,
  };
  const position = new Position({
    mint: mint.publicKey,
    creator: cfg.deployer.publicKey,
    entrySolLamports: built.quote.maxSolCost,
    tokensBought: built.quote.amount,
    deployedAt: Date.now(),
    tiers: cfg.tiers,
  });

  // Courbe rebatie a chaque palier pour que le prix cote soit le vrai prix -
  // sans cela, toutes les ventes se coteraient contre l'etat post-buy.
  const snapshotAt = (multiple: number, at: number): CurveSnapshot => {
    const price = position.entryPrice * multiple;
    const curve: BondingCurveState = {
      ...postBuy,
      virtualSolReserves: BigInt(Math.round(price * Number(postBuy.virtualTokenReserves))),
    };
    return {
      curve,
      price: curvePrice(curve),
      marketCapLamports: curvePrice(curve) * Number(curve.tokenTotalSupply),
      at,
      lastChangeAt: at,
      source: 'poll',
    };
  };

  const path = [1.0, 1.6, 2.4, 3.3, 5.5, 4.4];
  for (const [i, multiple] of path.entries()) {
    const at = position.deployedAt + (i + 1) * 1000;
    const snap = snapshotAt(multiple, at);
    position.updatePeak(snap.price);
    const decision = decideExit(position, snap, cfg.exit, at);
    if (!decision || decision.tokensToSell === 0n) continue;

    const quote = quoteExactInputSell(
      decision.tokensToSell,
      snap.curve,
      cfg.exit.slippageBps,
      global.feeBasisPoints,
    );
    log.info(
      {
        multiple,
        reason: decision.reason,
        tokens: (Number(decision.tokensToSell) / 1e6).toLocaleString('en-US'),
        receivedSol: sol(quote.netSolOut),
        minSolOutput: sol(quote.minSolOutput),
      },
      'exit',
    );
    position.recordFill(decision.tokensToSell, quote.netSolOut);
    position.markTiersHit(decision.tierIndexes);
  }

  step(7, 'position closed', {
    ...position.snapshot(),
    spentSol: sol(position.entrySolLamports),
    recoveredSol: sol(position.solRecovered),
    realizedPnlSol: sol(position.realizedPnlLamports),
    deRisked: position.isDeRisked,
  });

  log.info(
    { totalPipelineMs: Date.now() - t0, queue: queue.stats, pool: pool.stats },
    'DRY RUN PIPELINE COMPLETE - nothing was broadcast',
  );

  pool.dispose(mint);
  await teardown();

  async function teardown(): Promise<void> {
    pool.stop();
    bundler.close();
    await store.close();
  }
}

main().catch((err) => {
  log.error({ err }, 'dry run pipeline failed');
  process.exitCode = 1;
});
