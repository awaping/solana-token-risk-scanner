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

/** Constats affichés (critiques et alertes), tous modules confondus. */
const alerts = (risk: ReturnType<typeof computeRiskScore>) =>
  risk.modules.flatMap((m) => m.findings).filter((f) => f.severity === 'critical' || f.severity === 'warning').map((f) => f.message);

test('pas de répétition : le plus gros wallet n’est cité qu’une fois, les autres baleines à part', () => {
  const top = holder(38.66);
  const risk = computeRiskScore(
    input([top, holder(18.32), holder(9.81), holder(6.37), ...zipfHolders(8, 0.8)], {
      creator: { status: 'ok', data: creator({ fullHistory: true, signatureCount: 2, walletAgeDays: 1.9 / 24, solBalance: 0.01 }) },
    }),
  );
  const messages = alerts(risk);
  const short = `${top.owner.slice(0, 4)}…${top.owner.slice(-4)}`;
  assert.equal(messages.filter((m) => m.includes(short)).length, 1, messages.join('\n'));
  assert.ok(messages.some((m) => /^3 autres wallets hors créateur au-dessus de 3,5 %.*4 wallets cumulent 73,16 %/.test(m)), messages.join('\n'));
  // Wallet jetable, récent et vidé : un seul constat.
  const wallet = messages.filter((m) => m.startsWith('Wallet du créateur'));
  assert.deepEqual(wallet, ['Wallet du créateur jetable : seulement 2 transactions au total, créé il y a 1,9 h, quasiment vidé (0,0100 SOL)']);
  assert.equal(risk.level, 'ROUGE');
});

test('pas de répétition : créateur = plus gros wallet, sa part n’est annoncée qu’une fois', () => {
  const owner = Keypair.generate().publicKey.toBase58();
  const wallets = [holder(40, 'creator', owner), ...zipfHolders(10, 2)];
  const withCreator = alerts(computeRiskScore(input(wallets, { creator: { status: 'ok', data: creator({ address: owner, holdingPct: 40 }) } })));
  assert.equal(withCreator.filter((m) => m.includes('40,00 %')).length, 1, withCreator.join('\n'));
  assert.ok(withCreator.includes('Le créateur détient encore 40,00 % de la supply'));
  // Module créateur indisponible : l'information reste donnée par le module holders.
  const withoutCreator = alerts(computeRiskScore(input(wallets, { creator: { status: 'unavailable', reason: 'RPC saturé (429)' } })));
  assert.ok(withoutCreator.some((m) => m.includes('(créateur) détient à lui seul 40,00 %')), withoutCreator.join('\n'));
});

test('pas de répétition : des wallets clonés ne déclenchent pas en plus l’alerte « distribution uniforme »', () => {
  const messages = alerts(computeRiskScore(input(Array.from({ length: 10 }, () => holder(3)))));
  assert.ok(messages.some((m) => m.startsWith('Wallets clonés')), messages.join('\n'));
  assert.ok(!messages.some((m) => m.startsWith('Distribution anormalement uniforme')), messages.join('\n'));
});
