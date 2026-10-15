/**
 * src/listener/twitterApi.ts
 * ---------------------------------------------------------------------------
 * Flux filtre officiel Twitter/X API v2.
 *
 * A savoir avant de choisir ce mode : le filtered stream exige un plan payant
 * eleve, et les regles de filtrage sont attachees au JETON, pas a la
 * connexion. Deux processus qui partagent le meme bearer token se marchent
 * dessus - d'ou le prefixe de tag ci-dessous, qui permet de ne supprimer que
 * NOS regles et de laisser celles des autres en place.
 *
 * La latence de ce flux est generalement moins bonne qu'un bon relais WS, ce
 * qui explique que `ws-relay` soit le mode par defaut.
 * ---------------------------------------------------------------------------
 */

import { ETwitterStreamEvent, TwitterApi } from 'twitter-api-v2';
import type { TweetStream, TweetV2SingleStreamResult } from 'twitter-api-v2';
import type { Logger } from 'pino';

import type { ListenerConfig } from '../core/config.ts';
import { normalizeTweet } from './normalize.ts';
import type { Listener, TweetHandler } from './types.ts';

/** Prefixe de nos regles : permet de ne toucher qu'aux notres. */
const RULE_TAG_PREFIX = 'memetic-sniper:';

/** Le filtre `from:` accepte un nombre limite de termes par regle. */
const MAX_IDS_PER_RULE = 20;

export class TwitterApiListener implements Listener {
  private readonly cfg: ListenerConfig;
  private readonly log: Logger;
  private readonly client: TwitterApi;

  private stream: TweetStream<TweetV2SingleStreamResult> | undefined;
  private stopped = true;
  private received = 0;

  constructor(cfg: ListenerConfig, logger: Logger) {
    if (!cfg.bearerToken) throw new Error('TwitterApiListener: TWITTER_BEARER_TOKEN is required');
    this.cfg = cfg;
    this.log = logger.child({ module: 'listener:twitter' });
    this.client = new TwitterApi(cfg.bearerToken);
  }

  async start(handler: TweetHandler): Promise<void> {
    this.stopped = false;
    await this.syncRules();

    this.stream = await this.client.v2.searchStream({
      autoConnect: true,
      'tweet.fields': ['created_at', 'author_id', 'referenced_tweets', 'attachments'],
      'user.fields': ['username'],
      'media.fields': ['url', 'preview_image_url', 'type'],
      expansions: ['author_id', 'attachments.media_keys'],
    });

    // Reconnexion geree par la librairie : backoff exponentiel integre, et
    // bien mieux teste qu'une reimplementation maison.
    this.stream.autoReconnect = true;
    this.stream.autoReconnectRetries = Infinity;

    this.stream.on(ETwitterStreamEvent.Data, (payload) => {
      this.received++;
      const tweet = normalizeTweet(payload, { whitelistUserIds: this.cfg.whitelistUserIds });
      if (!tweet) return;
      void Promise.resolve(handler(tweet)).catch((err) =>
        this.log.error({ err, tweetId: tweet.id }, 'tweet handler failed'),
      );
    });

    this.stream.on(ETwitterStreamEvent.ConnectionError, (err) =>
      this.log.error({ err }, 'twitter stream connection error'),
    );
    this.stream.on(ETwitterStreamEvent.ConnectionClosed, () =>
      this.log.warn('twitter stream closed'),
    );
    this.stream.on(ETwitterStreamEvent.Reconnected, () =>
      this.log.info('twitter stream reconnected'),
    );
    this.stream.on(ETwitterStreamEvent.DataKeepAlive, () =>
      this.log.debug('twitter keep-alive'),
    );

    this.log.info({ authors: this.cfg.whitelistUserIds.length }, 'twitter filtered stream started');
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.stream?.close();
    this.stream = undefined;
    this.log.info({ received: this.received }, 'twitter stream stopped');
  }

  /**
   * Remplace nos regles par celles derivees de la whitelist.
   * Idempotent : relancer le bot ne duplique pas les regles.
   */
  private async syncRules(): Promise<void> {
    const existing = await this.client.v2.streamRules();
    const ours = (existing.data ?? []).filter((r) => r.tag?.startsWith(RULE_TAG_PREFIX));
    if (ours.length > 0) {
      await this.client.v2.updateStreamRules({ delete: { ids: ours.map((r) => r.id) } });
      this.log.debug({ deleted: ours.length }, 'cleared previous stream rules');
    }

    const chunks: string[][] = [];
    for (let i = 0; i < this.cfg.whitelistUserIds.length; i += MAX_IDS_PER_RULE) {
      chunks.push(this.cfg.whitelistUserIds.slice(i, i + MAX_IDS_PER_RULE));
    }

    const add = chunks.map((ids, i) => {
      // Les exclusions sont poussees cote serveur : un retweet filtre par
      // Twitter ne consomme ni bande passante, ni quota, ni appel LLM.
      const parts = [`(${ids.map((id) => `from:${id}`).join(' OR ')})`];
      if (this.cfg.ignoreRetweets) parts.push('-is:retweet');
      if (this.cfg.ignoreReplies) parts.push('-is:reply');
      return { value: parts.join(' '), tag: `${RULE_TAG_PREFIX}${i}` };
    });

    if (add.length > 0) {
      const res = await this.client.v2.updateStreamRules({ add });
      if (res.errors?.length) {
        throw new Error(`twitter rejected stream rules: ${JSON.stringify(res.errors)}`);
      }
      this.log.info({ rules: add.length }, 'stream rules installed');
    }
  }
}
