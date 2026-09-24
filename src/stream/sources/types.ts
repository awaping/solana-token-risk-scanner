/**
 * Contrat commun des sources de transactions temps réel (WebSocket, gRPC).
 */

/** Transaction Pump.fun reçue d'une source, avant tout décodage. */
export interface StreamTx {
  signature: string;
  slot: number;
  logs: readonly string[];
  /** La transaction a échoué on-chain. */
  failed: boolean;
  /** Nom de la source qui l'a livrée. */
  source: string;
  /** Horodatage haute résolution (process.hrtime.bigint) à la réception brute. */
  receivedAt: bigint;
}

export type TxHandler = (tx: StreamTx) => void;
export type StatusHandler = (source: string, message: string, level: 'info' | 'warn') => void;

export interface TxSource {
  readonly name: string;
  start(onTx: TxHandler, onStatus: StatusHandler): Promise<void>;
  stop(): Promise<void>;
}
