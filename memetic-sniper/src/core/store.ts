/**
 * src/core/store.ts
 * ---------------------------------------------------------------------------
 * Etat partage : deduplication des tweets et compteurs des garde-fous.
 *
 * Deux implementations, et les deux sont utilisees pour de vrai :
 *   - RedisStore  : la production. Les compteurs survivent a un redemarrage,
 *                   ce qui est la raison d'etre d'un plafond de depense - un
 *                   plafond qui se remet a zero a chaque crash ne plafonne rien.
 *   - MemoryStore : les tests et `dryRunPipeline`, pour exercer le pipeline
 *                   complet sans dependre d'un Redis qui tourne.
 *
 * L'interface est volontairement minuscule : trois primitives suffisent a tout
 * ce dont le bot a besoin.
 * ---------------------------------------------------------------------------
 */

import { Redis } from 'ioredis';
import type { Logger } from 'pino';

export interface Store {
  /**
   * Pose une cle si elle n'existe pas. Retourne true si on l'a posee, false
   * si elle existait deja. C'est l'operation ATOMIQUE sur laquelle repose la
   * deduplication : deux instances du bot qui recoivent le meme tweet ne
   * peuvent pas toutes les deux obtenir true.
   */
  setIfAbsent(key: string, ttlSeconds: number): Promise<boolean>;
  /** Ajoute un evenement horodate a une fenetre glissante. */
  addEvent(key: string, at: number, value: number): Promise<void>;
  /** Somme et compte des evenements posterieurs a `since`, purge les plus vieux. */
  windowStats(key: string, since: number): Promise<{ count: number; sum: number }>;
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------

export class RedisStore implements Store {
  private readonly redis: Redis;
  private readonly prefix: string;

  constructor(url: string, prefix: string, logger: Logger) {
    this.prefix = prefix;
    this.redis = new Redis(url, {
      // Le bot doit echouer vite plutot que d'attendre indefiniment un Redis
      // mort pendant qu'un signal passe.
      maxRetriesPerRequest: 2,
      connectTimeout: 3_000,
      lazyConnect: true,
    });
    this.redis.on('error', (err: unknown) => logger.error({ err }, 'redis error'));
  }

  async connect(): Promise<void> {
    await this.redis.connect();
    await this.redis.ping();
  }

  private k(key: string): string {
    return `${this.prefix}${key}`;
  }

  async setIfAbsent(key: string, ttlSeconds: number): Promise<boolean> {
    // SET ... NX EX : pose et expiration en une seule commande atomique.
    const res = await this.redis.set(this.k(key), '1', 'EX', ttlSeconds, 'NX');
    return res === 'OK';
  }

  async addEvent(key: string, at: number, value: number): Promise<void> {
    // Membre unique : deux evenements a la meme milliseconde ne doivent pas
    // s'ecraser l'un l'autre dans le sorted set.
    const member = `${at}:${value}:${Math.random().toString(36).slice(2, 8)}`;
    await this.redis.zadd(this.k(key), at, member);
  }

  async windowStats(key: string, since: number): Promise<{ count: number; sum: number }> {
    const k = this.k(key);
    // Purge d'abord : le sorted set ne grossit pas indefiniment.
    await this.redis.zremrangebyscore(k, '-inf', since - 1);
    const members = await this.redis.zrange(k, 0, -1);
    let sum = 0;
    for (const m of members) {
      const value = Number(m.split(':')[1]);
      if (Number.isFinite(value)) sum += value;
    }
    return { count: members.length, sum };
  }

  async close(): Promise<void> {
    await this.redis.quit().catch(() => this.redis.disconnect());
  }
}

// ---------------------------------------------------------------------------

export class MemoryStore implements Store {
  private readonly keys = new Map<string, number>();
  private readonly events = new Map<string, Array<{ at: number; value: number }>>();

  async setIfAbsent(key: string, ttlSeconds: number): Promise<boolean> {
    const now = Date.now();
    const expiry = this.keys.get(key);
    if (expiry !== undefined && expiry > now) return false;
    this.keys.set(key, now + ttlSeconds * 1000);
    return true;
  }

  async addEvent(key: string, at: number, value: number): Promise<void> {
    const list = this.events.get(key) ?? [];
    list.push({ at, value });
    this.events.set(key, list);
  }

  async windowStats(key: string, since: number): Promise<{ count: number; sum: number }> {
    const kept = (this.events.get(key) ?? []).filter((e) => e.at >= since);
    this.events.set(key, kept);
    return { count: kept.length, sum: kept.reduce((a, e) => a + e.value, 0) };
  }

  async close(): Promise<void> {
    this.keys.clear();
    this.events.clear();
  }
}

/**
 * `memory://` donne un store en memoire, tout le reste ouvre une connexion
 * Redis. Une URL Redis injoignable fait echouer le demarrage : tourner sans
 * deduplication reviendrait a pouvoir deployer deux fois le meme tweet.
 */
export async function createStore(url: string, prefix: string, logger: Logger): Promise<Store> {
  if (url.startsWith('memory://')) {
    logger.warn('using an in-memory store: dedupe and spend caps are lost on restart');
    return new MemoryStore();
  }
  const store = new RedisStore(url, prefix, logger);
  await store.connect();
  logger.info({ url: url.replace(/\/\/.*@/, '//***@') }, 'redis connected');
  return store;
}
