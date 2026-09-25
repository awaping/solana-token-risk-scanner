/**
 * Audit on-chain d'un token EVM récemment listé (lectures RPC uniquement).
 *
 *   - métadonnées ERC-20 : nom, symbole, décimales, supply ;
 *   - propriétaire : owner() / getOwner(), renoncé ou non ;
 *   - bytecode : présence (sélecteurs PUSH4) de fonctions de mint, blacklist,
 *     pause, taxes modifiables, limites ; proxy EIP-1967 modifiable ;
 *   - créateur (émetteur de la transaction de création de pool) : nonce,
 *     solde natif, part de la supply détenue ;
 *   - pool : liquidité en devise de cotation, part des LP brûlés (v2).
 *
 * Limite assumée : aucune simulation d'achat / vente (honeypot, taxes réelles).
 */
import { parseAbi, toFunctionSelector, type Address, type Hex, type PublicClient } from 'viem';
import type { EvmChain } from '../chains/registry.js';
import { ZERO_ADDRESS, type PoolCreated } from './events.js';

export const DEAD_ADDRESS = '0x000000000000000000000000000000000000dead';

const ERC20_ABI = parseAbi([
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function totalSupply() view returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
  'function owner() view returns (address)',
  'function getOwner() view returns (address)',
]);

/** Emplacement de l'implémentation d'un proxy EIP-1967. */
const EIP1967_IMPLEMENTATION_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
/** Préfixe d'un clone minimal EIP-1167 (non modifiable). */
const EIP1167_PREFIX = '363d3d373d3d3d363d73';

export const CAPABILITY_SIGNATURES = {
  mint: ['mint(address,uint256)', 'mint(uint256)', 'mintTo(address,uint256)', 'issue(uint256)'],
  blacklist: [
    'blacklist(address)',
    'blacklistAddress(address)',
    'addToBlacklist(address)',
    'addBlackList(address)',
    'setBlacklist(address,bool)',
    'setBlackList(address,bool)',
    'setIsBlacklisted(address,bool)',
    'updateBlacklist(address,bool)',
    'setBots(address[],bool)',
    'addBots(address[])',
    'setBot(address,bool)',
    'blockBots(address[])',
    'setSniper(address,bool)',
  ],
  pause: ['pause()', 'setPaused(bool)', 'setTradingEnabled(bool)', 'setTradingStatus(bool)', 'disableTrading()'],
  fees: [
    'setFee(uint256)',
    'setFees(uint256,uint256)',
    'setTaxes(uint256,uint256)',
    'setBuyTax(uint256)',
    'setSellTax(uint256)',
    'setBuyFee(uint256)',
    'setSellFee(uint256)',
    'updateFees(uint256,uint256)',
    'setTaxFeePercent(uint256)',
    'setSwapTaxes(uint256,uint256)',
    'updateBuyFees(uint256,uint256,uint256)',
    'updateSellFees(uint256,uint256,uint256)',
  ],
  limits: ['setMaxTxAmount(uint256)', 'setMaxWalletSize(uint256)', 'setMaxWallet(uint256)', 'updateMaxTxnAmount(uint256)', 'updateMaxWalletAmount(uint256)'],
} as const;

export type Capability = keyof typeof CAPABILITY_SIGNATURES;

const CAPABILITY_SELECTORS: Record<Capability, string[]> = Object.fromEntries(
  Object.entries(CAPABILITY_SIGNATURES).map(([k, sigs]) => [k, sigs.map((s) => toFunctionSelector(s).slice(2).toLowerCase())]),
) as Record<Capability, string[]>;

/** Fonctions présentes dans le dispatcher (recherche des PUSH4 <sélecteur>). */
export function detectCapabilities(code: string): Record<Capability, string[]> {
  const hex = code.toLowerCase();
  const found = {} as Record<Capability, string[]>;
  (Object.keys(CAPABILITY_SELECTORS) as Capability[]).forEach((cap) => {
    found[cap] = CAPABILITY_SIGNATURES[cap].filter((_sig, i) => hex.includes(`63${CAPABILITY_SELECTORS[cap][i]}`));
  });
  return found;
}

export interface QuoteInfo {
  address: string;
  symbol: string;
  decimals: number;
}

