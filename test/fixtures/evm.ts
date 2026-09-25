/**
 * Outils de test EVM : encodeurs de logs (créations de pool, swaps) et faux
 * nœud JSON-RPC HTTP (eth_getLogs, eth_call ERC-20 / Multicall3, bytecode,
 * transactions) pour exercer le mode stream EVM sans réseau.
 */
import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  decodeFunctionData,
  encodeFunctionResult,
  multicall3Abi,
  parseAbi,
  toFunctionSelector,
  type Hex,
} from 'viem';
import { TOPICS } from '../../src/evm/events.js';

export const randomAddress = () => `0x${randomBytes(20).toString('hex')}`;
export const randomHash = () => `0x${randomBytes(32).toString('hex')}`;

const word = (hex: string) => hex.replace(/^0x/, '').toLowerCase().padStart(64, '0');
const addrTopic = (address: string) => `0x${word(address)}`;
const uintWord = (value: bigint) => word(value.toString(16));
const intWord = (value: bigint) => (value >= 0n ? uintWord(value) : word(((1n << 256n) + value).toString(16)));

export interface RawLog {
  address: string;
  topics: string[];
  data: string;
}

export const logs = {
  pairCreatedV2: (factory: string, token0: string, token1: string, pair: string): RawLog => ({
    address: factory,
    topics: [TOPICS.pairCreatedV2, addrTopic(token0), addrTopic(token1)],
    data: `0x${word(pair)}${uintWord(1n)}`,
  }),
  poolCreatedV3: (factory: string, token0: string, token1: string, pool: string, fee = 3000n): RawLog => ({
    address: factory,
    topics: [TOPICS.poolCreatedV3, addrTopic(token0), addrTopic(token1), `0x${uintWord(fee)}`],
    data: `0x${intWord(60n)}${word(pool)}`,
  }),
  initializeV4: (manager: string, id: string, currency0: string, currency1: string): RawLog => ({
    address: manager,
    topics: [TOPICS.initializeV4, id, addrTopic(currency0), addrTopic(currency1)],
    data: `0x${uintWord(10000n)}${intWord(200n)}${word('0x0')}${uintWord(79228162514264337593543950336n)}${intWord(0n)}`,
  }),
  swapV2: (pair: string, a0In: bigint, a1In: bigint, a0Out: bigint, a1Out: bigint): RawLog => ({
    address: pair,
    topics: [TOPICS.swapV2, addrTopic(randomAddress()), addrTopic(randomAddress())],
    data: `0x${uintWord(a0In)}${uintWord(a1In)}${uintWord(a0Out)}${uintWord(a1Out)}`,
  }),
  /** v3 : montants du point de vue de la pool (positif = reçu). */
  swapV3: (pool: string, amount0: bigint, amount1: bigint): RawLog => ({
    address: pool,
    topics: [TOPICS.swapV3, addrTopic(randomAddress()), addrTopic(randomAddress())],
    data: `0x${intWord(amount0)}${intWord(amount1)}${uintWord(1n)}${uintWord(1n)}${intWord(0n)}`,
  }),
  /** v4 : montants du point de vue de l'appelant (négatif = payé). */
  swapV4: (manager: string, id: string, amount0: bigint, amount1: bigint): RawLog => ({
    address: manager,
    topics: [TOPICS.swapV4, id, addrTopic(randomAddress())],
    data: `0x${intWord(amount0)}${intWord(amount1)}${uintWord(1n)}${uintWord(1n)}${intWord(0n)}${uintWord(3000n)}`,
  }),
};

const TOKEN_ABI = parseAbi([
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function totalSupply() view returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
  'function owner() view returns (address)',
  'function getOwner() view returns (address)',
]);

export interface MockToken {
  name: string;
  symbol: string;
  decimals: number;
  totalSupply: bigint;
  balances: Map<string, bigint>;
  /** undefined = le contrat n'a pas de fonction owner(). */
  owner?: string;
  /** Signatures de fonctions à inclure dans le bytecode (PUSH4 <sélecteur>). */
  functions?: string[];
}

/** Bytecode factice contenant un PUSH4 par fonction (détection des capacités). */
export function fakeBytecode(functions: string[] = []): string {
  return `0x6080604052${functions.map((f) => `63${toFunctionSelector(f).slice(2)}`).join('14')}00`;
}

class Revert extends Error {}

export class MockEvmNode {
  block = 1_000;
  readonly logs: Array<RawLog & { blockNumber: number; transactionHash: string; logIndex: number }> = [];
  readonly tokens = new Map<string, MockToken>();
  readonly txs = new Map<string, { from: string; to: string }>();
  readonly nonces = new Map<string, number>();
  readonly native = new Map<string, bigint>();
  readonly calls = new Map<string, number>();

  constructor(
    readonly chainId: number,
    readonly multicall: string,
  ) {}

  addToken(address: string, token: MockToken): void {
    this.tokens.set(address.toLowerCase(), token);
  }

