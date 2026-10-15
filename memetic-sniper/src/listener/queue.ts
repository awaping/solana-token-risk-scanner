/**
 * src/listener/queue.ts
 * ---------------------------------------------------------------------------
 * Deduplication et ordonnancement du pipeline.
 *
 * DEUX FILES, DEUX CONCURRENCES, et ce n'est pas un detail :
 *
 *   - File d'ANALYSE, concurrence N. Analyser est une lecture : plusieurs
 *     tweets peuvent etre juges en parallele sans interferer.
 *
 *   - File de DEPLOIEMENT, concurrence 1. Deployer est une ecriture qui
 *     engage des fonds. Deux deploiements simultanes liraient les memes
 *     compteurs de garde-fous avant que l'un ait enregistre sa depense, et
 *     depasseraient le plafond a deux. La serialisation EST le mecanisme qui
 *     rend les garde-fous fiables.
 *
 * DEDUPLICATION : `SET <clé> 1 NX EX <ttl>` est atomique cote Redis. Deux
 * instances du bot qui recoivent le meme tweet ne peuvent pas obtenir `true`
 * toutes les deux - c'est ce qui empeche le double deploiement quand on fait
 * tourner un bot de secours.
 * ---------------------------------------------------------------------------
 */

import PQueue from 'p-queue';
import type { Logger } from 'pino';

import type { TweetSignal } from '../agent/analyzer.ts';
import type { Store } from '../core/store.ts';

export interface PipelineQueueConfig {
  analyzerConcurrency: number;
  dedupeTtlSeconds: number;
}

export interface QueueStats {
  seen: number;
  duplicates: number;
  analyzing: number;
  analysisQueued: number;
  deploying: number;
  deployQueued: number;
  rejectedWhileDeploying: number;
}

export class PipelineQueue {
  private readonly store: Store;
  private readonly cfg: PipelineQueueConfig;
  private readonly log: Logger;

  private readonly analysisQueue: PQueue;
  private readonly deployQueue: PQueue;

  private seen = 0;
  private duplicates = 0;
  private rejectedWhileDeploying = 0;

  constructor(store: Store, cfg: PipelineQueueConfig, logger: Logger) {
    if (!(cfg.analyzerConcurrency >= 1)) {
      throw new Error('PipelineQueue: analyzerConcurrency must be >= 1');
    }
    this.store = store;
    this.cfg = cfg;
    this.log = logger.child({ module: 'queue' });
    this.analysisQueue = new PQueue({ concurrency: cfg.analyzerConcurrency });
    this.deployQueue = new PQueue({ concurrency: 1 });
  }

  /**
   * true si ce tweet n'a jamais ete vu. Coute un aller-retour Redis (~0.2 ms
   * en local) et evite tout le reste du pipeline sur un doublon - c'est le
   * filtre le moins cher de la chaine, donc le premier.
   */
  async claim(tweetId: string): Promise<boolean> {
    this.seen++;
    const fresh = await this.store.setIfAbsent(`tweet:${tweetId}`, this.cfg.dedupeTtlSeconds);
    if (!fresh) {
      this.duplicates++;
      this.log.debug({ tweetId }, 'duplicate tweet dropped');
    }
    return fresh;
  }

  /**
   * Soumet un tweet a l'analyse.
   *
   * Si un deploiement est deja en cours, on n'analyse meme pas : la file de
   * deploiement etant a concurrence 1, le resultat attendrait de toute facon,
   * et un signal qui attend est un signal mort. Mieux vaut l'abandonner tout
   * de suite et economiser l'appel LLM.
   */
  submitAnalysis(tweet: TweetSignal, handler: (t: TweetSignal) => Promise<void>): void {
    if (this.deployQueue.pending > 0 || this.deployQueue.size > 0) {
      this.rejectedWhileDeploying++;
      this.log.info(
        { tweetId: tweet.id, rejected: this.rejectedWhileDeploying },
        'a deploy is already in flight, skipping this signal',
      );
      return;
    }
    void this.analysisQueue.add(async () => {
      try {
        await handler(tweet);
      } catch (err) {
        // Une analyse ratee ne doit jamais tuer la file.
        this.log.error({ err, tweetId: tweet.id }, 'analysis pipeline failed');
      }
    });
  }

  /** Serialise un deploiement. La promesse resout quand il est termine. */
  async submitDeploy<T>(task: () => Promise<T>): Promise<T | undefined> {
    return this.deployQueue.add(task);
  }

  get stats(): QueueStats {
    return {
      seen: this.seen,
      duplicates: this.duplicates,
      analyzing: this.analysisQueue.pending,
      analysisQueued: this.analysisQueue.size,
      deploying: this.deployQueue.pending,
      deployQueued: this.deployQueue.size,
      rejectedWhileDeploying: this.rejectedWhileDeploying,
    };
  }

  /** Vide les files en cours. Utilise a l'arret propre. */
  async drain(timeoutMs = 30_000): Promise<void> {
    this.analysisQueue.clear();
    await Promise.race([
      Promise.all([this.analysisQueue.onIdle(), this.deployQueue.onIdle()]),
      new Promise((r) => setTimeout(r, timeoutMs)),
    ]);
  }
}
