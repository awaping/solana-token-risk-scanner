/**
 * Sources de logs EVM pour le mode stream.
 *
 *   WebSocket  eth_subscribe("logs") : poussée en temps réel (la plus rapide)
 *   HTTP       eth_blockNumber + eth_getLogs à chaque nouveau bloc (repli universel)
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
  private backoffMs = 250;
  private pingTimer?: NodeJS.Timeout;
  private idleTimer?: NodeJS.Timeout;

  constructor(
    private readonly url: string,
    private readonly idleTimeoutMs = 60_000,
  ) {
    this.name = `ws:${hostOf(url)}`;
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
        this.backoffMs = 250;
        onLog(log);
      } else if (msg.id === 1) {
        if (msg.error) onStatus(this.name, `abonnement refusé : ${msg.error.message ?? 'erreur inconnue'}`, 'warn');
        else onStatus(this.name, 'abonné aux créations de pool et aux swaps', 'info');
      }
    });

    ws.on('error', (error: Error) => onStatus(this.name, `erreur : ${error.message}`, 'warn'));
    ws.on('close', () => {
      clearInterval(this.pingTimer);
      clearTimeout(this.idleTimer);
      if (this.stopped) return;
      const delay = this.backoffMs;
      this.backoffMs = Math.min(this.backoffMs * 2, 5_000);
      onStatus(this.name, `connexion fermée, nouvelle tentative dans ${delay} ms`, 'warn');
      setTimeout(() => this.connect(onLog, onStatus), delay);
    });
  }
}

// ---------------------------------------------------------------------------
// HTTP (interrogation)
// ---------------------------------------------------------------------------

export interface HttpPollingOptions {
  url: string;
  /** Intervalle d'interrogation (ms), aligné sur le temps de bloc de la chaîne. */
  pollMs: number;
  /** Nombre maximal de blocs par requête eth_getLogs. */
  maxRange?: number;
}

export class EvmHttpPollingSource implements EvmSource {
  readonly name: string;
  private stopped = false;
  private timer?: NodeJS.Timeout;
  private nextBlock = -1;
  private range: number;
  private requestId = 1;

  constructor(private readonly opts: HttpPollingOptions) {
    this.name = `http:${hostOf(opts.url)}`;
    this.range = opts.maxRange ?? 50;
  }

  private async rpc<T>(method: string, params: unknown[]): Promise<T> {
    const response = await fetch(this.opts.url, {
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

  async start(onLog: EvmLogHandler, onStatus: StatusHandler): Promise<void> {
    this.stopped = false;
    // On démarre au bloc courant : pas d'historique, uniquement ce qui arrive.
    this.nextBlock = hexToNumber(await this.rpc<string>('eth_blockNumber', [])) + 1;
    onStatus(this.name, `interrogation toutes les ${this.opts.pollMs} ms à partir du bloc ${this.nextBlock}`, 'info');
    const loop = async () => {
      if (this.stopped) return;
      try {
        await this.poll(onLog);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (/range|limit|too (many|large)|exceed/i.test(message) && this.range > 1) {
          this.range = Math.max(1, Math.floor(this.range / 2));
        } else {
          onStatus(this.name, `erreur : ${message}`, 'warn');
        }
      }
      if (!this.stopped) this.timer = setTimeout(loop, this.opts.pollMs);
    };
    this.timer = setTimeout(loop, 0);
  }

  private async poll(onLog: EvmLogHandler): Promise<void> {
    const latest = hexToNumber(await this.rpc<string>('eth_blockNumber', []));
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
