/**
 * Sources de logs EVM pour le mode stream.
 *
 *   WebSocket  eth_subscribe("logs") : poussée en temps réel (la plus rapide) ;
 *              plusieurs endpoints sont mis en course
 *   HTTP       eth_blockNumber + eth_getLogs à chaque nouveau bloc : source
 *              principale sans WebSocket, sinon relais en veille qui prend le
 *              suivi en charge si tous les WebSocket tombent
 *
 * Le filtre porte uniquement sur les signatures d'événements (créations de
 * pool et swaps), sans filtre d'adresse : toutes les DEX compatibles Uniswap
 * v2/v3/v4 ou Solidly de la chaîne sont couvertes, forks inconnus compris.
 */
import WebSocket from 'ws';
import type { StatusHandler } from '../stream/sources/types.js';
import { ALL_TOPICS, type EvmLog } from './events.js';

export type EvmLogHandler = (log: EvmLog) => void;

export interface EvmSource {
  readonly name: string;
  start(onLog: EvmLogHandler, onStatus: StatusHandler): Promise<void>;
  stop(): Promise<void>;
}

interface RpcLog {
  address?: string;
  topics?: string[];
  data?: string;
  blockNumber?: string;
  transactionHash?: string;
  logIndex?: string;
  removed?: boolean;
}

const hexToNumber = (hex: string | undefined) => (hex ? Number.parseInt(hex, 16) : 0);

/** Convertit un log JSON-RPC en EvmLog ; null s'il est incomplet. */
export function toEvmLog(raw: RpcLog, source: string, receivedAt: bigint): EvmLog | null {
  if (!raw.address || !raw.topics?.length || !raw.transactionHash) return null;
  return {
    address: raw.address.toLowerCase(),
    topics: raw.topics.map((t) => t.toLowerCase()),
    data: raw.data ?? '0x',
    blockNumber: hexToNumber(raw.blockNumber),
    transactionHash: raw.transactionHash.toLowerCase(),
    logIndex: hexToNumber(raw.logIndex),
    removed: raw.removed,
    source,
    receivedAt,
  };
}

const hostOf = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

// ---------------------------------------------------------------------------
// WebSocket
// ---------------------------------------------------------------------------

export class EvmWebSocketSource implements EvmSource {
  readonly name: string;
  private ws?: WebSocket;
  private stopped = false;
  private subscribed = false;
  private failed = false;
  private backoffMs = 250;
  private lastError = '';
  private pingTimer?: NodeJS.Timeout;
  private idleTimer?: NodeJS.Timeout;

  constructor(
    private readonly url: string,
    /** Reconnexion si aucun log n'arrive pendant ce délai (abonnement mort sans coupure). */
    private readonly idleTimeoutMs = 180_000,
  ) {
    this.name = `ws:${hostOf(url)}`;
  }

  /** Connecté et abonné : les logs arrivent par cette source. */
  get healthy(): boolean {
    return this.subscribed && this.ws?.readyState === WebSocket.OPEN;
  }

  /** Première connexion encore en cours (ni abonnée, ni en échec). */
  get pending(): boolean {
    return !this.subscribed && !this.failed;
  }

  async start(onLog: EvmLogHandler, onStatus: StatusHandler): Promise<void> {
    this.stopped = false;
    this.connect(onLog, onStatus);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearInterval(this.pingTimer);
    clearTimeout(this.idleTimer);
    this.ws?.terminate();
  }

