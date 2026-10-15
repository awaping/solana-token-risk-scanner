/**
 * Logique de sortie : c'est elle qui decide du resultat financier.
 * Entierement pure, donc entierement testable sans RPC ni horloge reelle.
 * `node --test src/trader/exit.test.ts`
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { Keypair } from '@solana/web3.js';

import type { CurveSnapshot } from './monitor.ts';
import { Position, parseTiers, assertTiers } from './position.ts';
import { decideExit, type ExitConfig } from './exit.ts';

const T0 = 1_700_000_000_000;

const CFG: ExitConfig = {
  stopLossPct: 40,
  trailingStopPct: 25,
  trailingArmsAtMultiple: 2,
  volumeDryUpMs: 30_000,
  maxHoldMs: 900_000,
  slippageBps: 500,
  computeUnitLimit: 200_000,
  computeUnitPriceMicroLamports: 100_000,
};

/** 0.1 SOL pour 5 000 000 tokens => prix d'entree = 20 lamports/unite de base. */
function newPosition(overrides: Partial<{ tiers: ReturnType<typeof parseTiers> }> = {}) {
  return new Position({
    mint: Keypair.generate().publicKey,
    creator: Keypair.generate().publicKey,
    entrySolLamports: 100_000_000n,
    tokensBought: 5_000_000n,
    deployedAt: T0,
    tiers: overrides.tiers ?? parseTiers('2,3,5', '33,33,34'),
  });
}

/** Construit un snapshot au multiple voulu, sans toucher a la vraie courbe. */
function snapshotAtMultiple(pos: Position, multiple: number, over: Partial<CurveSnapshot> = {}): CurveSnapshot {
  const price = pos.entryPrice * multiple;
  return {
    curve: {
      virtualTokenReserves: 1_000_000_000_000_000n,
      virtualSolReserves: 30_000_000_000n,
      realTokenReserves: 700_000_000_000_000n,
      realSolReserves: 1_000_000_000n,
      tokenTotalSupply: 1_000_000_000_000_000n,
      complete: false,
      creator: pos.creator,
    },
    price,
    marketCapLamports: price * 1e15,
    at: T0 + 1000,
    lastChangeAt: T0 + 1000,
    source: 'ws',
    ...over,
  };
}

// ---------------------------------------------------------------------------

test('aucune sortie tant que rien n est franchi', () => {
  const p = newPosition();
  assert.equal(decideExit(p, snapshotAtMultiple(p, 1.5), CFG, T0 + 5000), null);
});

test('stop-loss declenche a -40% et vend tout', () => {
  const p = newPosition();
  const d = decideExit(p, snapshotAtMultiple(p, 0.6), CFG, T0 + 5000);
  assert.equal(d?.reason, 'stop-loss');
  assert.equal(d?.tokensToSell, p.tokensRemaining);
});

test('le stop-loss prime sur tout le reste', () => {
  const p = newPosition();
  // Prix effondre ET volume assecheé : c'est le stop-loss qui doit sortir.
  const s = snapshotAtMultiple(p, 0.3, { lastChangeAt: T0 - 60_000 });
  assert.equal(decideExit(p, s, CFG, T0 + 5000)?.reason, 'stop-loss');
});

test('take-profit groupe tous les paliers franchis en une vente', () => {
  const p = newPosition();
  // Saut direct de 1x a 6x : les trois paliers sont franchis d'un coup.
  const d = decideExit(p, snapshotAtMultiple(p, 6), CFG, T0 + 5000);
  assert.equal(d?.reason, 'take-profit');
  assert.deepEqual(d?.tierIndexes, [0, 1, 2]);
  // 33+33+34 = 100% de la position initiale.
  assert.equal(d?.tokensToSell, p.tokensBought);
});

test('un palier deja consomme ne redeclenche pas', () => {
  const p = newPosition();
  const first = decideExit(p, snapshotAtMultiple(p, 2.1), CFG, T0 + 5000);
  assert.deepEqual(first?.tierIndexes, [0]);

  p.recordFill(first?.tokensToSell ?? 0n, 200_000_000n);
  p.markTiersHit(first?.tierIndexes ?? []);

  // Toujours a 2.1x : plus rien a faire.
  assert.equal(decideExit(p, snapshotAtMultiple(p, 2.1), CFG, T0 + 6000), null);
  // A 3.1x : seul le deuxieme palier declenche.
  assert.deepEqual(decideExit(p, snapshotAtMultiple(p, 3.1), CFG, T0 + 7000)?.tierIndexes, [1]);
});

test('le trailing stop ne s arme qu au-dessus du seuil', () => {
  const p = newPosition();
  // Sommet a 1.5x : sous le seuil d'armement (2x), pas de trailing.
  p.updatePeak(p.entryPrice * 1.5);
  assert.equal(decideExit(p, snapshotAtMultiple(p, 1.05), CFG, T0 + 5000), null);

  // Sommet a 4x, retour a 2.9x => -27.5% du sommet, au-dela des 25%.
  p.updatePeak(p.entryPrice * 4);
  const d = decideExit(p, snapshotAtMultiple(p, 2.9), CFG, T0 + 5000);
  assert.equal(d?.reason, 'trailing-stop');
  assert.equal(d?.tokensToSell, p.tokensRemaining);
});

