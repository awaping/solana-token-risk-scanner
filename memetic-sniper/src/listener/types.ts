/**
 * src/listener/types.ts
 * Contrat commun aux backends d'ingestion.
 */

import type { TweetSignal } from '../agent/analyzer.ts';

export type TweetHandler = (tweet: TweetSignal) => void | Promise<void>;

export interface Listener {
  start(handler: TweetHandler): Promise<void>;
  stop(): Promise<void>;
}
