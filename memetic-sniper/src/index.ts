/**
 * src/index.ts
 * ---------------------------------------------------------------------------
 * Orchestrateur. Cable le pipeline et gere le cycle de vie du processus.
 *
 *   TweetSignal -> dedupe -> Analyzer -> Assets -> Bundle Jito (create+buy)
 *                                                      |
 *                                                      v
 *                                        Monitor + Exit, en tache de fond
 *
 * REGLE STRUCTURANTE : une position ouverte ne bloque JAMAIS l'ecoute.
 * Le suivi et la vente tournent dans une tache detachee ; le pipeline
 * d'ingestion reste disponible pour le signal suivant. Les positions actives
 * sont tenues dans une Map pour pouvoir toutes les fermer proprement a l'arret.
 *
 * Une seule chose est serialisee : le deploiement lui-meme (file a
 * concurrence 1), parce que c'est ce qui rend les garde-fous fiables.
 * ---------------------------------------------------------------------------
 */

import { Connection, Keypair, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';
import 'dotenv/config';
import pino from 'pino';
import type { Logger } from 'pino';

import { SemanticAnalyzer, type TweetSignal } from './agent/analyzer.ts';
import { prepareAssets } from './assets/index.ts';
import { type AppConfig, loadConfig } from './core/config.ts';
import { Guards } from './core/guards.ts';
import { type Store, createStore } from './core/store.ts';
import { createListener } from './listener/index.ts';
import { PipelineQueue } from './listener/queue.ts';
import type { Listener } from './listener/types.ts';
import { JitoBundler } from './solana/jitoBundle.ts';
import { KeypairPool } from './solana/keypairPool.ts';
import {
  type PumpGlobal,
  buildCreateAndBuyTx,
  fetchBondingCurve,
  fetchGlobal,
} from './solana/pumpfun.ts';
import { ExitExecutor, decideExit } from './trader/exit.ts';
import { startAutoClaim } from './trader/fees.ts';
import { CurveMonitor } from './trader/monitor.ts';
import { Position } from './trader/position.ts';

export class MemeticSniper {
  private readonly cfg: AppConfig;
  private readonly log: Logger;
  private readonly connection: Connection;

  private store!: Store;
  private guards!: Guards;
  private pool!: KeypairPool;
  private bundler!: JitoBundler;
  private analyzer!: SemanticAnalyzer;
  private queue!: PipelineQueue;
  private listener!: Listener;
  private global!: PumpGlobal;
  private stopAutoClaim: (() => void) | undefined;

  /** Positions ouvertes, indexees par mint. Sert a tout fermer a l'arret. */
  private readonly active = new Map<string, { position: Position; monitor: CurveMonitor }>();
  private shuttingDown = false;

  constructor(cfg: AppConfig, logger: Logger) {
    this.cfg = cfg;
    this.log = logger;
    this.connection = new Connection(cfg.rpcUrl, {
      commitment: 'confirmed',
      // Un WS explicite evite que web3.js le derive mal d'une URL a query string.
      ...(cfg.rpcUrl.startsWith('http')
        ? { wsEndpoint: cfg.rpcUrl.replace(/^http/, 'ws') }
        : {}),
    });
  }

  // -------------------------------------------------------------------------
  // Demarrage
  // -------------------------------------------------------------------------

  async start(): Promise<void> {
    this.log.info(
      { dryRun: this.cfg.dryRun, mode: this.cfg.listener.mode, rpc: redact(this.cfg.rpcUrl) },
      'MemeticSniper starting',
    );
    if (this.cfg.deployerIsEphemeral) {
      this.log.warn('no DEPLOYER_PRIVATE_KEY: running with a throwaway keypair');
    }

    this.store = await createStore(this.cfg.redisUrl, this.cfg.redisKeyPrefix, this.log);
    this.analyzer = new SemanticAnalyzer(this.cfg.analyzer, this.log);
    this.queue = new PipelineQueue(this.store, this.cfg.listener, this.log);
    this.guards = new Guards(
      this.store,
      this.connection,
      this.cfg.deployer.publicKey,
      this.cfg.guards,
      this.log,
    );

    this.pool = new KeypairPool(this.cfg.keypairPool, this.log);
    this.bundler = new JitoBundler(this.cfg.jito, this.connection, this.log);

    // Prechauffage : pool de mints, clients gRPC Jito et parametres pump sont
    // independants -> en parallele. C'est du temps gagne une seule fois, mais
    // rien n'oblige a le perdre.
    const [, , global] = await Promise.all([
      this.pool.start(),
      this.bundler.init(),
      fetchGlobal(this.connection),
    ]);
    this.global = global;
    this.log.info(
      {
        feeRecipient: global.feeRecipient.toBase58(),
        feeBps: global.feeBasisPoints.toString(),
        poolSize: this.pool.size,
        tipLamports: this.bundler.tipLamports,
      },
      'engine warmed up',
    );

    const status = await this.guards.status();
    this.log.info(
      {
        balanceSol: status.balanceLamports / LAMPORTS_PER_SOL,
        spent24hSol: status.spentLast24hLamports / LAMPORTS_PER_SOL,
        deploys1h: status.deploysLastHour,
      },
      'guards status',
    );

    if (this.cfg.autoClaimFees && !this.cfg.dryRun) {
      this.stopAutoClaim = startAutoClaim(
        this.connection,
        this.cfg.deployer,
        this.cfg.claimFeesIntervalMs,
        this.log,
        this.cfg.feeClaim,
      );
    }

    this.listener = createListener(this.cfg.listener, this.log);
    await this.listener.start((tweet) => this.onTweet(tweet));
    this.log.info('listening');
  }

  // -------------------------------------------------------------------------
  // Pipeline
  // -------------------------------------------------------------------------

  /**
   * Point d'entree d'un signal. Volontairement court et non bloquant : la
   * deduplication est le seul travail synchrone, tout le reste part en file.
   */
  async onTweet(tweet: TweetSignal): Promise<void> {
    if (this.shuttingDown) return;
    if (this.guards.isHalted) return;

    // Filtre le moins cher de la chaine, donc le premier.
    if (!(await this.queue.claim(tweet.id))) return;

    this.queue.submitAnalysis(tweet, (t) => this.analyzeAndMaybeDeploy(t));
  }

  private async analyzeAndMaybeDeploy(tweet: TweetSignal): Promise<void> {
    const result = await this.analyzer.analyze(tweet);
    if (!result) return;

    // Le controle des garde-fous est refait DANS la file de deploiement, apres
    // serialisation : le verifier ici seulement laisserait passer deux signaux
    // arrives ensemble.
    await this.queue.submitDeploy(() => this.deploy(tweet, result.analysis));
  }

  private async deploy(
    tweet: TweetSignal,
    analysis: import('./agent/analyzer.ts').Analysis,
  ): Promise<void> {
    const log = this.log.child({ tweetId: tweet.id, symbol: analysis.symbol });
    const startedAt = Date.now();

    const verdict = await this.guards.canDeploy(this.cfg.initialBuyLamports);
    if (!verdict.allowed) {
      log.warn({ rule: verdict.rule, detail: verdict.detail }, 'deploy blocked by guards');
      return;
    }

    // Les assets et le blockhash sont independants -> en parallele. Le
    // blockhash est la donnee la plus perissable, on la prend au plus tard.
    const [assets, latest] = await Promise.all([
      prepareAssets(analysis, tweet, this.cfg.assets, this.log),
      this.connection.getLatestBlockhash('confirmed'),
    ]);

    const mint = this.pool.acquire();
    const built = buildCreateAndBuyTx({
      payer: this.cfg.deployer,
      mint,
      metadata: { name: analysis.name, symbol: analysis.symbol, uri: assets.metadataUri },
      solBudgetLamports: this.cfg.initialBuyLamports,
      slippageBps: this.cfg.slippageBps,
      global: this.global,
      recentBlockhash: latest.blockhash,
      computeUnitLimit: this.cfg.computeUnitLimit,
      computeUnitPriceMicroLamports: this.cfg.computeUnitPriceMicroLamports,
      tipInstruction: this.bundler.buildTipInstruction(this.cfg.deployer.publicKey),
    });

    log.info(
      {
        mint: mint.publicKey.toBase58(),
        sizeBytes: built.size,
        tokens: Number(built.quote.amount) / 1e6,
        budgetSol: Number(this.cfg.initialBuyLamports) / LAMPORTS_PER_SOL,
        signalToBundleMs: Date.now() - tweet.createdAt,
        pipelineMs: Date.now() - startedAt,
      },
      'submitting deploy bundle',
    );

    const submission = await this.bundler.submitSignedTransactions([built.tx]);
    const outcome = await this.bundler.waitForLanded(submission.bundleId);

    if (outcome.status !== 'landed') {
      log.error({ bundleId: submission.bundleId, outcome }, 'deploy bundle did not land');
      this.pool.dispose(mint);
      return;
    }

    await this.guards.recordDeploy(this.cfg.initialBuyLamports);

    if (this.cfg.dryRun) {
      log.warn('DRY_RUN: skipping position management');
      this.pool.dispose(mint);
      return;
    }

    // Reconciliation : on ouvre la position sur ce qu'on a RECU, pas sur ce
    // qu'on a demande.
    const ata = getAssociatedTokenAddressSync(mint.publicKey, this.cfg.deployer.publicKey, false);
    const [balance, curve] = await Promise.all([
      this.connection.getTokenAccountBalance(ata, 'confirmed'),
      fetchBondingCurve(this.connection, mint.publicKey),
    ]);
    const tokensBought = BigInt(balance.value.amount);
    if (tokensBought === 0n) {
      log.error('bundle landed but no tokens were received - not opening a position');
      this.pool.dispose(mint);
      return;
    }

    const position = new Position({
      mint: mint.publicKey,
      creator: curve.creator,
      entrySolLamports: built.quote.maxSolCost,
      tokensBought,
      deployedAt: Date.now(),
      tiers: this.cfg.tiers,
    });

    // La cle du mint a signe, elle ne sert plus a rien : on l'efface.
    this.pool.dispose(mint);

    // Detache : le suivi ne doit pas retenir la file de deploiement.
    void this.managePosition(position).catch((err) =>
      log.error({ err }, 'position management crashed'),
    );

    log.info(
      {
        mint: mint.publicKey.toBase58(),
        tokens: Number(tokensBought) / 1e6,
        entryPrice: position.entryPrice,
        totalMs: Date.now() - startedAt,
      },
      'position opened',
    );
  }

  // -------------------------------------------------------------------------
  // Suivi de position
  // -------------------------------------------------------------------------

  /**
   * Suit une position jusqu'a sa fermeture. Tourne en tache detachee.
   *
   * L'execution des sorties est deleguee a `ExitExecutor`, qui porte deja le
   * verrou anti-double-vente : le monitor peut donc declencher plusieurs fois
   * pendant qu'une vente est en vol sans causer de degat.
   */
  private async managePosition(position: Position): Promise<void> {
    const key = position.mint.toBase58();
    const log = this.log.child({ mint: key });
    const monitor = new CurveMonitor(
      this.connection,
      position.mint,
      { pollIntervalMs: this.cfg.monitorPollIntervalMs },
      this.log,
    );
    const executor = new ExitExecutor(
      this.connection,
      this.bundler,
      this.cfg.deployer,
      this.global,
      this.cfg.exit,
      this.log,
    );
    this.active.set(key, { position, monitor });

    try {
      await monitor.start((snapshot) => {
        if (position.closed || position.selling) return;
        position.updatePeak(snapshot.price);
        const decision = decideExit(position, snapshot, this.cfg.exit);
        if (!decision) return;

        void executor
          .execute(position, snapshot, decision)
          .then((result) => {
            if (position.closed || decision.reason === 'curve-complete') void this.close(key);
          })
          .catch((err) => log.error({ err }, 'exit execution failed'));
      });

      // Attend la fermeture. Le monitor pousse les evenements ; cette boucle ne
      // fait qu'observer l'etat, sans consommer de quota RPC.
      while (!position.closed && !this.shuttingDown) {
        await new Promise((r) => setTimeout(r, 500));
      }
    } finally {
      await this.close(key);
      log.info(
        {
          ...position.snapshot(),
          realizedPnlSol: Number(position.realizedPnlLamports) / LAMPORTS_PER_SOL,
        },
        'position closed',
      );
    }
  }

  private async close(key: string): Promise<void> {
    const entry = this.active.get(key);
    if (!entry) return;
    this.active.delete(key);
    await entry.monitor.stop();
  }

  // -------------------------------------------------------------------------
  // Arret propre
  // -------------------------------------------------------------------------

  /**
   * Coupe l'ingestion d'abord, libere ensuite.
   *
   * Ordre voulu : arreter d'accepter de nouveaux signaux avant de fermer quoi
   * que ce soit, sinon un tweet arrive pendant l'arret trouverait un bundler
   * a moitie ferme. Les positions ouvertes ne sont PAS liquidees de force -
   * vendre dans la panique d'un SIGTERM est le meilleur moyen de sortir au
   * pire prix. Elles sont journalisees pour reprise manuelle.
   */
  async shutdown(): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    this.log.info('shutting down');

    await this.listener?.stop().catch((err) => this.log.error({ err }, 'listener stop failed'));
    this.stopAutoClaim?.();
    await this.queue?.drain(10_000);

    if (this.active.size > 0) {
      this.log.warn(
        {
          open: [...this.active.values()].map((e) => ({
            mint: e.position.mint.toBase58(),
            tokensRemaining: e.position.tokensRemaining.toString(),
            entrySol: Number(e.position.entrySolLamports) / LAMPORTS_PER_SOL,
          })),
        },
        'positions still open - NOT liquidated on shutdown, resume them manually',
      );
    }
    for (const key of [...this.active.keys()]) await this.close(key);

    this.pool?.stop();
    this.bundler?.close();
    await this.store?.close();
    this.log.info({ queue: this.queue?.stats }, 'shutdown complete');
  }
}

