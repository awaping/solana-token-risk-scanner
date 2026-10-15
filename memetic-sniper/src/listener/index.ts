/**
 * src/listener/index.ts
 * Selection du backend d'ingestion selon LISTENER_MODE.
 */

import type { Logger } from 'pino';

import type { ListenerConfig } from '../core/config.ts';
import { TwitterApiListener } from './twitterApi.ts';
import type { Listener } from './types.ts';
import { WsRelayListener } from './wsRelay.ts';

export * from './normalize.ts';
export * from './queue.ts';
export * from './types.ts';

/**
 * Le mode `none` n'ouvre aucune connexion : il sert aux scripts qui injectent
 * eux-memes leurs signaux (`dryRunPipeline`), sans avoir a simuler un relais.
 */
export function createListener(cfg: ListenerConfig, logger: Logger): Listener {
  switch (cfg.mode) {
    case 'twitter-api':
      return new TwitterApiListener(cfg, logger);
    case 'ws-relay':
      return new WsRelayListener(cfg, logger);
    case 'none':
      return {
        async start() {
          logger.warn('LISTENER_MODE=none: no ingestion, signals must be injected manually');
        },
        async stop() {
          /* rien a fermer */
        },
      };
  }
}
