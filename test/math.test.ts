import { test } from 'node:test';
import assert from 'node:assert/strict';
import { distribution, gini, percentOf, piecewise } from '../src/utils/math.js';

test('distribution : moyenne, variance et écart-type de population', () => {
  const d = distribution([2, 4, 4, 4, 5, 5, 7, 9]);
  assert.equal(d.mean, 5);
  assert.equal(d.variance, 4);
  assert.equal(d.stdDev, 2);
  assert.equal(d.coefficientOfVariation, 0.4);
});

test('distribution : série vide et bigint au-delà de 2^53', () => {
  assert.equal(distribution([]).n, 0);
  const big = 2n ** 60n;
  const d = distribution([big, big, big]);
  assert.equal(d.stdDev, 0);
  assert.equal(d.coefficientOfVariation, 0);
});

test('gini : 0 pour une égalité parfaite, élevé pour une concentration', () => {
  assert.equal(gini([10, 10, 10, 10]), 0);
  assert.ok(gini([0, 0, 0, 100]) > 0.7);
});

test('percentOf : précision sur des montants u64', () => {
  assert.equal(percentOf(250n, 1000n), 25);
  assert.equal(percentOf(1n, 0n), 0);
  assert.equal(percentOf(2n ** 63n, 2n ** 64n), 50);
  assert.equal(percentOf(1n, 10n ** 18n), 1e-16);
});

test('piecewise : interpolation linéaire et bornes', () => {
  const pts = [[10, 0], [40, 60], [70, 100]] as const;
  assert.equal(piecewise(5, pts), 0);
  assert.equal(piecewise(25, pts), 30);
  assert.equal(piecewise(55, pts), 80);
  assert.equal(piecewise(1000, pts), 100);
  assert.equal(piecewise(Number.NaN, pts), 0);
});
