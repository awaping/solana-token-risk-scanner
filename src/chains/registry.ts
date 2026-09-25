/**
 * Registre des blockchains prises en charge par le mode stream : les 19
 * réseaux actifs sur Based Bot (Solana + 18 chaînes EVM).
 *
 * Provenance des données EVM :
 *   - identifiant, nom, RPC publics, devise native : définitions de `viem/chains` ;
 *   - factories Uniswap v2 / v3 et PoolManager v4, wrapped natif : `@uniswap/sdk-core` 7.19
 *     (CHAIN_TO_ADDRESSES_MAP, V2_FACTORY_ADDRESSES, WETH9) ;
 *   - factories PancakeSwap (BSC) : `@pancakeswap/sdk` 5.9 et `@pancakeswap/v3-sdk` 3.10.
 *
 * Les factories connues servent uniquement à nommer le DEX d'une pool : la
 * détection écoute les événements standard (Uniswap v2/v3/v4, Solidly/Aerodrome)
 * quel que soit le contrat émetteur, ce qui couvre aussi les forks non listés.
 */
import type { Chain } from 'viem';
import {
  abstract,
  arbitrum,
  arc,
  avalanche,
  base,
  bsc,
  hyperEvm,
  ink,
  mainnet,
  megaeth,
  monad,
  plasma,
  robinhood,
  stable,
  story,
  tempo,
  unichain,
  xLayer,
} from 'viem/chains';

export type DexKind = 'v2' | 'v3' | 'v4' | 'solidly' | 'solidly-cl';

export interface KnownDex {
  name: string;
  kind: DexKind;
  /** Factory (v2/v3) ou PoolManager (v4), en minuscules. */
  address: string;
}

interface ChainBase {
  /** Identifiant utilisé en ligne de commande (`npm run stream <clé>`). */
  key: string;
  aliases: string[];
  name: string;
}

export interface SolanaChain extends ChainBase {
  kind: 'solana';
}

export interface EvmChain extends ChainBase {
  kind: 'evm';
  chainId: number;
  viem: Chain;
  nativeSymbol: string;
  nativeDecimals: number;
  /** Wrapped natif (devise de cotation principale), si connu. */
  wrappedNative?: { address: string; symbol: string };
  dexes: KnownDex[];
  /** Temps de bloc approximatif (ms), pour le rythme d'interrogation HTTP. */
  blockTimeMs: number;
}

export type ChainDef = SolanaChain | EvmChain;

const lower = (address: string) => address.toLowerCase();

function uniswap(v2: string, v3: string, v4: string): KnownDex[] {
  return [
    { name: 'Uniswap v2', kind: 'v2', address: lower(v2) },
    { name: 'Uniswap v3', kind: 'v3', address: lower(v3) },
    { name: 'Uniswap v4', kind: 'v4', address: lower(v4) },
  ];
}

function evm(
  key: string,
  aliases: string[],
  chain: Chain,
  opts: { wrapped?: [string, string]; dexes?: KnownDex[]; blockTimeMs?: number; name?: string } = {},
): EvmChain {
  return {
    kind: 'evm',
    key,
    aliases,
    name: opts.name ?? chain.name,
    chainId: chain.id,
    viem: chain,
    nativeSymbol: chain.nativeCurrency.symbol,
    nativeDecimals: chain.nativeCurrency.decimals,
    wrappedNative: opts.wrapped ? { address: lower(opts.wrapped[1]), symbol: opts.wrapped[0] } : undefined,
    dexes: opts.dexes ?? [],
    blockTimeMs: opts.blockTimeMs ?? 2_000,
  };
}

