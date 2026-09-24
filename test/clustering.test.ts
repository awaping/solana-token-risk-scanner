import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeClustering, detectClusters } from '../src/analyzers/clustering.js';
import { holder, zipfHolders } from './helpers.js';

test('distribution organique (Zipf) : forte dispersion, aucun cluster', () => {
  const result = analyzeClustering(zipfHolders(20, 6));
  assert.ok(result.coefficientOfVariation > 0.9, `CV attendu > 0.9, obtenu ${result.coefficientOfVariation}`);
  assert.equal(result.clusters.length, 0);
});

test('wallets clonés : soldes strictement identiques détectés', () => {
  const clones = Array.from({ length: 8 }, () => holder(2));
  const result = analyzeClustering([holder(9), ...clones, holder(0.5), holder(0.3)]);
  assert.ok(result.largestCluster);
  assert.equal(result.largestCluster.owners.length, 8);
  assert.equal(result.largestCluster.strictClone, true);
  assert.ok(Math.abs(result.largestCluster.totalPct - 16) < 1e-9);
});

test('cluster proche : parts identiques à 0,1 point près mais non strictement égales', () => {
  const near = [3.0, 2.97, 2.95, 2.92, 2.9].map((pct) => holder(pct));
  const clusters = detectClusters([holder(12), ...near, holder(1)]);
  assert.equal(clusters.length, 1);
  assert.equal(clusters[0]!.owners.length, 5);
  assert.equal(clusters[0]!.strictClone, false);
  assert.ok(clusters[0]!.spreadPct <= 0.1 + 1e-9);
});

test('tolérance relative : la traîne de petites positions ne forme pas de faux cluster', () => {
  // 0,1 point autour de 0,3 % représenterait 33 % d'écart : tolérance ramenée à 5 %.
  const tail = [0.4, 0.34, 0.3, 0.26, 0.22].map((pct) => holder(pct));
  assert.equal(detectClusters(tail).length, 0);
});

test('distribution uniforme : coefficient de variation proche de 0', () => {
  const uniform = Array.from({ length: 15 }, (_, i) => holder(1.5 + (i % 3) * 0.01));
  const result = analyzeClustering(uniform);
  assert.ok(result.coefficientOfVariation < 0.02);
  assert.ok(result.gini < 0.01);
});