const redact = (url: string) => url.replace(/api-key=[^&]+/, 'api-key=***');

// ---------------------------------------------------------------------------
// Entree processus
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const cfg = loadConfig();
  const logger = pino({
    level: cfg.logLevel,
    ...(cfg.nodeEnv === 'production'
      ? {}
      : { transport: { target: 'pino-pretty', options: { colorize: true } } }),
  });

  const bot = new MemeticSniper(cfg, logger);

  let stopping = false;
  const stop = (signal: string) => {
    if (stopping) {
      logger.warn({ signal }, 'second signal received, exiting immediately');
      process.exit(1);
    }
    stopping = true;
    logger.info({ signal }, 'signal received');
    void bot.shutdown().then(
      () => process.exit(0),
      (err) => {
        logger.error({ err }, 'shutdown failed');
        process.exit(1);
      },
    );
  };
  process.on('SIGINT', () => stop('SIGINT'));
  process.on('SIGTERM', () => stop('SIGTERM'));

  // Une exception non capturee laisserait le bot dans un etat indetermine avec
  // potentiellement une position ouverte : on arrete proprement plutot que de
  // continuer a l'aveugle.
  process.on('unhandledRejection', (err) => {
    logger.error({ err }, 'unhandled rejection');
    stop('unhandledRejection');
  });
  process.on('uncaughtException', (err) => {
    logger.fatal({ err }, 'uncaught exception');
    stop('uncaughtException');
  });

  await bot.start();
}

// Ne s'execute que lance directement, pas quand le module est importe par un
// script ou un test.
if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}`) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
