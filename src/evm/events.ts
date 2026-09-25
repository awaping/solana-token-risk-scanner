/**
 * Décodage des événements EVM utilisés par le mode stream.
 *
 * Création de pool (le token lancé apparaît sur un DEX) :
 *   Uniswap v2 & forks   PairCreated(address indexed token0, address indexed token1, address pair, uint256)
 *   Uniswap v3 & forks   PoolCreated(address indexed token0, address indexed token1, uint24 indexed fee, int24 tickSpacing, address pool)
 *   Uniswap v4           Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)
 *   Solidly / Aerodrome  PoolCreated(address indexed token0, address indexed token1, bool indexed stable, address pool, uint256)
 *   Solidly CL           PoolCreated(address indexed token0, address indexed token1, int24 indexed tickSpacing, address pool)
 *
 * Swap (un trade sur une pool suivie) :
 *   v2 & forks           Swap(address indexed sender, uint256 amount0In, uint256 amount1In, uint256 amount0Out, uint256 amount1Out, address indexed to)
 *   Solidly / Aerodrome  Swap(address indexed sender, address indexed to, uint256 amount0In, uint256 amount1In, uint256 amount0Out, uint256 amount1Out)
 *   v3 & Solidly CL      Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)
 *   v4                   Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)
 *
 * Les montants des swaps sont normalisés du point de vue de la pool :
 * un delta positif signifie que la pool a reçu le token (l'utilisateur l'a vendu).
 */
import { keccak256, toHex } from 'viem';
import type { DexKind } from '../chains/registry.js';

const topic = (signature: string) => keccak256(toHex(signature));

export const TOPICS = {
  pairCreatedV2: topic('PairCreated(address,address,address,uint256)'),
  poolCreatedV3: topic('PoolCreated(address,address,uint24,int24,address)'),
  initializeV4: topic('Initialize(bytes32,address,address,uint24,int24,address,uint160,int24)'),
  poolCreatedSolidly: topic('PoolCreated(address,address,bool,address,uint256)'),
  poolCreatedSolidlyCl: topic('PoolCreated(address,address,int24,address)'),
  swapV2: topic('Swap(address,uint256,uint256,uint256,uint256,address)'),
  swapSolidly: topic('Swap(address,address,uint256,uint256,uint256,uint256)'),
  swapV3: topic('Swap(address,address,int256,int256,uint160,uint128,int24)'),
  swapV4: topic('Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)'),
} as const;

export const CREATION_TOPICS = [
  TOPICS.pairCreatedV2,
  TOPICS.poolCreatedV3,
  TOPICS.initializeV4,
  TOPICS.poolCreatedSolidly,
  TOPICS.poolCreatedSolidlyCl,
];
export const SWAP_TOPICS = [TOPICS.swapV2, TOPICS.swapSolidly, TOPICS.swapV3, TOPICS.swapV4];
export const ALL_TOPICS = [...CREATION_TOPICS, ...SWAP_TOPICS];

/** Log EVM brut, tel que reçu d'une source (WebSocket ou HTTP). */
export interface EvmLog {
  address: string;
  topics: string[];
  data: string;
  blockNumber: number;
  transactionHash: string;
  logIndex: number;
  removed?: boolean;
  source: string;
  /** process.hrtime.bigint() à la réception. */
  receivedAt: bigint;
}

export interface PoolCreated {
  kind: 'pool';
  dex: DexKind;
  /** Contrat émetteur (factory ou PoolManager). */
  emitter: string;
  /** Clé de la pool : adresse (v2/v3/Solidly) ou "<PoolManager>:<id>" (v4). */
  poolKey: string;
  /** Adresse de la pool (v2/v3/Solidly) ; PoolManager pour v4. */
  poolAddress: string;
  token0: string;
  token1: string;
}

export interface SwapEvent {
  kind: 'swap';
  poolKey: string;
  /** Variation du solde de la pool en token0 / token1 (positif = reçu par la pool). */
  delta0: bigint;
  delta1: bigint;
}

export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

