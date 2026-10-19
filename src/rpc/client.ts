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

/** Priorité d'une requête : l'analyse de la page ouverte passe avant les pré-analyses et les suivis. */
export type RpcPriority = 'high' | 'normal' | 'low';
/** Rang de départ de chaque priorité (plus petit = plus tôt) ; une analyse range ses requêtes secondaires juste après. */
const RANK: Record<RpcPriority, number> = { high: 0, normal: 10, low: 20 };

interface Waiter {
  rank: number;
  seq: number;
  start: (release: () => void) => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
}

/**
 * Ordonnanceur partagé par un client et ses vues : nombre maximal de requêtes
 * en vol, plafond de requêtes par seconde, et file par priorité. Sous un
 * plafond de débit (offres gratuites), c'est l'ordre de départ qui décide de
 * ce qui arrive en premier : la page ouverte d'abord.
 */
export class RpcScheduler {
  private readonly queue: Waiter[] = [];
  private seq = 0;
  private active = 0;
  private nextSlot = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** Intervalle courant : ralenti après un refus 429, puis ramené peu à peu au réglage. */
  private intervalMs: number;
  private successes = 0;

  constructor(
    private readonly concurrency: number,
    private readonly minIntervalMs: number,
  ) {
    this.intervalMs = minIntervalMs;
  }

  /** Débit courant, en requêtes par seconde (Infinity sans plafond). */
  get rate(): number {
    return this.intervalMs ? 1000 / this.intervalMs : Infinity;
  }

  /**
   * Refus 429 : le fournisseur tolère moins que prévu. On ralentit tout de suite
   * (−30 %) plutôt que d'enchaîner les refus, qui coûtent chacun une pause.
   */
  penalize(): void {
    if (!this.minIntervalMs) return;
    this.intervalMs = Math.min(this.intervalMs * 1.43, 1_000);
    this.successes = 0;
  }

  /** Réponse obtenue : après 20 succès d'affilée, on regagne 5 % de débit. */
  reward(): void {
    if (this.intervalMs <= this.minIntervalMs || ++this.successes < 20) return;
    this.successes = 0;
    this.intervalMs = Math.max(this.minIntervalMs, this.intervalMs * 0.95);
  }

  /** Attend une place et un créneau de débit ; renvoie la fonction qui libère la place. */
  acquire(rank: number, signal?: AbortSignal): Promise<() => void> {
    return new Promise((resolve, reject) => {
      this.queue.push({ rank, seq: this.seq++, start: resolve, reject, ...(signal ? { signal } : {}) });
      this.pump();
    });
  }

  /** Prochaine requête à partir : rang le plus petit, puis la plus ancienne. */
  private nextIndex(): number {
    let best = -1;
    this.queue.forEach((w, i) => {
      const b = this.queue[best];
      if (!b || w.rank < b.rank || (w.rank === b.rank && w.seq < b.seq)) best = i;
    });
    return best;
  }

  private pump(): void {
    if (this.timer) return;
    while (this.active < this.concurrency) {
      const index = this.nextIndex();
      if (index < 0) return;
      // Analyse annulée pendant l'attente : retirée sans consommer de créneau.
      if (this.queue[index]!.signal?.aborted) {
        this.queue.splice(index, 1)[0]!.reject(new RpcAbortedError());
        continue;
      }
      const now = Date.now();
      if (this.intervalMs && this.nextSlot > now) {
        this.timer = setTimeout(() => {
          this.timer = null;
          this.pump();
        }, this.nextSlot - now);
        return;
      }
      this.nextSlot = Math.max(now, this.nextSlot) + this.intervalMs;
      this.active++;
      let released = false;
      this.queue.splice(index, 1)[0]!.start(() => {
        if (released) return;
        released = true;
        this.active--;
        this.pump();
      });
    }
  }
}

export class RpcClient {
  readonly connection: Connection;
  readonly url: string;
  private readonly scheduler: RpcScheduler;
  private readonly maxRetries: number;
  private signal?: AbortSignal;
  private rank = RANK.normal;
  constructor(
    private readonly options: RpcClientOptions,
    shared?: { connection: Connection; scheduler: RpcScheduler },
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
    this.scheduler =
      shared?.scheduler ??
      new RpcScheduler(Math.max(1, options.concurrency), options.maxRps && options.maxRps > 0 ? 1000 / options.maxRps : 0);
    this.maxRetries = Math.max(0, options.maxRetries);
  }

  /**
   * Vue du même client (même ordonnanceur : même plafond de débit) dont les
   * requêtes non encore parties sont abandonnées quand `signal` est annulé :
   * passer d'un token à l'autre ne laisse pas l'ancienne analyse consommer le
   * quota du RPC. `priority` : priorité par défaut des requêtes de la vue.
   */
  scoped(signal: AbortSignal, priority: RpcPriority = 'normal'): RpcClient {
    const view = new RpcClient(this.options, { connection: this.connection, scheduler: this.scheduler });
    view.signal = signal;
    view.rank = RANK[priority];
    return view;
  }

  /**
   * Vue pour les requêtes secondaires d'une analyse (historique du dev, wallets
   * frais, âge) : elles partent après ses requêtes principales, mais avant celles
   * d'une analyse moins prioritaire. Même annulation, même compteur.
   */
  secondary(): RpcClient {
    const view = new RpcClient(this.options, { connection: this.connection, scheduler: this.scheduler });
    view.signal = this.signal;
    view.rank = this.rank + 1;
    view.counter = this.counter;
    return view;
  }

  /** Compteur partagé entre une vue et ses vues secondaires. */
  private counter = { requests: 0 };

  /** Nombre total d'appels RPC effectués par cette vue et ses vues secondaires (retries inclus). */
  get requestCount(): number {
    return this.counter.requests;
  }

  /**
   * Exécute une requête RPC dans l'ordonnanceur (priorité, concurrence, débit),
   * avec retries exponentiels (500 ms, 1 s, 2 s… + jitter) sur erreurs
   * transitoires ; la place est rendue pendant l'attente d'un retry.
   */
  async call<T>(request: (connection: Connection) => Promise<T>): Promise<T> {
    let attempt = 0;
    for (;;) {
      if (this.signal?.aborted) throw new RpcAbortedError();
      const release = await this.scheduler.acquire(this.rank, this.signal);
      this.counter.requests++;
      try {
        const result = await request(this.connection);
        this.scheduler.reward();
        return result;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // Limite de débit (429) : tout le client ralentit, puis la requête est rejouée.
        if (RATE_LIMITED.test(message)) this.scheduler.penalize();
        if (attempt >= this.maxRetries || !isTransientError(error)) throw error;
        const base = RATE_LIMITED.test(message) ? 600 : 500;
        const delay = base * 2 ** attempt + Math.floor(Math.random() * 250);
        attempt++;
        release();
        await sleep(delay);
        continue;
      } finally {
        release();
      }
    }
  }
}
