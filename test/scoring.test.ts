import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Keypair } from '@solana/web3.js';
import { analyzeClustering } from '../src/analyzers/clustering.js';
import { summarizeHolders } from '../src/analyzers/holders.js';
import { computeRiskScore, levelFor, type ScoringInput } from '../src/scoring/engine.js';
import type { CreatorAnalysis, DustingAnalysis, Holder, ReserveAnalysis, TokenInfo } from '../src/types.js';
import { holder, SUPPLY, zipfHolders } from './helpers.js';

const token = (overrides: Partial<TokenInfo> = {}): TokenInfo => ({
  mint: Keypair.generate().publicKey.toBase58(),
  programLabel: 'SPL Token',
  programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  decimals: 6,
  supply: SUPPLY,
  mintAuthority: null,
  freezeAuthority: null,
  extensions: [],
  dangerousExtensions: [],
  ...overrides,
});

const dusting = (ratio: number, total = 2000): DustingAnalysis => ({
  totalHolders: total,
  dustHolders: Math.round(total * ratio),
  emptyAccounts: 10,
  dustRatio: ratio,
  effectiveHolders: total - Math.round(total * ratio),
  dustThresholdPct: 0.001,
  dustThresholdRaw: 10_000_000_000n,
});

const poolReserve = (sol: number, ratio: number): ReserveAnalysis => ({
  marketType: 'amm-pool',
  venue: 'PumpSwap',
  pools: [],
  realReserveSol: sol,
  totalReserveSol: sol,
  priceSol: 1e-6,
  marketCapSol: sol / ratio,
  reserveToMcapRatio: ratio,
  searchErrors: [],
});

const creator = (overrides: Partial<CreatorAnalysis> = {}): CreatorAnalysis => ({
  address: Keypair.generate().publicKey.toBase58(),
  source: 'pump.fun bonding curve',
  solBalance: 12,
  holdingPct: 1.5,
  createdMints: [],
  previousTokensCreated: 0,
  txScanned: 150,
  fullHistory: false,
  signatureCount: 150,
  ...overrides,
});

function input(wallets: Holder[], extra: Partial<ScoringInput> = {}): ScoringInput {
  const holders = summarizeHolders([holder(20, 'liquidity-pool'), ...wallets]);
  return {
    token: token(),
    holders: { status: 'ok', data: holders },
    clustering: { status: 'ok', data: analyzeClustering(holders.wallets) },
    dusting: { status: 'ok', data: dusting(0.08) },
    reserve: { status: 'ok', data: poolReserve(250, 0.2) },
    creator: { status: 'ok', data: creator() },
    ...extra,
  };
}

test('niveaux : VERT 0-30, ORANGE 31-69, ROUGE 70-100', () => {
  assert.equal(levelFor(0), 'VERT');
  assert.equal(levelFor(30), 'VERT');
  assert.equal(levelFor(31), 'ORANGE');
  assert.equal(levelFor(69), 'ORANGE');
  assert.equal(levelFor(70), 'ROUGE');
});

test('token sain : distribution organique + liquidité profonde → VERT', () => {
  const risk = computeRiskScore(input(zipfHolders(19, 3)));
  assert.equal(risk.level, 'VERT', `score ${risk.score}`);
  assert.equal(risk.confidence, 1);
  assert.equal(risk.floors.length, 0);
});

test('wallets clonés → ROUGE via plancher, même avec une bonne liquidité', () => {
  const clones = Array.from({ length: 10 }, () => holder(1.8));
  const risk = computeRiskScore(input([...zipfHolders(3, 2), ...clones]));
  assert.equal(risk.level, 'ROUGE', `score ${risk.score}`);
  assert.ok(risk.floors.some((f) => f.reason.includes('clonés')));
});

test('supply monopolisée (un wallet à 45 %) → ROUGE', () => {
  const risk = computeRiskScore(input([holder(45), ...zipfHolders(10, 2)]));
  assert.equal(risk.level, 'ROUGE', `score ${risk.score}`);
});

test('forte concentration + liquidité faible → ORANGE', () => {
  const wallets = [holder(12), holder(7), holder(4.5), holder(3), ...zipfHolders(10, 1.2)];
  const risk = computeRiskScore(
    input(wallets, {
      reserve: { status: 'ok', data: poolReserve(12, 0.05) },
      creator: { status: 'ok', data: creator({ previousTokensCreated: 2 }) },
    }),
  );
  assert.equal(risk.level, 'ORANGE', `score ${risk.score}`);
});

test('freeze authority active → plancher 65', () => {
  const base = input(zipfHolders(19, 3));
  const risk = computeRiskScore({ ...base, token: token({ freezeAuthority: Keypair.generate().publicKey.toBase58() }) });
  assert.ok(risk.score >= 65);
});

test('liquidité retirée (< 1 SOL) → ROUGE', () => {
  const risk = computeRiskScore(input(zipfHolders(19, 3), { reserve: { status: 'ok', data: poolReserve(0.2, 0.001) } }));
  assert.equal(risk.level, 'ROUGE');
});

test('modules indisponibles : score renormalisé et confiance réduite', () => {
  const risk = computeRiskScore(
    input(zipfHolders(19, 3), {
      dusting: { status: 'unavailable', reason: 'RPC' },
      creator: { status: 'unavailable', reason: 'RPC' },
    }),
  );
  assert.equal(risk.confidence, 0.75);
  assert.equal(risk.modules.find((m) => m.id === 'dusting')?.score, null);
  assert.equal(risk.level, 'VERT');
});

test('dusting massif : finding critique', () => {
  const risk = computeRiskScore(input(zipfHolders(19, 3), { dusting: { status: 'ok', data: dusting(0.8) } }));
  const dust = risk.modules.find((m) => m.id === 'dusting');
  assert.equal(dust?.score, 100);
  assert.ok(dust?.findings.some((f) => f.severity === 'critical'));
});