test('le trailing ne declenche pas tant que la baisse reste dans la marge', () => {
  const p = newPosition();
  p.updatePeak(p.entryPrice * 4);
  // 3.1x = -22.5% du sommet, sous le seuil de 25%. Et aucun palier neuf.
  p.markTiersHit([0, 1]);
  assert.equal(decideExit(p, snapshotAtMultiple(p, 3.1), CFG, T0 + 5000), null);
});

test('assechement du volume : sortie totale', () => {
  const p = newPosition();
  const s = snapshotAtMultiple(p, 1.5, { lastChangeAt: T0 - 5_000 });
  const d = decideExit(p, s, CFG, T0 + 30_000);
  assert.equal(d?.reason, 'volume-dry-up');
  assert.equal(d?.tokensToSell, p.tokensRemaining);
});

test('duree de detention maximale : sortie totale', () => {
  const p = newPosition();
  const s = snapshotAtMultiple(p, 1.5, { lastChangeAt: T0 + 899_000 });
  const d = decideExit(p, s, CFG, T0 + 900_001);
  assert.equal(d?.reason, 'max-hold');
});

test('courbe migree : sortie impossible, signalee sans ordre de vente', () => {
  const p = newPosition();
  const s = snapshotAtMultiple(p, 10);
  s.curve = { ...s.curve, complete: true };
  const d = decideExit(p, s, CFG, T0 + 5000);
  assert.equal(d?.reason, 'curve-complete');
  assert.equal(d?.tokensToSell, 0n);
});

test('position fermee : plus aucune decision', () => {
  const p = newPosition();
  p.recordFill(p.tokensBought, 500_000_000n);
  assert.equal(p.closed, true);
  assert.equal(decideExit(p, snapshotAtMultiple(p, 0.1), CFG, T0 + 5000), null);
});

// ---------------------------------------------------------------------------
// Comptabilite de la position
// ---------------------------------------------------------------------------

test('prix d entree = prix effectif, frais et slippage inclus', () => {
  const p = newPosition();
  assert.equal(p.entryPrice, 20); // 100_000_000 lamports / 5_000_000 tokens
  assert.equal(p.multipleAt(40), 2);
});

test('tokensForPct est plafonne par le solde restant', () => {
  const p = newPosition();
  assert.equal(p.tokensForPct(50), 2_500_000n);
  p.recordFill(4_000_000n, 300_000_000n);
  // 50% de la position INITIALE = 2.5M, mais il ne reste que 1M.
  assert.equal(p.tokensForPct(50), 1_000_000n);
});

test('recordFill refuse de vendre plus que le solde', () => {
  const p = newPosition();
  assert.throws(() => p.recordFill(6_000_000n, 1n), /out of sync/);
});

test('isDeRisked bascule quand la mise est remboursee', () => {
  const p = newPosition();
  p.recordFill(1_000_000n, 99_999_999n);
  assert.equal(p.isDeRisked, false);
  p.recordFill(1_000_000n, 2n);
  assert.equal(p.isDeRisked, true);
  assert.equal(p.realizedPnlLamports, 1n);
});

test('parseTiers valide la coherence de la configuration', () => {
  assert.deepEqual(parseTiers('2,5', '40,60'), [
    { multiplier: 2, sellPct: 40 },
    { multiplier: 5, sellPct: 60 },
  ]);
  assert.throws(() => parseTiers('2,5', '40'), /mismatch/);
  assert.throws(() => parseTiers('2,5', '60,60'), /exceeds 100%/);
  assert.throws(() => parseTiers('1,5', '40,60'), /multiplier must be > 1/);
  assert.throws(() => parseTiers('a,5', '40,60'), /non-numeric/);
  assert.throws(() => assertTiers([]), /at least one/);
});

test('les paliers sont tries par multiple croissant', () => {
  const p = newPosition({ tiers: parseTiers('5,2,3', '34,33,33') });
  assert.deepEqual(
    p.tiers.map((t) => t.multiplier),
    [2, 3, 5],
  );
  // Le tri doit reassocier les bons pourcentages.
  assert.deepEqual(
    p.tiers.map((t) => t.sellPct),
    [33, 33, 34],
  );
});

test('des paliers 33/33/34 ne laissent pas de poussiere non vendable', () => {
  // Division entiere : 33% + 33% + 34% de 5_000_001 laisse 1 unite de base.
  // Sans balayage, la position ne se fermerait jamais et son moniteur
  // tournerait indefiniment.
  const p = new Position({
    mint: Keypair.generate().publicKey,
    creator: Keypair.generate().publicKey,
    entrySolLamports: 100_000_000n,
    tokensBought: 5_000_001n,
    deployedAt: T0,
    tiers: parseTiers('2,3,5', '33,33,34'),
  });
  for (const multiple of [2.1, 3.1, 5.1]) {
    const d = decideExit(p, snapshotAtMultiple(p, multiple), CFG, T0 + 1000);
    if (!d) continue;
    p.recordFill(d.tokensToSell, 1n);
    p.markTiersHit(d.tierIndexes);
  }
  assert.equal(p.tokensRemaining, 0n);
  assert.equal(p.closed, true);
});

test('un reliquat sous le seuil de poussiere ferme la position', () => {
  const p = newPosition();
  p.recordFill(p.tokensBought - 999n, 1n);
  assert.equal(p.closed, true, '999 base units is dust, the position must close');
});