const word = (data: string, index: number): string => data.slice(2 + index * 64, 2 + (index + 1) * 64);
const addressFromWord = (hex: string): string => `0x${hex.slice(24)}`.toLowerCase();
const addressFromTopic = (t: string | undefined): string => (t ? `0x${t.slice(26)}`.toLowerCase() : ZERO_ADDRESS);

function uint(hex: string): bigint {
  return hex ? BigInt(`0x${hex}`) : 0n;
}

/** Entier signé sur `bits` bits encodé dans un mot ABI de 256 bits. */
function int(hex: string, bits = 256): bigint {
  let value = uint(hex);
  if (bits < 256) value &= (1n << BigInt(bits)) - 1n;
  const sign = 1n << BigInt(bits - 1);
  return value >= sign ? value - (1n << BigInt(bits)) : value;
}

/** Décode un log de création de pool ou de swap ; null si non reconnu ou mal formé. */
export function decodeEvmLog(log: Pick<EvmLog, 'address' | 'topics' | 'data'>): PoolCreated | SwapEvent | null {
  const t0 = log.topics[0];
  const emitter = log.address.toLowerCase();
  const data = log.data ?? '0x';
  try {
    switch (t0) {
      case TOPICS.pairCreatedV2: {
        const pair = addressFromWord(word(data, 0));
        return { kind: 'pool', dex: 'v2', emitter, poolKey: pair, poolAddress: pair, token0: addressFromTopic(log.topics[1]), token1: addressFromTopic(log.topics[2]) };
      }
      case TOPICS.poolCreatedV3: {
        const pool = addressFromWord(word(data, 1));
        return { kind: 'pool', dex: 'v3', emitter, poolKey: pool, poolAddress: pool, token0: addressFromTopic(log.topics[1]), token1: addressFromTopic(log.topics[2]) };
      }
      case TOPICS.poolCreatedSolidly: {
        const pool = addressFromWord(word(data, 0));
        return { kind: 'pool', dex: 'solidly', emitter, poolKey: pool, poolAddress: pool, token0: addressFromTopic(log.topics[1]), token1: addressFromTopic(log.topics[2]) };
      }
      case TOPICS.poolCreatedSolidlyCl: {
        const pool = addressFromWord(word(data, 0));
        return { kind: 'pool', dex: 'solidly-cl', emitter, poolKey: pool, poolAddress: pool, token0: addressFromTopic(log.topics[1]), token1: addressFromTopic(log.topics[2]) };
      }
      case TOPICS.initializeV4: {
        const id = log.topics[1]?.toLowerCase();
        if (!id) return null;
        return { kind: 'pool', dex: 'v4', emitter, poolKey: `${emitter}:${id}`, poolAddress: emitter, token0: addressFromTopic(log.topics[2]), token1: addressFromTopic(log.topics[3]) };
      }
      case TOPICS.swapV2:
      case TOPICS.swapSolidly: {
        if (data.length < 2 + 4 * 64) return null;
        const [a0In, a1In, a0Out, a1Out] = [0, 1, 2, 3].map((i) => uint(word(data, i))) as [bigint, bigint, bigint, bigint];
        return { kind: 'swap', poolKey: emitter, delta0: a0In - a0Out, delta1: a1In - a1Out };
      }
      case TOPICS.swapV3: {
        if (data.length < 2 + 2 * 64) return null;
        // v3 : montants déjà exprimés du point de vue de la pool.
        return { kind: 'swap', poolKey: emitter, delta0: int(word(data, 0)), delta1: int(word(data, 1)) };
      }
      case TOPICS.swapV4: {
        const id = log.topics[1]?.toLowerCase();
        if (!id || data.length < 2 + 2 * 64) return null;
        // v4 : BalanceDelta du point de vue de l'appelant (négatif = payé à la pool) → on inverse.
        return { kind: 'swap', poolKey: `${emitter}:${id}`, delta0: -int(word(data, 0), 128), delta1: -int(word(data, 1), 128) };
      }
      default:
        return null;
    }
  } catch {
    return null;
  }
}

/** Famille d'un événement de création (pour les libellés). */
export const isCreationTopic = (t: string | undefined) => !!t && CREATION_TOPICS.includes(t as (typeof CREATION_TOPICS)[number]);
