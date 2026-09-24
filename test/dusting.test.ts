import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dustThresholdRaw, summarizeDusting } from '../src/analyzers/dusting.js';
import { SUPPLY } from './helpers.js';

test('seuil de poussière = 0,001 % de la supply', () => {
  assert.equal(dustThresholdRaw(SUPPLY, 0.001), 10_000_000_000n); // 10 000 tokens à 6 décimales
});

test('compteur gonflé : 900 wallets poussière sur 1000', () => {
  const balances = [
    ...Array.from({ length: 100 }, (_, i) => ({ owner: `real${i}`, amount: 5_000_000_000_000n })),
    ...Array.from({ length: 900 }, (_, i) => ({ owner: `dust${i}`, amount: 1n })),
    { owner: 'empty', amount: 0n },
  ];
  const d = summarizeDusting(balances, SUPPLY);
  assert.equal(d.totalHolders, 1000);
  assert.equal(d.dustHolders, 900);
  assert.equal(d.effectiveHolders, 100);
  assert.equal(d.emptyAccounts, 1);
  assert.equal(d.dustRatio, 0.9);
});

test('agrégation par propriétaire : plusieurs comptes poussière = un holder significatif', () => {
  const balances = Array.from({ length: 5 }, () => ({ owner: 'same', amount: 3_000_000_000n }));
  const d = summarizeDusting(balances, SUPPLY);
  assert.equal(d.totalHolders, 1);
  assert.equal(d.dustHolders, 0);
});
