/**
 * Accès RPC : création de la connexion, limitation de concurrence et retries.
 *
 * Les endpoints publics renvoient rapidement des erreurs 429 : toutes les
 * requêtes passent par `rpc.call()` qui limite le parallélisme et rejoue les
 * erreurs transitoires avec un backoff exponentiel + jitter.
 */
import { Connection } from '@solana/web3.js';

export interface RpcClientOptions {
  url: string;
  concurrency: number;
  maxRetries: number;
  /**
   * Plafond de requêtes par seconde, pour rester sous la limite des offres
   * gratuites (≈ 10 requêtes/s chez Helius). Sans valeur : pas de plafond.
   */
  maxRps?: number;
}

/** L'analyse a été abandonnée (token quitté) : ses requêtes restantes ne partent pas. */
export class RpcAbortedError extends Error {
  constructor() {
    super('analyse annulée');
    this.name = 'RpcAbortedError';
  }
}

const RATE_LIMITED = /\b429\b|too many requests|rate.?limit/i;

const TRANSIENT_ERROR_PATTERNS = [
  /\b429\b/,
  /too many requests/i,
  /rate limit/i,
  /timed? ?out/i,
  /timeout/i,
  /fetch failed/i,
  /socket hang up/i,
  /ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENOTFOUND/,
  /\b50[234]\b/,
  /service unavailable/i,
  /bad gateway/i,
  /node is behind/i,
];

/** Détermine si une erreur RPC mérite d'être rejouée. */
export function isTransientError(error: unknown): boolean {
  const message = error instanceof Error ? `${error.message} ${String(error.cause ?? '')}` : String(error);
  return TRANSIENT_ERROR_PATTERNS.some((pattern) => pattern.test(message));
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Limiteur de concurrence minimaliste (équivalent de p-limit). */
export function createLimiter(concurrency: number) {
  let active = 0;
  const queue: Array<() => void> = [];

  const next = () => {
    if (active >= concurrency) return;
    const run = queue.shift();
    if (run) {
      active++;
      run();
    }
  };

  return function limit<T>(task: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      queue.push(() => {
        task()
          .then(resolve, reject)
          .finally(() => {
            active--;
            next();
          });
      });
      next();
    });
  };
}

/** État partagé entre un client et ses vues `scoped()` : connexion, limiteur, cadence. */
interface SharedState {
  connection: Connection;
  limit: ReturnType<typeof createLimiter>;
  /** Prochain créneau d'envoi autorisé (ms), pour le plafond de requêtes par seconde. */
  gate: { nextSlot: number };
}

export class RpcClient {
  readonly connection: Connection;
  readonly url: string;
  private readonly limit: ReturnType<typeof createLimiter>;
  private readonly gate: { nextSlot: number };
  private readonly maxRetries: number;
  private readonly minIntervalMs: number;
  private signal?: AbortSignal;
  /** Nombre total d'appels RPC effectués (retries inclus). */
  requestCount = 0;

  constructor(
    private readonly options: RpcClientOptions,
    shared?: SharedState,
  ) {
    this.url = options.url;
    this.connection =
      shared?.connection ??
      new Connection(options.url, {
        commitment: 'confirmed',
        // Les retries sont gérés ici pour éviter les logs bruyants de web3.js.
        disableRetryOnRateLimit: true,
        confirmTransactionInitialTimeout: 60_000,
      });
    this.limit = shared?.limit ?? createLimiter(Math.max(1, options.concurrency));
    this.gate = shared?.gate ?? { nextSlot: 0 };
    this.maxRetries = Math.max(0, options.maxRetries);
    this.minIntervalMs = options.maxRps && options.maxRps > 0 ? 1000 / options.maxRps : 0;
  }

  /**
   * Vue du même client (même limiteur, même plafond de débit) dont les requêtes
   * non encore parties sont abandonnées quand `signal` est annulé : passer d'un
   * token à l'autre ne laisse pas l'ancienne analyse consommer le quota du RPC.
   */
  scoped(signal: AbortSignal): RpcClient {
    const view = new RpcClient(this.options, { connection: this.connection, limit: this.limit, gate: this.gate });
    view.signal = signal;
    return view;
  }

  /** Attend le prochain créneau d'envoi (plafond de requêtes par seconde). */
  private async throttle(): Promise<void> {
    if (!this.minIntervalMs) return;
    const now = Date.now();
    const slot = Math.max(now, this.gate.nextSlot);
    this.gate.nextSlot = slot + this.minIntervalMs;
    if (slot > now) await sleep(slot - now);
  }

  /**
   * Exécute une requête RPC sous le limiteur de concurrence, avec retries
   * exponentiels (500 ms, 1 s, 2 s, 4 s... + jitter) sur erreurs transitoires.
   */
  call<T>(request: (connection: Connection) => Promise<T>): Promise<T> {
    return this.limit(async () => {
      let attempt = 0;
      for (;;) {
        if (this.signal?.aborted) throw new RpcAbortedError();
        await this.throttle();
        if (this.signal?.aborted) throw new RpcAbortedError();
        this.requestCount++;
        try {
          return await request(this.connection);
        } catch (error) {
          if (attempt >= this.maxRetries || !isTransientError(error)) throw error;
          // Limite de débit (429) : on laisse au fournisseur le temps de se remettre (1 s, 2 s, 4 s…).
          const message = error instanceof Error ? error.message : String(error);
          const base = RATE_LIMITED.test(message) ? 1_000 : 500;
          const delay = base * 2 ** attempt + Math.floor(Math.random() * 250);
          attempt++;
          await sleep(delay);
        }
      }
    });
  }
}