  /** Ajoute des logs dans un nouveau bloc ; retourne le hash de transaction utilisé. */
  mine(entries: RawLog[], tx?: { hash?: string; from?: string }): string {
    this.block++;
    const hash = tx?.hash ?? randomHash();
    if (tx?.from) this.txs.set(hash, { from: tx.from.toLowerCase(), to: entries[0]?.address ?? randomAddress() });
    entries.forEach((log, i) => this.logs.push({ ...log, blockNumber: this.block, transactionHash: hash, logIndex: i }));
    return hash;
  }

  private tokenCall(to: string, data: Hex): Hex {
    const token = this.tokens.get(to.toLowerCase());
    if (!token) throw new Revert('pas de contrat');
    const { functionName, args } = decodeFunctionData({ abi: TOKEN_ABI, data });
    let result: unknown;
    switch (functionName) {
      case 'name':
        result = token.name;
        break;
      case 'symbol':
        result = token.symbol;
        break;
      case 'decimals':
        result = token.decimals;
        break;
      case 'totalSupply':
        result = token.totalSupply;
        break;
      case 'balanceOf':
        result = token.balances.get(String(args?.[0]).toLowerCase()) ?? 0n;
        break;
      case 'owner':
        if (token.owner === undefined) throw new Revert('pas de owner()');
        result = token.owner;
        break;
      default:
        throw new Revert('fonction absente');
    }
    return encodeFunctionResult({ abi: TOKEN_ABI, functionName, result } as never);
  }

  private ethCall(to: string, data: Hex): Hex {
    if (to.toLowerCase() === this.multicall.toLowerCase()) {
      const { args } = decodeFunctionData({ abi: multicall3Abi, data });
      const calls = (args?.[0] ?? []) as unknown as ReadonlyArray<{ target: string; callData: Hex }>;
      const results = calls.map(({ target, callData }) => {
        try {
          return { success: true, returnData: this.tokenCall(target, callData) };
        } catch {
          return { success: false, returnData: '0x' as Hex };
        }
      });
      return encodeFunctionResult({ abi: multicall3Abi, functionName: 'aggregate3', result: results } as never);
    }
    return this.tokenCall(to, data);
  }

  handle(method: string, params: unknown[]): unknown {
    this.calls.set(method, (this.calls.get(method) ?? 0) + 1);
    const hex = (n: number | bigint) => `0x${n.toString(16)}`;
    switch (method) {
      case 'eth_chainId':
        return hex(this.chainId);
      case 'eth_blockNumber':
        return hex(this.block);
      case 'eth_getLogs': {
        const filter = params[0] as { fromBlock: string; toBlock: string; topics?: string[][] };
        const from = Number.parseInt(filter.fromBlock, 16);
        const to = Number.parseInt(filter.toBlock, 16);
        const wanted = filter.topics?.[0];
        return this.logs
          .filter((l) => l.blockNumber >= from && l.blockNumber <= to && (!wanted || wanted.includes(l.topics[0]!)))
          .map((l) => ({
            address: l.address,
            topics: l.topics,
            data: l.data,
            blockNumber: hex(l.blockNumber),
            transactionHash: l.transactionHash,
            logIndex: hex(l.logIndex),
            removed: false,
          }));
      }
      case 'eth_call': {
        const call = params[0] as { to: string; data: Hex };
        return this.ethCall(call.to, call.data);
      }
      case 'eth_getCode': {
        const token = this.tokens.get(String(params[0]).toLowerCase());
        return token ? fakeBytecode(token.functions) : '0x';
      }
      case 'eth_getStorageAt':
        return `0x${'0'.repeat(64)}`;
      case 'eth_getTransactionByHash': {
        const hash = String(params[0]);
        const tx = this.txs.get(hash);
        if (!tx) return null;
        return {
          hash,
          from: tx.from,
          to: tx.to,
          blockHash: randomHash(),
          blockNumber: hex(this.block),
          transactionIndex: '0x0',
          nonce: '0x1',
          gas: '0x5208',
          gasPrice: '0x3b9aca00',
          input: '0x',
          value: '0x0',
          type: '0x0',
          chainId: hex(this.chainId),
          v: '0x1b',
          r: randomHash(),
          s: randomHash(),
        };
      }
      case 'eth_getTransactionCount':
        return hex(this.nonces.get(String(params[0]).toLowerCase()) ?? 0);
      case 'eth_getBalance':
        return hex(this.native.get(String(params[0]).toLowerCase()) ?? 0n);
      default:
        throw new Error(`méthode non simulée : ${method}`);
    }
  }
}

/** Démarre un serveur JSON-RPC HTTP (requêtes simples ou groupées). */
export async function startMockEvm(node: MockEvmNode): Promise<{ url: string; server: Server }> {
  const answer = (request: { id: number; method: string; params?: unknown[] }) => {
    try {
      return { jsonrpc: '2.0', id: request.id, result: node.handle(request.method, request.params ?? []) };
    } catch (error) {
      if (error instanceof Revert) return { jsonrpc: '2.0', id: request.id, error: { code: 3, message: 'execution reverted', data: '0x' } };
      return { jsonrpc: '2.0', id: request.id, error: { code: -32601, message: (error as Error).message } };
    }
  };
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      const parsed = JSON.parse(body) as unknown;
      const payload = Array.isArray(parsed) ? parsed.map((r) => answer(r as never)) : answer(parsed as never);
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(payload));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, server };
}
