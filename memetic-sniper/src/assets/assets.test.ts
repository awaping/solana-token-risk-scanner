/**
 * Assets : repli d'image et schema de metadonnees.
 * `node --test src/assets/assets.test.ts`
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import pino from 'pino';

import { generateImage, proceduralAvatar } from './image.ts';
import { buildMetadata, tweetUrl } from './metadata.ts';
import type { AssetsConfig } from '../core/config.ts';

const log = pino({ level: 'silent' });

const CFG: AssetsConfig = {
  falModel: 'fal-ai/flux/schnell',
  falTimeoutMs: 1_500,
  pumpIpfsUrl: 'https://pump.fun/api/ipfs',
  pumpIpfsTimeoutMs: 4_000,
  irysRpcUrl: 'https://api.mainnet-beta.solana.com',
  irysTimeoutMs: 8_000,
};

// ---------------------------------------------------------------------------
// Repli procedural
// ---------------------------------------------------------------------------

test('l avatar procedural est un SVG valide et deterministe', () => {
  const a = proceduralAvatar('GFROG').toString('utf8');
  const b = proceduralAvatar('GFROG').toString('utf8');
  assert.equal(a, b, 'same symbol must give the same image');
  assert.match(a, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  assert.match(a, /<\/svg>$/);
  assert.match(a, />GFROG</);
  // Deux tickers differents donnent deux images differentes.
  assert.notEqual(a, proceduralAvatar('WIF').toString('utf8'));
});

test('l avatar est genere en moins d une milliseconde', () => {
  const t0 = performance.now();
  for (let i = 0; i < 50; i++) proceduralAvatar(`SYM${i}`);
  const perCall = (performance.now() - t0) / 50;
  assert.ok(perCall < 1, `procedural avatar took ${perCall.toFixed(3)}ms per call`);
});

test('sans FAL_KEY, generateImage bascule immediatement sur le repli', async () => {
  const img = await generateImage('a frog', 'GFROG', CFG, log);
  assert.equal(img.source, 'fallback');
  assert.equal(img.contentType, 'image/svg+xml');
  assert.equal(img.fileName, 'gfrog.svg');
  assert.ok(img.data.length > 0);
  assert.ok(img.latencyMs < 50);
});

test('une panne Fal.ai ne fait jamais echouer generateImage', async () => {
  // Hote inexistant : DNS en echec, puis repli.
  const img = await generateImage('a frog', 'GFROG', { ...CFG, falKey: 'fake', falModel: '../../nonexistent.invalid/x' }, log);
  assert.equal(img.source, 'fallback');
  assert.ok(img.data.length > 0);
});

test('un timeout Fal.ai respecte le budget et bascule', async () => {
  // Endpoint qui ne repond jamais dans les temps.
  const cfg = { ...CFG, falKey: 'fake', falTimeoutMs: 120 };
  const t0 = Date.now();
  const img = await generateImage('a frog', 'SLOW', cfg, log);
  assert.equal(img.source, 'fallback');
  // Le repli doit arriver peu apres le budget, pas des secondes plus tard.
  assert.ok(Date.now() - t0 < 3_000, 'fallback took too long after the timeout');
});

// ---------------------------------------------------------------------------
// Metadonnees
// ---------------------------------------------------------------------------

test('buildMetadata produit le schema attendu par pump.fun', () => {
  const md = buildMetadata({
    name: 'Gigachad Frog',
    symbol: 'GFROG',
    description: 'A frog.',
    image: 'https://gateway.irys.xyz/abc',
    twitter: 'https://x.com/elonmusk/status/1',
  });
  assert.equal(md.createdOn, 'https://pump.fun');
  assert.equal(md.showName, true);
  assert.equal(md.image, 'https://gateway.irys.xyz/abc');
  assert.equal(md.twitter, 'https://x.com/elonmusk/status/1');
  // Les champs optionnels absents ne sont pas emis a vide.
  assert.equal('telegram' in md, false);
  assert.equal('website' in md, false);
});

test('buildMetadata re-verifie les bornes Metaplex', () => {
  const base = { name: 'X', symbol: 'XX', description: 'd' };
  assert.throws(() => buildMetadata({ ...base, name: 'x'.repeat(33) }), /name is 33 bytes/);
  assert.throws(() => buildMetadata({ ...base, symbol: 'ELEVENCHARS' }), /symbol is 11 bytes/);
  assert.throws(() => buildMetadata({ ...base, description: '' }), /description is empty/);
});

test('tweetUrl construit un permalien exploitable', () => {
  assert.equal(tweetUrl('elonmusk', '123'), 'https://x.com/elonmusk/status/123');
});