export const CHAINS: readonly ChainDef[] = [
  { kind: 'solana', key: 'solana', aliases: ['sol'], name: 'Solana' },
  evm('ethereum', ['eth', 'mainnet'], mainnet, {
    name: 'Ethereum',
    wrapped: ['WETH', '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'],
    dexes: uniswap('0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f', '0x1F98431c8aD98523631AE4a59f267346ea31F984', '0x000000000004444c5dc75cB358380D2e3dE08A90'),
    blockTimeMs: 12_000,
  }),
  evm('base', [], base, {
    wrapped: ['WETH', '0x4200000000000000000000000000000000000006'],
    dexes: uniswap('0x8909dc15e40173ff4699343b6eb8132c65e18ec6', '0x33128a8fC17869897dcE68Ed026d694621f6FDfD', '0x498581ff718922c3f8e6a244956af099b2652b2b'),
  }),
  evm('bsc', ['bnb', 'binance'], bsc, {
    name: 'BNB Smart Chain',
    wrapped: ['WBNB', '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c'],
    dexes: [
      { name: 'PancakeSwap v2', kind: 'v2', address: lower('0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73') },
      { name: 'PancakeSwap v3', kind: 'v3', address: lower('0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865') },
      ...uniswap('0x8909Dc15e40173Ff4699343b6eB8132c65e18eC6', '0xdB1d10011AD0Ff90774D0C6Bb92e5C5c8b4461F7', '0x28e2ea090877bf75740558f6bfb36a5ffee9e9df'),
    ],
    blockTimeMs: 1_000,
  }),
  evm('avalanche', ['avax'], avalanche, {
    wrapped: ['WAVAX', '0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7'],
    dexes: uniswap('0x9e5A52f57b3038F1B8EeE45F28b3C1967e22799C', '0x740b1c1de25031C31FF4fC9A62f554A55cdC1baD', '0x06380c0e0912312b5150364b9dc4542ba0dbbc85'),
  }),
  evm('arbitrum', ['arb'], arbitrum, {
    wrapped: ['WETH', '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1'],
    dexes: uniswap('0xf1D7CC64Fb4452F05c498126312eBE29f30Fbcf9', '0x1F98431c8aD98523631AE4a59f267346ea31F984', '0x360e68faccca8ca495c1b759fd9eee466db9fb32'),
    blockTimeMs: 250,
  }),
  evm('abstract', ['abs'], abstract),
  evm('hyperevm', ['hyperliquid', 'hype'], hyperEvm, { name: 'HyperEVM', blockTimeMs: 1_000 }),
  evm('ink', [], ink, {
    wrapped: ['WETH', '0x4200000000000000000000000000000000000006'],
    dexes: uniswap('0xfe57a6ba1951f69ae2ed4abe23e0f095df500c04', '0x640887a9ba3a9c53ed27d0f7e8246a4f933f3424', '0x360e68faccca8ca495c1b759fd9eee466db9fb32'),
    blockTimeMs: 1_000,
  }),
  // viem nomme ce réseau « Data Network » ; Based Bot l'appelle Story (chain ID 1514).
  evm('story', ['ip', 'datanetwork'], story, { name: 'Story' }),
  evm('xlayer', ['x-layer', 'okx'], xLayer, {
    name: 'X Layer',
    dexes: uniswap('0xdf38f24fe153761634be942f9d859f3dba857e95', '0x4b2ab38dbf28d31d467aa8993f6c2585981d6804', '0x360e68faccca8ca495c1b759fd9eee466db9fb32'),
  }),
  evm('unichain', [], unichain, {
    wrapped: ['WETH', '0x4200000000000000000000000000000000000006'],
    dexes: uniswap('0x1f98400000000000000000000000000000000002', '0x1f98400000000000000000000000000000000003', '0x1f98400000000000000000000000000000000004'),
    blockTimeMs: 1_000,
  }),
  evm('plasma', ['xpl'], plasma, { blockTimeMs: 1_000 }),
  evm('monad', ['mon'], monad, {
    wrapped: ['WMON', '0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A'],
    dexes: uniswap('0x182a927119d56008d921126764bf884221b10f59', '0x204faca1764b154221e35c0d20abb3c525710498', '0x188d586ddcf52439676ca21a244753fa19f9ea8e'),
    blockTimeMs: 500,
  }),
  evm('megaeth', ['mega'], megaeth, {
    name: 'MegaETH',
    wrapped: ['WETH', '0x4200000000000000000000000000000000000006'],
    dexes: uniswap('0xbf56488c857a881ae7e3bed27cf99c10a7ab7e50', '0x3a5f0cd7d62452b7f899b2a5758bfa57be0de478', '0xacb7e78fa05d562e0a5d3089ec896d57d057d38e'),
    blockTimeMs: 250,
  }),
  evm('tempo', [], tempo, {
    name: 'Tempo',
    dexes: uniswap('0xf9ec577a4e45b5278bb7cf60fcbc20c3acaef68f', '0x24a3d4757e330890a8b8978028c9e58e04611fd6', '0x33620f62c5b9b2086dd6b62f4a297a9f30347029'),
    blockTimeMs: 1_000,
  }),
  evm('robinhood', ['hood', 'rh'], robinhood, {
    name: 'Robinhood Chain',
    wrapped: ['WETH', '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73'],
    dexes: uniswap('0x8bceaa40b9acdfaedf85adf4ff01f5ad6517937f', '0x1f7d7550b1b028f7571e69a784071f0205fd2efa', '0x8366a39cc670b4001a1121b8f6a443a643e40951'),
    blockTimeMs: 250,
  }),
  evm('arc', [], arc, {
    dexes: uniswap('0x89e5db8b5aa49aa85ac63f691524311aeb649eba', '0xf0db7b58379503491d857db50ac9ece64c653918', '0x8366a39cc670b4001a1121b8f6a443a643e40951'),
    blockTimeMs: 1_000,
  }),
  evm('stable', [], stable, { name: 'Stable', blockTimeMs: 1_000 }),
];

/** Normalise un nom saisi par l'utilisateur (casse, tirets, espaces). */
const normalize = (value: string) => value.trim().toLowerCase().replace(/[\s_-]+/g, '');

/** Retrouve une chaîne par sa clé, un alias ou son nom complet ("Robinhood Chain") ; null si inconnue. */
export function findChain(name: string): ChainDef | null {
  const wanted = normalize(name);
  return (
    CHAINS.find(
      (c) => normalize(c.key) === wanted || normalize(c.name) === wanted || c.aliases.some((a) => normalize(a) === wanted),
    ) ?? null
  );
}

export function chainKeys(): string[] {
  return CHAINS.map((c) => c.key);
}

/** Libellé d'un DEX connu à partir de l'adresse émettrice d'un événement. */
export function dexLabel(chain: EvmChain, emitter: string, kind: DexKind): string {
  const known = chain.dexes.find((d) => d.address === emitter.toLowerCase());
  if (known) return known.name;
  const family: Record<DexKind, string> = {
    v2: 'fork v2',
    v3: 'fork v3',
    v4: 'fork v4',
    solidly: 'Solidly/Aerodrome',
    'solidly-cl': 'Solidly CL',
  };
  return `${family[kind]} ${emitter.slice(0, 6)}…`;
}
