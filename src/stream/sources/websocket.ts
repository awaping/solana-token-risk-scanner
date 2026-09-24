/**
 * Source WebSocket : abonnement `logsSubscribe` (commitment "processed") aux
 * logs de toutes les transactions qui mentionnent le programme Pump.fun.
 *
 * Client JSON-RPC écrit à la main sur `ws` (sans la couche de validation de
 * web3.js) pour minimiser la latence : l'horodatage est pris dès l'arrivée
 * du message brut. Reconnexion automatique, heartbeat ping/pong et watchdog
 * d'inactivité (le flux Pump.fun n'est jamais silencieux plus de quelques secondes).
 */
import WebSocket from 'ws';
import type { StatusHandler, StreamTx, TxHandler, TxSource } from './types.js';

export interface WebSocketSourceOptions {
  url: string;
  programId: string;
  name?: string;
  commitment?: 'processed' | 'confirmed';
  /** Intervalle des pings de heartbeat (ms). */
  pingIntervalMs?: number;
  /** Reconnexion si aucune notification pendant ce délai (ms). */
  idleTimeoutMs?: number;
}

interface LogsNotification {
  method?: string;
  id?: number;
  result?: unknown;
  error?: { message?: string };
  params?: {
    result?: {
      context?: { slot?: number };
      value?: { signature?: string; err?: unknown; logs?: string[] | null };
    };
  };
}

/** Déduit une URL WebSocket d'une URL HTTP(S) de RPC. */
export function httpToWs(url: string): string {
  return url.replace(/^http(s?):\/\//i, (_m, s: string) => `ws${s}://`);
}

/** Nom court d'une source à partir de son URL (sans clé d'API). */
export function sourceName(url: string, prefix: string): string {
  try {
    return `${prefix}:${new URL(url).host}`;
  } catch {
    return prefix;
  }
}

/**
 * Décode un message JSON-RPC du WebSocket : transaction (StreamTx),
 * 'subscribed' (accusé d'abonnement), message d'erreur (string) ou null.
 * Exporté pour être partagé avec le préchauffage JIT et les tests.
 */
export function parseLogsNotification(raw: string, source: string, receivedAt: bigint): StreamTx | string | null {
  let msg: LogsNotification;
  try {
    msg = JSON.parse(raw) as LogsNotification;
  } catch {
    return null;
  }
  if (msg.method === 'logsNotification') {
    const result = msg.params?.result;
    const value = result?.value;
    if (!value?.signature || !value.logs) return null;
    return {
      signature: value.signature,
      slot: result?.context?.slot ?? 0,
      logs: value.logs,
      failed: value.err !== null && value.err !== undefined,
      source,
      receivedAt,
    };
  }
  if (msg.id === 1) return msg.error ? (msg.error.message ?? 'erreur inconnue') : 'subscribed';
  return null;
}

export class WebSocketLogsSource implements TxSource {
  readonly name: string;
  private ws?: WebSocket;
  private stopped = false;
  private backoffMs = 250;
  private pingTimer?: NodeJS.Timeout;
  private idleTimer?: NodeJS.Timeout;
  private awaitingPong = false;
  private readonly opts: Required<Omit<WebSocketSourceOptions, 'name'>>;

  constructor(options: WebSocketSourceOptions) {
    this.name = options.name ?? sourceName(options.url, 'ws');
    this.opts = {
      url: options.url,
      programId: options.programId,
      commitment: options.commitment ?? 'processed',
      pingIntervalMs: options.pingIntervalMs ?? 15_000,
      idleTimeoutMs: options.idleTimeoutMs ?? 30_000,
    };
  }

  async start(onTx: TxHandler, onStatus: StatusHandler): Promise<void> {
    this.stopped = false;
    this.connect(onTx, onStatus);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.clearTimers();
    this.ws?.terminate();
  }

  private clearTimers() {
    clearInterval(this.pingTimer);
    clearTimeout(this.idleTimer);
  }

  private armIdleWatchdog(onStatus: StatusHandler) {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      onStatus(this.name, `aucune donnée depuis ${this.opts.idleTimeoutMs / 1000} s, reconnexion`, 'warn');
      this.ws?.terminate();
    }, this.opts.idleTimeoutMs);
  }

  private connect(onTx: TxHandler, onStatus: StatusHandler) {
    if (this.stopped) return;
    const ws = new WebSocket(this.opts.url, { perMessageDeflate: false, handshakeTimeout: 10_000 });
    this.ws = ws;

    ws.on('open', () => {
      ws.send(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'logsSubscribe',
          params: [{ mentions: [this.opts.programId] }, { commitment: this.opts.commitment }],
        }),
      );
      this.awaitingPong = false;
      this.pingTimer = setInterval(() => {
        if (this.awaitingPong) {
          onStatus(this.name, 'heartbeat sans réponse, reconnexion', 'warn');
          ws.terminate();
          return;
        }
        this.awaitingPong = true;
        ws.ping();
      }, this.opts.pingIntervalMs);
      this.armIdleWatchdog(onStatus);
    });

    ws.on('pong', () => {
      this.awaitingPong = false;
    });

    ws.on('message', (raw: WebSocket.RawData) => {
      // Horodatage au plus tôt, avant tout parsing.
      const receivedAt = process.hrtime.bigint();
      const result = parseLogsNotification(raw.toString(), this.name, receivedAt);
      if (result === null) return;
      if (typeof result === 'string') {
        if (result === 'subscribed') onStatus(this.name, 'abonné aux logs Pump.fun (processed)', 'info');
        else onStatus(this.name, `abonnement refusé : ${result}`, 'warn');
        return;
      }
      this.armIdleWatchdog(onStatus);
      this.backoffMs = 250;
      onTx(result);
    });

    ws.on('error', (error: Error) => {
      onStatus(this.name, `erreur : ${error.message}`, 'warn');
    });

    ws.on('close', () => {
      this.clearTimers();
      if (this.stopped) return;
      const delay = this.backoffMs;
      this.backoffMs = Math.min(this.backoffMs * 2, 5_000);
      onStatus(this.name, `connexion fermée, nouvelle tentative dans ${delay} ms`, 'warn');
      setTimeout(() => this.connect(onTx, onStatus), delay);
    });
  }
}
