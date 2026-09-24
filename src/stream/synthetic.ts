/**
 * Générateurs de transactions Pump.fun synthétiques (logs + événements Anchor
 * encodés en Borsh). Utilisés par le préchauffage JIT du mode stream, les
 * tests, le benchmark et les démos.
 */
import { randomBytes } from 'node:crypto';
import bs58 from 'bs58';
import { PublicKey } from '@solana/web3.js';
import { PUMP_FUN_PROGRAM_ID } from '../constants.js';
import { anchorEventDiscriminator } from './events.js';

const PUMP = PUMP_FUN_PROGRAM_ID.toBase58();
const METAPLEX = 'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s';
const COMPUTE_BUDGET = 'ComputeBudget111111111111111111111111111111';

/** Adresse aléatoire (32 octets ; pas forcément sur la courbe, sans importance ici). */
export const key = () => bs58.encode(randomBytes(32));

const str = (value: string) => {
  const bytes = Buffer.from(value, 'utf8');
  const len = Buffer.alloc(4);
  len.writeUInt32LE(bytes.length);
  return Buffer.concat([len, bytes]);
};
const u64 = (value: bigint) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(value);
  return b;
};
const i64 = (value: number) => {
  const b = Buffer.alloc(8);
  b.writeBigInt64LE(BigInt(value));
  return b;
};
const pk = (value: string) => new PublicKey(value).toBuffer();

export function encodeCreateEvent(e: {
  name: string;
  symbol: string;
  uri?: string;
  mint: string;
  bondingCurve?: string;
  user: string;
  creator?: string;
  legacy?: boolean;
}): string {
  const parts = [
    anchorEventDiscriminator('CreateEvent'),
    str(e.name),
    str(e.symbol),
    str(e.uri ?? 'https://ipfs.io/ipfs/x'),
    pk(e.mint),
    pk(e.bondingCurve ?? key()),
    pk(e.user),
  ];
  if (!e.legacy) {
    parts.push(
      pk(e.creator ?? e.user),
      i64(Math.floor(Date.now() / 1000)),
      u64(1_073_000_000_000_000n),
      u64(30_000_000_000n),
      u64(793_100_000_000_000n),
      u64(1_000_000_000_000_000n),
    );
  }
  return Buffer.concat(parts).toString('base64');
}

export function encodeTradeEvent(e: { mint: string; user: string; isBuy: boolean; sol: bigint; tokens: bigint }): string {
  return Buffer.concat([
    anchorEventDiscriminator('TradeEvent'),
    pk(e.mint),
    u64(e.sol),
    u64(e.tokens),
    Buffer.from([e.isBuy ? 1 : 0]),
    pk(e.user),
    i64(Math.floor(Date.now() / 1000)),
    u64(30_000_000_000n + e.sol),
    u64(1_073_000_000_000_000n - e.tokens),
    u64(e.sol),
    u64(793_100_000_000_000n - e.tokens),
  ]).toString('base64');
}

const wrap = (instruction: string, data: string[], inner: string[] = []) => [
  `Program ${PUMP} invoke [1]`,
  `Program log: Instruction: ${instruction}`,
  ...inner,
  ...data.map((d) => `Program data: ${d}`),
  `Program ${PUMP} consumed 41234 of 200000 compute units`,
  `Program ${PUMP} success`,
];

/** Logs d'une transaction de création (+ achat du dev optionnel dans la même tx). */
export function createTxLogs(opts: {
  mint: string;
  creator: string;
  name?: string;
  symbol?: string;
  devBuyTokens?: bigint;
  devBuySol?: bigint;
  truncated?: boolean;
  legacy?: boolean;
}): string[] {
  const logs = [
    `Program ${COMPUTE_BUDGET} invoke [1]`,
    `Program ${COMPUTE_BUDGET} success`,
    ...wrap(
      'Create',
      opts.truncated
        ? []
        : [encodeCreateEvent({ name: opts.name ?? 'Test', symbol: opts.symbol ?? 'TEST', mint: opts.mint, user: opts.creator, legacy: opts.legacy })],
      [`Program ${METAPLEX} invoke [2]`, 'Program log: IX: Create Metadata Accounts v3', `Program ${METAPLEX} success`],
    ),
  ];
  if (opts.devBuyTokens) {
    logs.push(...wrap('Buy', [encodeTradeEvent({ mint: opts.mint, user: opts.creator, isBuy: true, sol: opts.devBuySol ?? 1_000_000_000n, tokens: opts.devBuyTokens })]));
  }
  if (opts.truncated) logs.push('Log truncated');
  return logs;
}

export function tradeTxLogs(opts: { mint: string; user: string; isBuy?: boolean; sol?: bigint; tokens?: bigint }): string[] {
  return wrap(opts.isBuy === false ? 'Sell' : 'Buy', [
    encodeTradeEvent({
      mint: opts.mint,
      user: opts.user,
      isBuy: opts.isBuy !== false,
      sol: opts.sol ?? 500_000_000n,
      tokens: opts.tokens ?? 17_000_000_000_000n,
    }),
  ]);
}

/** Signature aléatoire (64 octets en base58). */
export const signature = () => bs58.encode(randomBytes(64));
