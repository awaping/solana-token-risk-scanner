/**
 * Pool de keypairs : latence de prise, reapprovisionnement, effacement memoire.
 * `node --test src/solana/keypairPool.test.ts`
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { Keypair } from '@solana/web3.js';
import pino from 'pino';

import { KeypairPool, wipeKeypair } from './keypairPool.ts';

const log = pino({ level: 'silent' });
const settle = () => new Promise<void>((r) => setTimeout(r, 60));

test('wipeKeypair efface reellement le secret interne', () => {
  const kp = Keypair.generate();
  assert.ok(kp.secretKey.some((b) => b !== 0));

  // Piege de @solana/web3.js : le getter rend une copie, l'effacer ne fait rien.
  kp.secretKey.fill(0);
  assert.ok(kp.secretKey.some((b) => b !== 0), 'filling the getter copy should be a no-op');

  wipeKeypair(kp);
  assert.ok(kp.secretKey.every((b) => b === 0), 'internal secret should be zeroed');
});

test('start remplit jusqu a la cible', async () => {
  const pool = new KeypairPool({ targetSize: 8, refillIntervalMs: 50 }, log);
  await pool.start();
  assert.equal(pool.size, 8);
  pool.stop();
});

test('acquire est synchrone, unique, et se reapprovisionne en tache de fond', async () => {
  const pool = new KeypairPool({ targetSize: 5, refillIntervalMs: 20 }, log);
  await pool.start();

  const seen = new Set<string>();
  for (let i = 0; i < 5; i++) {
    const kp = pool.acquire(); // pas de await : la prise doit etre synchrone
    seen.add(kp.publicKey.toBase58());
  }
  assert.equal(seen.size, 5, 'pool handed out a duplicate keypair');
  assert.equal(pool.stats.consumed, 5);

  await settle();
  assert.equal(pool.size, 5, 'pool did not refill back to target');
  assert.equal(pool.stats.starvations, 0);
  pool.stop();
});

test('acquire sur pool vide degrade sans echouer et compte la famine', async () => {
  const pool = new KeypairPool({ targetSize: 1, refillIntervalMs: 10_000 }, log);
  await pool.start();
  pool.acquire(); // vide le pool
  const kp = pool.acquire(); // genere a chaud
  assert.ok(kp instanceof Keypair);
  assert.equal(pool.stats.starvations, 1);
  pool.stop();
});

test('stop efface les cles restantes', async () => {
  const pool = new KeypairPool({ targetSize: 3, refillIntervalMs: 50 }, log);
  await pool.start();
  const held = pool.acquire();
  pool.stop();
  assert.equal(pool.size, 0);
  // La cle deja sortie appartient a l'appelant : stop() ne doit pas la toucher.
  assert.ok(held.secretKey.some((b) => b !== 0));
  pool.dispose(held);
  assert.ok(held.secretKey.every((b) => b === 0));
});

test('un suffixe vanity non base58 est rejete a la construction', () => {
  assert.throws(() => new KeypairPool({ targetSize: 1, vanitySuffix: 'pumO' }, log), /non-base58/);
});

test('le grinding vanity abandonne au lieu de bloquer le pool', async () => {
  // 1 caractere = ~58 essais, mais on plafonne a 5 pour forcer l'abandon
  // et verifier que le pool se remplit quand meme.
  const pool = new KeypairPool(
    { targetSize: 2, vanitySuffix: 'z', vanityMaxAttempts: 5, refillIntervalMs: 50 },
    log,
  );
  await pool.start();
  assert.equal(pool.size, 2);
  assert.ok(pool.stats.vanityHits + pool.stats.vanityGiveUps >= 2);
  pool.stop();
});

test('targetSize invalide est rejete', () => {
  assert.throws(() => new KeypairPool({ targetSize: 0 }, log), /positive integer/);
});