  private armIdle(onStatus: StatusHandler) {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      onStatus(this.name, `aucun log depuis ${this.idleTimeoutMs / 1000} s, reconnexion`, 'warn');
      this.ws?.terminate();
    }, this.idleTimeoutMs);
  }

  /** Signale une erreur une seule fois tant qu'elle se répète (endpoint refusé, hors ligne…). */
  private reportError(onStatus: StatusHandler, message: string) {
    this.failed = true;
    if (message === this.lastError) return;
    this.lastError = message;
    onStatus(this.name, `erreur : ${message}`, 'warn');
  }

  private connect(onLog: EvmLogHandler, onStatus: StatusHandler) {
    if (this.stopped) return;
    const ws = new WebSocket(this.url, { perMessageDeflate: false, handshakeTimeout: 10_000 });
    this.ws = ws;
    let awaitingPong = false;

    ws.on('open', () => {
      ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_subscribe', params: ['logs', { topics: [ALL_TOPICS] }] }));
      this.pingTimer = setInterval(() => {
        if (awaitingPong) {
          ws.terminate();
          return;
        }
        awaitingPong = true;
        ws.ping();
      }, 15_000);
      this.armIdle(onStatus);
    });
    ws.on('pong', () => {
      awaitingPong = false;
    });

    ws.on('message', (raw: WebSocket.RawData) => {
      const receivedAt = process.hrtime.bigint();
      let msg: { id?: number; method?: string; result?: unknown; error?: { message?: string }; params?: { result?: RpcLog } };
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (msg.method === 'eth_subscription') {
        const log = msg.params?.result ? toEvmLog(msg.params.result, this.name, receivedAt) : null;
        if (!log) return;
        this.armIdle(onStatus);
        onLog(log);
      } else if (msg.id === 1) {
        if (msg.error) {
          this.reportError(onStatus, `abonnement refusé : ${msg.error.message ?? 'erreur inconnue'}`);
          ws.close();
        } else {
          this.subscribed = true;
          this.failed = false;
          this.backoffMs = 250;
          this.lastError = '';
          onStatus(this.name, 'abonné aux créations de pool et aux swaps', 'info');
        }
      }
    });

    ws.on('error', (error: Error) => this.reportError(onStatus, error.message));
    ws.on('close', () => {
      const wasHealthy = this.subscribed;
      this.subscribed = false;
      this.failed = true;
      clearInterval(this.pingTimer);
      clearTimeout(this.idleTimer);
      if (this.stopped) return;
      const delay = this.backoffMs;
      // Endpoint indisponible : les tentatives s'espacent jusqu'à 30 s, sans répéter le message.
      this.backoffMs = Math.min(this.backoffMs * 2, 30_000);
      if (wasHealthy) onStatus(this.name, `connexion perdue, nouvelle tentative dans ${delay} ms`, 'warn');
      setTimeout(() => this.connect(onLog, onStatus), delay);
    });
  }
}

// ---------------------------------------------------------------------------
// HTTP (interrogation)
// ---------------------------------------------------------------------------

export interface HttpPollingOptions {
  /** Endpoints HTTP, par ordre de préférence : bascule sur le suivant en cas d'échec. */
  urls: string[];
  /** Intervalle d'interrogation (ms), aligné sur le temps de bloc de la chaîne. */
  pollMs: number;
  /** Nombre maximal de blocs par requête eth_getLogs. */
  maxRange?: number;
  /**
   * Mode relais : tant que cette fonction renvoie true (un WebSocket fonctionne),
   * l'interrogation est suspendue pour ne pas consommer le quota du RPC.
   */
  standby?: () => boolean;
  /** Dernier bloc déjà reçu (par une autre source), pour reprendre sans trou. */
  lastSeenBlock?: () => number;
}

/** Erreurs d'un endpoint (réseau, HTTP, RPC) qui justifient de passer au suivant. */
const RANGE_ERROR = /range|limit|too (many|large)|exceed/i;
/** Retard maximal rattrapé à la reprise (blocs). */
const MAX_CATCH_UP = 200;

export class EvmHttpPollingSource implements EvmSource {
  private stopped = false;
  private timer?: NodeJS.Timeout;
  private nextBlock = -1;
  private range: number;
  private requestId = 1;
  private current = 0;
  private failures = 0;
  private errorStreak = 0;
  private lastError = '';
  private mode: 'init' | 'active' | 'standby' = 'init';

  constructor(private readonly opts: HttpPollingOptions) {
    if (opts.urls.length === 0) throw new Error('aucun endpoint HTTP');
    this.range = opts.maxRange ?? 50;
  }

  get name(): string {
    return `http:${hostOf(this.opts.urls[this.current]!)}`;
  }

  private async rpc<T>(method: string, params: unknown[]): Promise<T> {
    const response = await fetch(this.opts.urls[this.current]!, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: this.requestId++, method, params }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = (await response.json()) as { result?: T; error?: { message?: string } };
    if (body.error) throw new Error(body.error.message ?? 'erreur RPC');
    return body.result as T;
  }

  /** Passe à l'endpoint suivant de la liste ; false s'il n'y en a qu'un. */
  private rotate(onStatus: StatusHandler, reason: string): boolean {
    if (this.opts.urls.length < 2) return false;
    const from = this.name;
    this.current = (this.current + 1) % this.opts.urls.length;
    this.failures = 0;
    this.range = this.opts.maxRange ?? 50;
    onStatus(from, `${reason} : bascule sur ${this.name}`, 'warn');
    return true;
  }