export interface EvmTokenAudit {
  name?: string;
  symbol?: string;
  decimals: number;
  totalSupply: bigint;
  /** Adresse du propriétaire ; null si le contrat n'expose pas owner(). */
  owner: string | null;
  ownerRenounced: boolean;
  codeSize: number;
  proxy: 'none' | 'eip1967' | 'clone';
  capabilities: Record<Capability, string[]>;
  creator?: string;
  creatorNonce?: number;
  creatorNative?: number;
  creatorBalance?: bigint;
  /** Part de la supply détenue par le créateur (%). */
  devPct?: number;
  quote: QuoteInfo;
  /** Liquidité côté devise de cotation (unités UI) ; absente pour v4. */
  liquidityQuote?: number;
  /** Part des LP brûlés (v2 / Solidly uniquement). */
  lpBurnedPct?: number;
  auditedAt: number;
}

export interface AuditInput {
  token: string;
  quote: string;
  pool: PoolCreated;
  creationTx: string;
}

const pct = (part: bigint, total: bigint) => (total === 0n ? 0 : Number((part * 1_000_000n) / total) / 10_000);
const toUi = (raw: bigint, decimals: number) => Number(raw) / 10 ** decimals;

type Call = { address: Address; functionName: string; args?: readonly unknown[] };

/** Lectures groupées via Multicall3 quand la chaîne le permet, sinon une par une. */
async function readMany(client: PublicClient, chain: EvmChain, calls: Call[]): Promise<Array<unknown | undefined>> {
  if (chain.viem.contracts?.multicall3) {
    // Typage dynamique volontaire : les appels sont construits à l'exécution.
    const results = (await client.multicall({
      contracts: calls.map((c) => ({ ...c, abi: ERC20_ABI })) as never,
      allowFailure: true,
    })) as unknown as Array<{ status: 'success' | 'failure'; result?: unknown }>;
    return results.map((r) => (r.status === 'success' ? r.result : undefined));
  }
  return Promise.all(
    calls.map((c) =>
      client
        .readContract({ address: c.address, abi: ERC20_ABI, functionName: c.functionName as never, args: c.args as never })
        .catch(() => undefined),
    ),
  );
}

const quoteCache = new Map<string, QuoteInfo>();

export async function quoteInfo(client: PublicClient, chain: EvmChain, address: string): Promise<QuoteInfo> {
  const key = `${chain.chainId}:${address}`;
  const cached = quoteCache.get(key);
  if (cached) return cached;
  let info: QuoteInfo;
  if (address === ZERO_ADDRESS) {
    info = { address, symbol: chain.nativeSymbol, decimals: chain.nativeDecimals };
  } else {
    const [symbol, decimals] = await readMany(client, chain, [
      { address: address as Address, functionName: 'symbol' },
      { address: address as Address, functionName: 'decimals' },
    ]);
    info = {
      address,
      symbol: typeof symbol === 'string' ? symbol : (chain.wrappedNative?.address === address ? chain.wrappedNative.symbol : '?'),
      decimals: typeof decimals === 'number' ? decimals : 18,
    };
  }
  quoteCache.set(key, info);
  return info;
}

/** Liquidité côté devise de cotation d'une pool (unités UI) ; undefined pour v4. */
export async function readLiquidity(client: PublicClient, chain: EvmChain, pool: PoolCreated, quote: QuoteInfo): Promise<number | undefined> {
  if (pool.dex === 'v4') return undefined;
  if (quote.address === ZERO_ADDRESS) {
    return toUi(await client.getBalance({ address: pool.poolAddress as Address }), quote.decimals);
  }
  const [balance] = await readMany(client, chain, [
    { address: quote.address as Address, functionName: 'balanceOf', args: [pool.poolAddress] },
  ]);
  return typeof balance === 'bigint' ? toUi(balance, quote.decimals) : undefined;
}

