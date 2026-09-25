/**
 * Endpoints publics, sans clé d'API, des blockchains EVM du mode stream.
 *
 * Source : liste Chainlist de DefiLlama (constants/extraRpcs.js), complétée par
 * les RPC officiels déclarés dans `viem/chains`. Sélection :
 *   - uniquement les fournisseurs qui déclarent ne pas pister les utilisateurs
 *     (« tracking: none ») et les RPC officiels des chaînes ;
 *   - aucune URL contenant une clé (démo ou partagée) ;
 *   - pas de RPC réservés à l'envoi de transactions (protection MEV), qui
 *     refusent souvent eth_getLogs.
 *
 * Ces endpoints sont gratuits mais limités en débit : ils servent à démarrer
 * sans configuration. Plusieurs WebSocket sont mis en course (le plus rapide
 * gagne, les autres prennent le relais en cas de coupure) et les requêtes HTTP
 * basculent sur l'endpoint suivant en cas d'erreur. Pour un usage intensif,
 * déclarez un fournisseur dédié : RPC_URL_<CHAÎNE> / WS_URL_<CHAÎNE>.
 */
import type { EvmChain } from './registry.js';

export interface PublicEndpoints {
  http: string[];
  ws: string[];
}

const PUBLIC_ENDPOINTS: Record<string, PublicEndpoints> = {
  ethereum: {
    ws: ['wss://ethereum-rpc.publicnode.com', 'wss://eth.drpc.org', 'wss://eth.api.pocket.network', 'wss://0xrpc.io/eth'],
    http: [
      'https://ethereum-rpc.publicnode.com',
      'https://eth.drpc.org',
      'https://public.1rpc.io/eth',
      'https://eth.api.pocket.network',
      'https://eth.merkle.io',
      'https://eth.meowrpc.com',
    ],
  },
  base: {
    ws: ['wss://base-rpc.publicnode.com', 'wss://base.drpc.org', 'wss://base.api.pocket.network', 'wss://base.callstaticrpc.com'],
    http: [
      'https://base-rpc.publicnode.com',
      'https://base.drpc.org',
      'https://mainnet.base.org',
      'https://public.1rpc.io/base',
      'https://base.api.pocket.network',
      'https://base.meowrpc.com',
    ],
  },
  bsc: {
    // Les nœuds officiels bsc-dataseed n'acceptent pas eth_getLogs : non retenus.
    ws: ['wss://bsc-rpc.publicnode.com', 'wss://bsc.drpc.org', 'wss://bsc.api.pocket.network', 'wss://bsc.callstaticrpc.com'],
    http: [
      'https://bsc-rpc.publicnode.com',
      'https://bsc.drpc.org',
      'https://public.1rpc.io/bnb',
      'https://bsc.api.pocket.network',
      'https://bsc.meowrpc.com',
    ],
  },
  avalanche: {
    ws: ['wss://avalanche-c-chain-rpc.publicnode.com', 'wss://avalanche.drpc.org'],
    http: [
      'https://avalanche-c-chain-rpc.publicnode.com',
      'https://avalanche.drpc.org',
      'https://api.avax.network/ext/bc/C/rpc',
      'https://public.1rpc.io/avax/c',
      'https://avax.api.pocket.network',
    ],
  },
  arbitrum: {
    ws: ['wss://arbitrum-one-rpc.publicnode.com', 'wss://arbitrum.drpc.org', 'wss://arbitrum.callstaticrpc.com'],
    http: [
      'https://arbitrum-one-rpc.publicnode.com',
      'https://arbitrum.drpc.org',
      'https://arb1.arbitrum.io/rpc',
      'https://public.1rpc.io/arb',
      'https://arb-one.api.pocket.network',
    ],
  },
  abstract: {
    ws: ['wss://api.mainnet.abs.xyz/ws', 'wss://abstract.drpc.org'],
    http: ['https://api.mainnet.abs.xyz', 'https://abstract.drpc.org'],
  },
  hyperevm: {
    ws: [],
    http: ['https://rpc.hyperliquid.xyz/evm', 'https://rpc.nodeflare.app/hl/public'],
  },
  ink: {
    ws: ['wss://rpc-gel.inkonchain.com', 'wss://rpc-qnd.inkonchain.com', 'wss://ink.drpc.org'],
    http: ['https://rpc-gel.inkonchain.com', 'https://rpc-qnd.inkonchain.com', 'https://ink.drpc.org', 'https://ink.api.pocket.network'],
  },
  story: {
    ws: [],
    http: [
      'https://mainnet.storyrpc.io',
      'https://mainnet.datarpc.io',
      'https://story-json-rpc.stakely.io',
      'https://story-mainnet-evm.itrocket.net',
      'https://evm-rpc.story.mainnet.dteam.tech',
    ],
  },
  xlayer: {
    ws: ['wss://xlayer.drpc.org'],
    http: ['https://rpc.xlayer.tech', 'https://xlayerrpc.okx.com', 'https://xlayer.drpc.org', 'https://endpoints.omniatech.io/v1/xlayer/mainnet/public'],
  },
  unichain: {
    ws: ['wss://unichain-rpc.publicnode.com', 'wss://unichain.drpc.org'],
    http: ['https://unichain-rpc.publicnode.com', 'https://unichain.drpc.org', 'https://mainnet.unichain.org'],
  },
  plasma: {
    ws: ['wss://plasma.drpc.org'],
    http: ['https://rpc.plasma.to', 'https://plasma.drpc.org', 'https://rpc.nodeflare.app/plasma/public'],
  },
  monad: {
    ws: ['wss://rpc.monad.xyz', 'wss://rpc1.monad.xyz', 'wss://wss.monad-rpc.huginn.tech'],
    http: ['https://rpc.monad.xyz', 'https://rpc1.monad.xyz', 'https://monad-mainnet.drpc.org', 'https://monad-rpc.huginn.tech'],
  },
  megaeth: {
    ws: ['wss://mainnet.megaeth.com/ws', 'wss://megaeth.drpc.org'],
    http: ['https://mainnet.megaeth.com/rpc', 'https://megaeth.drpc.org'],
  },
  tempo: {
    ws: ['wss://rpc.tempo.xyz'],
    http: ['https://rpc.tempo.xyz'],
  },
  robinhood: {
    ws: ['wss://robinhood-rpc.publicnode.com', 'wss://robinhood.api.pocket.network', 'wss://rpc.ordofi.network'],
    http: [
      'https://robinhood-rpc.publicnode.com',
      'https://rpc.mainnet.chain.robinhood.com',
      'https://robinhood.api.pocket.network',
      'https://rpc.ordofi.network',
      'https://rpc.nodeflare.app/robinhood/public',
    ],
  },
  arc: {
    ws: ['wss://rpc.beamrpc.com'],
    http: ['https://rpc.mainnet.arc.io', 'https://rpc.beamrpc.com', 'https://rpc.drpc.mainnet.arc.io'],
  },
  stable: {
    ws: ['wss://rpc.stable.xyz'],
    http: ['https://rpc.stable.xyz', 'https://stable.drpc.org'],
  },
};

/** Nombre maximal de WebSocket publics mis en course par défaut. */
export const MAX_PUBLIC_WS = 3;

const unique = (urls: string[]) => [...new Set(urls)];

/** Endpoints publics d'une chaîne : liste intégrée, puis RPC déclarés par viem. */
export function publicEndpoints(chain: EvmChain): PublicEndpoints {
  const curated = PUBLIC_ENDPOINTS[chain.key] ?? { http: [], ws: [] };
  const defaults = chain.viem.rpcUrls.default;
  return {
    http: unique([...curated.http, ...defaults.http]),
    ws: unique([...curated.ws, ...(defaults.webSocket ?? [])]),
  };
}