  private async latestBlock(): Promise<number> {
    return hexToNumber(await this.rpc<string>('eth_blockNumber', []));
  }

  async start(onLog: EvmLogHandler, onStatus: StatusHandler): Promise<void> {
    this.stopped = false;
    // Premier endpoint joignable de la liste.
    let latest = -1;
    let lastError = '';
    for (let i = 0; i < this.opts.urls.length && latest < 0; i++) {
      try {
        latest = await this.latestBlock();
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
        if (!this.rotate(onStatus, `injoignable (${lastError})`)) break;
      }
    }
    if (latest < 0) {
      // Source principale : échec immédiat. Relais : les WebSocket peuvent suffire, nouvel essai plus tard.
      if (!this.opts.standby) throw new Error(`aucun endpoint HTTP joignable (${lastError})`);
      onStatus(this.name, `aucun endpoint HTTP joignable pour l'instant (${lastError}) : nouvel essai si les WebSocket tombent`, 'warn');
    }
    // On démarre au bloc courant : pas d'historique, uniquement ce qui arrive.
    this.nextBlock = latest + 1;
    if (latest >= 0 && this.opts.standby) {
      onStatus(this.name, `relais HTTP prêt (${this.opts.urls.length} endpoint${this.opts.urls.length > 1 ? 's' : ''}), en veille tant qu'un WebSocket fonctionne`, 'info');
    } else if (latest >= 0) {
      this.mode = 'active';
      onStatus(this.name, `interrogation toutes les ${this.opts.pollMs} ms à partir du bloc ${this.nextBlock}`, 'info');
    }

    const loop = async () => {
      if (this.stopped) return;
      let delay = this.opts.pollMs;
      try {
        if (this.opts.standby?.()) {
          if (this.mode === 'active') onStatus(this.name, 'WebSocket rétabli : interrogation HTTP en veille', 'info');
          this.mode = 'standby';
          delay = 1_000;
        } else {
          if (this.mode !== 'active') await this.activate(onStatus);
          await this.poll(onLog);
          this.failures = 0;
          this.errorStreak = 0;
          this.lastError = '';
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (RANGE_ERROR.test(message) && this.range > 1) {
          this.range = Math.max(1, Math.floor(this.range / 2));
        } else {
          // Endpoints en panne : les essais s'espacent (jusqu'à 30 s) et une erreur répétée n'est affichée qu'une fois.
          this.errorStreak++;
          delay = Math.min(this.opts.pollMs * 2 ** Math.min(this.errorStreak, 8), 30_000);
          if (++this.failures >= 2 && this.rotate(onStatus, message)) {
            // l'endpoint suivant prend le relais au prochain tour
          } else if (message !== this.lastError) {
            onStatus(this.name, `erreur : ${message}`, 'warn');
          }
          this.lastError = message;
        }
      }
      if (!this.stopped) this.timer = setTimeout(loop, delay);
    };
    this.timer = setTimeout(loop, 0);
  }

  /** Sortie de veille : reprise juste après le dernier bloc reçu, sans trou. */
  private async activate(onStatus: StatusHandler): Promise<void> {
    const latest = await this.latestBlock();
    const seen = this.opts.lastSeenBlock?.() ?? 0;
    const resume = seen > 0 ? seen + 1 : latest + 1;
    this.nextBlock = Math.max(resume, latest - MAX_CATCH_UP);
    this.mode = 'active';
    onStatus(this.name, `aucun WebSocket disponible : interrogation toutes les ${this.opts.pollMs} ms à partir du bloc ${this.nextBlock}`, 'warn');
  }

  private async poll(onLog: EvmLogHandler): Promise<void> {
    const latest = await this.latestBlock();
    while (!this.stopped && this.nextBlock <= latest) {
      const to = Math.min(latest, this.nextBlock + this.range - 1);
      const logs = await this.rpc<RpcLog[]>('eth_getLogs', [
        { fromBlock: `0x${this.nextBlock.toString(16)}`, toBlock: `0x${to.toString(16)}`, topics: [ALL_TOPICS] },
      ]);
      const receivedAt = process.hrtime.bigint();
      for (const raw of logs ?? []) {
        const log = toEvmLog(raw, this.name, receivedAt);
        if (log) onLog(log);
      }
      this.nextBlock = to + 1;
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
  }
}
