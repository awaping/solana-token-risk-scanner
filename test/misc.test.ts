import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Keypair, PublicKey } from '@solana/web3.js';
import { classifyOwner } from '../src/analyzers/holders.js';
import { decodeMetaplexMetadata } from '../src/analyzers/token.js';
import { maskRpcUrl } from '../src/config.js';
import {
  INCINERATOR_ADDRESS,
  PUMPSWAP_PROGRAM_ID,
  RAYDIUM_AMM_V4_AUTHORITY,
  SYSTEM_PROGRAM_ID,
} from '../src/constants.js';
import { createLimiter, isTransientError } from '../src/rpc/client.js';
import { describeError } from '../src/scanner.js';
import { encodeMetaplexMetadata } from './fixtures/encoders.js';
import { padEndVisible, sanitizeLabel, truncateVisible, visibleLength } from '../src/utils/format.js';

test('maskRpcUrl : masque les clés d’API (query string et chemin)', () => {
  assert.equal(maskRpcUrl('https://mainnet.helius-rpc.com/?api-key=secret123'), 'https://mainnet.helius-rpc.com/?api-key=***');
  assert.equal(
    maskRpcUrl('https://solana-mainnet.g.alchemy.com/v2/abcdefghijklmnopqrstuvwxyz012345'),
    'https://solana-mainnet.g.alchemy.com/v2/***',
  );
  assert.equal(maskRpcUrl('https://api.mainnet-beta.solana.com'), 'https://api.mainnet-beta.solana.com/');
});

test('isTransientError : rejoue les 429 / timeouts, pas les erreurs métier', () => {
  assert.equal(isTransientError(new Error('429 Too Many Requests')), true);
  assert.equal(isTransientError(new Error('fetch failed')), true);
  assert.equal(isTransientError(new Error('503 Service Unavailable')), true);
  assert.equal(isTransientError(new Error('Invalid param: WrongSize')), false);
});

test('describeError : messages RPC traduits', () => {
  assert.match(describeError(new Error('excluded from account secondary indexes')), /index secondaire/);
  assert.match(describeError(new Error('429 Too Many Requests')), /RPC saturé/);
});

test('createLimiter : ne dépasse jamais la concurrence demandée', async () => {
  const limit = createLimiter(2);
  let active = 0;
  let peak = 0;
  await Promise.all(
    Array.from({ length: 8 }, () =>
      limit(async () => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 5));
        active--;
      }),
    ),
  );
  assert.equal(peak, 2);
});

test('classifyOwner : burn, bonding curve, pools, créateur, wallet, PDA', () => {
  const curve = Keypair.generate().publicKey.toBase58();
  const creator = Keypair.generate().publicKey.toBase58();
  const ctx = { bondingCurve: curve, creator };
  const system = SYSTEM_PROGRAM_ID.toBase58();

  assert.equal(classifyOwner(INCINERATOR_ADDRESS.toBase58(), null, ctx).kind, 'burn');
  assert.equal(classifyOwner(curve, null, ctx).kind, 'bonding-curve');
  assert.deepEqual(classifyOwner(RAYDIUM_AMM_V4_AUTHORITY.toBase58(), system, ctx), {
    kind: 'liquidity-pool',
    label: 'Raydium AMM v4',
  });
  assert.equal(classifyOwner(Keypair.generate().publicKey.toBase58(), PUMPSWAP_PROGRAM_ID.toBase58(), ctx).label, 'PumpSwap');
  assert.equal(classifyOwner(creator, system, ctx).kind, 'creator');
  assert.equal(classifyOwner(Keypair.generate().publicKey.toBase58(), system, ctx).kind, 'wallet');
  assert.equal(classifyOwner(Keypair.generate().publicKey.toBase58(), Keypair.generate().publicKey.toBase58(), ctx).kind, 'program');
  const pda = PublicKey.findProgramAddressSync([Buffer.from('x')], SYSTEM_PROGRAM_ID)[0].toBase58();
  assert.equal(classifyOwner(pda, null, ctx).kind, 'program');
});

test('decodeMetaplexMetadata : nom, symbole et mutabilité', () => {
  const mint = Keypair.generate().publicKey;
  const data = encodeMetaplexMetadata({ updateAuthority: mint, mint, name: 'Popcat', symbol: 'POP', isMutable: true });
  const meta = decodeMetaplexMetadata(data);
  assert.equal(meta?.name, 'Popcat');
  assert.equal(meta?.symbol, 'POP');
  assert.equal(meta?.isMutable, true);
  assert.equal(meta?.mint, mint.toBase58());
  assert.equal(decodeMetaplexMetadata(Buffer.alloc(20)), null);
});

test('largeur terminal : emoji et idéogrammes sur 2 colonnes, caractères invisibles ignorés', () => {
  assert.equal(visibleLength('ABC'), 3);
  assert.equal(visibleLength('🐸PEPE'), 6);
  assert.equal(visibleLength('猫猫'), 4);
  assert.equal(visibleLength('x​y‮'), 2);
  assert.equal(visibleLength('\u001b[1mBOLD\u001b[0m'), 4);
  // Troncature sans couper un emoji en deux (pas de demi-paire de substitution).
  assert.equal(truncateVisible('🐸🐸🐸', 5), '🐸🐸');
  assert.equal(truncateVisible('\u001b[1mABCDEF\u001b[0m', 3), '\u001b[1mABC\u001b[0m');
  assert.equal(padEndVisible('🐸A', 5), '🐸A  ');
  assert.equal(sanitizeLabel(' Evil‮Coin\u0007 ​'), 'EvilCoin');
});
