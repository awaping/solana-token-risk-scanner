/**
 * src/listener/wsRelay.ts
 * ---------------------------------------------------------------------------
 * Client WebSocket generique pour un relais tiers (scraper, TweetScout,
 * serveur local...).
 *
 * DEUX MODES DE PANNE A COUVRIR, et ils ne se ressemblent pas :
 *
 *   1. La socket se ferme. Facile : l'evenement `close` arrive, on reconnecte
 *      avec un backoff exponentiel.
 *
 *   2. La socket reste ouverte mais le serveur ne pousse plus rien. Rien ne se
 *      declenche, le bot croit ecouter, et rate tout. C'est le mode de panne
 *      dangereux. D'ou le heartbeat : un ping periodique, et si aucun pong ni
 *      aucun message n'arrive dans le delai, on considere la connexion morte
 *      et on la recycle de force.
 * ---------------------------------------------------------------------------
 */

import WebSocket from 'ws';
import type { Logger } from 'pino';

import type { TweetSignal } from '../agent/analyzer.ts';
import type { ListenerConfig } from '../core/config.ts';
import { normalizeTweet } from './normalize.ts';
import type { Listener, TweetHandler } from './types.ts';

const PING_INTERVAL_MS = 20_000;
/** Sans le moindre trafic pendant ce delai, la connexion est jugee morte. */
const SILENCE_TIMEOUT_MS = 60_000;
const MAX_BACKOFF_MS = 30_000;

export class WsRelayListener implements Listener {
  private readonly cfg: ListenerConfig;
  private readonly log: Logger;

  private ws: WebSocket | undefined;
  private handler: TweetHandler | undefined;
  private stopped = true;
  private attempt = 0;
  private lastMessageAt = 0;
  private pingTimer: NodeJS.Timeout | undefined;
  private reconnectTimer: NodeJS.Timeout | undefined;

  private received = 0;
  private normalized = 0;

  constructor(cfg: ListenerConfig, logger: Logger) {
    if (!cfg.wsUrl) throw new Error('WsRelayListener: TWITTER_WS_URL is required');
    this.cfg = cfg;
    this.log = logger.child({ module: 'listener:ws' });
  }

  async start(handler: TweetHandler): Promise<void> {
    this.handler = handler;
    this.stopped = false;
    this.connect();
    this.pingTimer = setInterval(() => this.heartbeat(), PING_INTERVAL_MS);
    this.pingTimer.unref();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.pingTimer = undefined;
    this.reconnectTimer = undefined;
    // `close()` attend un handshake ; on ne veut pas bloquer l'arret dessus.
    this.ws?.terminate();
    this.ws = undefined;
    this.log.info({ received: this.received, normalized: this.normalized }, 'ws relay stopped');
  }

  private connect(): void {
    if (this.stopped) return;
    const url = this.cfg.wsUrl as string;
    this.log.info({ url, attempt: this.attempt }, 'connecting to ws relay');

    const ws = new WebSocket(url, {
      headers: this.cfg.wsApiKey
        ? { authorization: `Bearer ${this.cfg.wsApiKey}`, 'x-api-key': this.cfg.wsApiKey }
        : {},
      handshakeTimeout: 10_000,
    });
    this.ws = ws;

    ws.on('open', () => {
      this.attempt = 0;
      this.lastMessageAt = Date.now();
      this.log.info('ws relay connected');
      // Beaucoup de relais attendent un message d'abonnement explicite.
      // Inoffensif pour ceux qui n'en veulent pas : ils l'ignorent.
      if (this.cfg.whitelistUserIds.length > 0) {
        ws.send(
          JSON.stringify({ action: 'subscribe', user_ids: this.cfg.whitelistUserIds }),
          (err) => {
            if (err) this.log.warn({ err }, 'subscribe frame failed');
          },
        );
      }
    });

    ws.on('message', (raw) => {
      this.lastMessageAt = Date.now();
      this.received++;
      let payload: unknown;
      try {
        payload = JSON.parse(raw.toString());
      } catch {
        // Keepalive texte ou trame binaire : rien d'anormal.
        this.log.debug('non-JSON frame ignored');
        return;
      }
      // Certains relais encapsulent dans { type, data }.
      const candidates = [payload, (payload as { data?: unknown })?.data].filter(Boolean);
      for (const candidate of candidates) {
        const tweet = normalizeTweet(candidate, { whitelistUserIds: this.cfg.whitelistUserIds });
        if (tweet) {
          this.normalized++;
          this.dispatch(tweet);
          return;
        }
      }
    });

    ws.on('pong', () => {
      this.lastMessageAt = Date.now();
    });

    ws.on('error', (err) => this.log.error({ err }, 'ws relay error'));

    ws.on('close', (code, reason) => {
      this.log.warn({ code, reason: reason.toString() }, 'ws relay closed');
      this.scheduleReconnect();
    });
  }

  private dispatch(tweet: TweetSignal): void {
    // Le handler ne doit jamais bloquer la boucle de reception : une erreur
    // en aval ne doit pas faire perdre la connexion.
    void Promise.resolve(this.handler?.(tweet)).catch((err) =>
      this.log.error({ err, tweetId: tweet.id }, 'tweet handler failed'),
    );
  }

  private heartbeat(): void {
    if (this.stopped || !this.ws) return;
    const silentFor = Date.now() - this.lastMessageAt;
    if (silentFor > SILENCE_TIMEOUT_MS) {
      this.log.error({ silentFor }, 'ws relay went silent, forcing a reconnect');
      this.ws.terminate(); // Declenche `close`, donc la reconnexion.
      return;
    }
    if (this.ws.readyState === WebSocket.OPEN) this.ws.ping();
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    // Backoff exponentiel plafonne, avec jitter : evite que plusieurs
    // instances ne se reconnectent toutes a la meme seconde.
    const delay = Math.min(MAX_BACKOFF_MS, 500 * 2 ** this.attempt) + Math.random() * 500;
    this.attempt++;
    this.log.info({ delay, attempt: this.attempt }, 'scheduling ws reconnect');
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.connect();
    }, delay);
    this.reconnectTimer.unref();
  }
}
