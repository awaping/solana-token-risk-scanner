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
}

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

export class RpcClient {
  readonly connection: Connection;
  readonly url: string;
  private readonly limit: ReturnType<typeof createLimiter>;
  private readonly maxRetries: number;
  /** Nombre total d'appels RPC effectués (retries inclus). */
  requestCount = 0;

  constructor(options: RpcClientOptions) {
    this.url = options.url;
    this.connection = new Connection(options.url, {
      commitment: 'confirmed',
      // Les retries sont gérés ici pour éviter les logs bruyants de web3.js.
      disableRetryOnRateLimit: true,
      confirmTransactionInitialTimeout: 60_000,
    });
    this.limit = createLimiter(Math.max(1, options.concurrency));
    this.maxRetries = Math.max(0, options.maxRetries);
  }

  /**
   * Exécute une requête RPC sous le limiteur de concurrence, avec retries
   * exponentiels (500 ms, 1 s, 2 s, 4 s... + jitter) sur erreurs transitoires.
   */
  call<T>(request: (connection: Connection) => Promise<T>): Promise<T> {
    return this.limit(async () => {
      let attempt = 0;
      for (;;) {
        this.requestCount++;
        try {
          return await request(this.connection);
        } catch (error) {
          if (attempt >= this.maxRetries || !isTransientError(error)) throw error;
          const delay = 500 * 2 ** attempt + Math.floor(Math.random() * 250);
          attempt++;
          await sleep(delay);
        }
      }
    });
  }
}