export async function auditToken(client: PublicClient, chain: EvmChain, input: AuditInput): Promise<EvmTokenAudit> {
  const token = input.token as Address;
  const [meta, code, implSlot, tx, quote] = await Promise.all([
    readMany(client, chain, [
      { address: token, functionName: 'name' },
      { address: token, functionName: 'symbol' },
      { address: token, functionName: 'decimals' },
      { address: token, functionName: 'totalSupply' },
      { address: token, functionName: 'owner' },
      { address: token, functionName: 'getOwner' },
    ]),
    client.getCode({ address: token }).catch(() => undefined),
    client.getStorageAt({ address: token, slot: EIP1967_IMPLEMENTATION_SLOT as Hex }).catch(() => undefined),
    client.getTransaction({ hash: input.creationTx as Hex }).catch(() => undefined),
    quoteInfo(client, chain, input.quote),
  ]);

  const [name, symbol, decimals, totalSupply, owner, getOwner] = meta;
  const ownerAddress = typeof owner === 'string' ? owner.toLowerCase() : typeof getOwner === 'string' ? getOwner.toLowerCase() : null;

  // Proxy : l'analyse des fonctions porte sur le code de l'implémentation.
  let proxy: EvmTokenAudit['proxy'] = 'none';
  let analysedCode = code ?? '0x';
  const implementation = implSlot && BigInt(implSlot) !== 0n ? (`0x${implSlot.slice(-40)}` as Address) : undefined;
  if (implementation) {
    proxy = 'eip1967';
    analysedCode = (await client.getCode({ address: implementation }).catch(() => undefined)) ?? analysedCode;
  } else if (analysedCode.slice(2, 2 + EIP1167_PREFIX.length).toLowerCase() === EIP1167_PREFIX) {
    proxy = 'clone';
    const target = `0x${analysedCode.slice(2 + EIP1167_PREFIX.length, 2 + EIP1167_PREFIX.length + 40)}` as Address;
    analysedCode = (await client.getCode({ address: target }).catch(() => undefined)) ?? analysedCode;
  }

  const supply = typeof totalSupply === 'bigint' ? totalSupply : 0n;
  const audit: EvmTokenAudit = {
    name: typeof name === 'string' ? name : undefined,
    symbol: typeof symbol === 'string' ? symbol : undefined,
    decimals: typeof decimals === 'number' ? decimals : 18,
    totalSupply: supply,
    owner: ownerAddress,
    ownerRenounced: ownerAddress === null || ownerAddress === ZERO_ADDRESS || ownerAddress === DEAD_ADDRESS,
    codeSize: code ? (code.length - 2) / 2 : 0,
    proxy,
    capabilities: detectCapabilities(analysedCode),
    quote,
    auditedAt: Date.now(),
  };

  // Créateur et pool, en parallèle.
  const creator = tx?.from?.toLowerCase();
  const tasks: Array<Promise<void>> = [];
  if (creator) {
    audit.creator = creator;
    tasks.push(
      (async () => {
        const [nonce, native, [balance]] = await Promise.all([
          client.getTransactionCount({ address: creator as Address }).catch(() => undefined),
          client.getBalance({ address: creator as Address }).catch(() => undefined),
          readMany(client, chain, [{ address: token, functionName: 'balanceOf', args: [creator] }]),
        ]);
        audit.creatorNonce = nonce;
        audit.creatorNative = native !== undefined ? toUi(native, chain.nativeDecimals) : undefined;
        if (typeof balance === 'bigint') {
          audit.creatorBalance = balance;
          audit.devPct = pct(balance, supply);
        }
      })(),
    );
  }
  tasks.push(
    readLiquidity(client, chain, input.pool, quote).then((liquidity) => {
      audit.liquidityQuote = liquidity;
    }),
  );
  if (input.pool.dex === 'v2' || input.pool.dex === 'solidly') {
    const lp = input.pool.poolAddress as Address;
    tasks.push(
      readMany(client, chain, [
        { address: lp, functionName: 'totalSupply' },
        { address: lp, functionName: 'balanceOf', args: [DEAD_ADDRESS] },
        { address: lp, functionName: 'balanceOf', args: [ZERO_ADDRESS] },
      ]).then(([lpSupply, dead, zero]) => {
        if (typeof lpSupply === 'bigint' && lpSupply > 0n) {
          const burned = (typeof dead === 'bigint' ? dead : 0n) + (typeof zero === 'bigint' ? zero : 0n);
          audit.lpBurnedPct = pct(burned, lpSupply);
        }
      }),
    );
  }
  await Promise.all(tasks.map((t) => t.catch(() => undefined)));
  return audit;
}

/** Relecture périodique : solde du créateur et liquidité (détection de vente du dev / retrait de liquidité). */
export async function refreshToken(
  client: PublicClient,
  chain: EvmChain,
  input: { token: string; pool: PoolCreated; audit: EvmTokenAudit },
): Promise<{ creatorBalance?: bigint; liquidityQuote?: number }> {
  const { audit } = input;
  const [balanceResult, liquidity] = await Promise.all([
    audit.creator
      ? readMany(client, chain, [{ address: input.token as Address, functionName: 'balanceOf', args: [audit.creator] }])
      : Promise.resolve([undefined]),
    readLiquidity(client, chain, input.pool, audit.quote).catch(() => undefined),
  ]);
  const balance = balanceResult[0];
  return { creatorBalance: typeof balance === 'bigint' ? balance : undefined, liquidityQuote: liquidity };
}
