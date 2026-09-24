import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Keypair, PublicKey } from '@solana/web3.js';
import {
  BONDING_CURVE_DISCRIMINATOR,
  bondingCurvePda,
  bondingCurvePriceSol,
  bondingCurveProgress,
  decodeBondingCurve,
  rentExemptMinimum,
} from '../src/analyzers/pumpfun.js';
import { PUMP_FUN } from '../src/constants.js';
import { encodeBondingCurve } from './fixtures/encoders.js';

test('discriminateur Anchor BondingCurve', () => {
  assert.deepEqual([...BONDING_CURVE_DISCRIMINATOR], [23, 183, 248, 55, 96, 216, 172, 96]);
});

test('PDA de bonding curve déterministe', () => {
  const mint = Keypair.generate().publicKey;
  assert.ok(bondingCurvePda(mint).equals(bondingCurvePda(mint)));
  assert.equal(PublicKey.isOnCurve(bondingCurvePda(mint).toBytes()), false);
});

test('décodage, prix, progression et couverture de la réserve', () => {
  const creator = Keypair.generate().publicKey;
  // État après ~20 SOL achetés : x·y = k conservé.
  const k = PUMP_FUN.INITIAL_VIRTUAL_TOKEN_RESERVES * PUMP_FUN.INITIAL_VIRTUAL_SOL_RESERVES;
  const virtualSol = 50_000_000_000n;
  const virtualTokens = k / virtualSol;
  const sold = PUMP_FUN.INITIAL_VIRTUAL_TOKEN_RESERVES - virtualTokens;
  const data = encodeBondingCurve({
    virtualTokenReserves: virtualTokens,
    virtualSolReserves: virtualSol,
    realTokenReserves: PUMP_FUN.INITIAL_REAL_TOKEN_RESERVES - sold,
    realSolReserves: 20_000_000_000n,
    creator,
  });
  const lamports = 20_000_000_000n + rentExemptMinimum(data.length);
  const curve = decodeBondingCurve(Keypair.generate().publicKey, data, lamports);
  assert.ok(curve);
  assert.equal(curve.creator, creator.toBase58());
  assert.equal(curve.complete, false);
  assert.equal(curve.backingLamports, 20_000_000_000n);

  // prix = 50 SOL / 643,8 M tokens ≈ 7,77e-8 SOL
  const price = bondingCurvePriceSol(curve, 6).toNumber();
  assert.ok(Math.abs(price - 50 / 643.8e6) / price < 1e-3);

  const progress = bondingCurveProgress(curve);
  assert.ok(progress > 50 && progress < 60, `progression ${progress}`);
});

test('données invalides : null', () => {
  assert.equal(decodeBondingCurve(PublicKey.default, Buffer.alloc(150), 0n), null);
  assert.equal(decodeBondingCurve(PublicKey.default, Buffer.alloc(10), 0n), null);
});
