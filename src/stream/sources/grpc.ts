/**
 * Source Yellowstone gRPC (Geyser) — la plus rapide : les transactions sont
 * poussées par le plugin Geyser du validateur, avant la couche WebSocket.
 *
 * Dépendance optionnelle (binaire natif) à installer seulement si votre
 * fournisseur propose le gRPC (Helius, Triton, QuickNode, Shyft...) :
 *
 *   npm install @triton-one/yellowstone-grpc
 */
import bs58 from 'bs58';
import type { StatusHandler, TxHandler, TxSource } from './types.js';
import { sourceName } from './websocket.js';

export interface GrpcSourceOptions {
  endpoint: string;
  token?: string;
  programId: string;
  name?: string;
}

/** Sous-ensemble de l'API @triton-one/yellowstone-grpc (v7) utilisé ici. */
interface YellowstoneUpdate {
  transaction?: {
    slot: string;
    transaction?: {
      signature: Uint8Array;
      meta?: { err?: unknown; logMessages: string[] };
    };
  };
}
interface YellowstoneStream {
  on(event: 'data', listener: (update: YellowstoneUpdate) => void): void;
  on(event: 'error' | 'end' | 'close', listener: (arg?: unknown) => void): void;
  write(request: unknown, callback?: (err?: Error | null) => void): boolean;
  destroy(): void;
}
interface YellowstoneClient {
  connect(): Promise<void>;
  subscribe(request?: unknown): Promise<YellowstoneStream>;
}
interface YellowstoneModule {
  default: new (endpoint: string, token: string | undefined, channel: unknown, reconnect?: unknown) => YellowstoneClient;
  CommitmentLevel: { PROCESSED: number };
}

const PACKAGE = '@triton-one/yellowstone-grpc';

async function loadYellowstone(): Promise<YellowstoneModule> {
  try {
    const moduleName = PACKAGE; // variable : évite la résolution statique par TypeScript
    return (await import(moduleName)) as YellowstoneModule;
  } catch {
    throw new Error(`source gRPC indisponible : installez le paquet optionnel (npm install ${PACKAGE})`);
  }
}

export class GrpcSource implements TxSource {
  readonly name: string;
  private stream?: YellowstoneStream;
  private pingTimer?: NodeJS.Timeout;
  private stopped = false;

  constructor(private readonly opts: GrpcSourceOptions) {
    this.name = opts.name ?? sourceName(opts.endpoint, 'grpc');
  }

  async start(onTx: TxHandler, onStatus: StatusHandler): Promise<void> {
    const mod = await loadYellowstone();
    this.stopped = false;
    const client = new mod.default(this.opts.endpoint, this.opts.token, undefined, {
      backoff: { initialIntervalMs: 100, multiplier: 2, maxRetries: 1_000 },
    });
    await client.connect();

    const empty = { accounts: {}, slots: {}, transactionsStatus: {}, blocks: {}, blocksMeta: {}, entry: {}, accountsDataSlice: [] };
    const request = {
      ...empty,
      transactions: {
        pump: { vote: false, failed: false, accountInclude: [this.opts.programId], accountExclude: [], accountRequired: [] },
      },
      commitment: mod.CommitmentLevel.PROCESSED,
    };

    const stream = await client.subscribe(request);
    this.stream = stream;
    onStatus(this.name, 'abonné aux transactions Pump.fun (processed)', 'info');

    stream.on('data', (update: YellowstoneUpdate) => {
      const receivedAt = process.hrtime.bigint();
      const info = update.transaction?.transaction;
      if (!info?.meta) return;
      onTx({
        signature: bs58.encode(info.signature),
        slot: Number(update.transaction!.slot),
        logs: info.meta.logMessages,
        failed: info.meta.err !== undefined && info.meta.err !== null,
        source: this.name,
        receivedAt,
      });
    });
    stream.on('error', (error) => {
      if (!this.stopped) onStatus(this.name, `erreur : ${error instanceof Error ? error.message : String(error)}`, 'warn');
    });
    stream.on('end', () => {
      if (!this.stopped) onStatus(this.name, 'flux terminé par le serveur', 'warn');
    });

    // Ping applicatif : maintient la connexion ouverte à travers les load balancers.
    // Le filtre est renvoyé à l'identique : une requête gRPC remplace l'abonnement courant.
    let pingId = 1;
    this.pingTimer = setInterval(() => {
      stream.write({ ...request, ping: { id: pingId++ } });
    }, 15_000);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearInterval(this.pingTimer);
    this.stream?.destroy();
  }
}
