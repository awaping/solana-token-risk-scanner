/**
 * Détection du token sur n'importe quel site.
 *
 * C'est le point le plus fragile de l'extension : se tromper de mint, c'est
 * afficher un verdict rassurant sur le mauvais token. Deux erreurs sont
 * inacceptables et testées ici — confondre une adresse de POOL avec un mint,
 * et attraper une adresse de programme qui traîne dans la page.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectToken, extractAddresses } from '../extension/src/detect.js';

const PUMP_MINT = 'CKSZgov3AHQXemt18FNVcjry6DLTahpw4BJRYfnupump';
const PLAIN_MINT = '7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr';

test('motifs d’URL des terminaux memecoin', () => {
  const cases: Array<[string, string, string]> = [
    [`https://pump.fun/coin/${PUMP_MINT}`, PUMP_MINT, 'pump.fun'],
    [`https://trade.padre.gg/trade/solana/${PUMP_MINT}`, PUMP_MINT, 'Padre'],
    [`https://axiom.trade/meme/${PLAIN_MINT}`, PLAIN_MINT, 'Axiom'],
    [`https://gmgn.ai/sol/token/${PLAIN_MINT}`, PLAIN_MINT, 'GMGN'],
    [`https://birdeye.so/token/${PLAIN_MINT}?chain=solana`, PLAIN_MINT, 'Birdeye'],
    [`https://solscan.io/token/${PLAIN_MINT}`, PLAIN_MINT, 'Solscan'],
  ];
  for (const [url, expected, source] of cases) {
    const found = detectToken(url);
    assert.equal(found?.address, expected, url);
    assert.equal(found?.kind, 'mint', url);
    assert.equal(found?.source, source);
  }
});

test('GMGN avec préfixe de chaîne dans le segment', () => {
  const found = detectToken(`https://gmgn.ai/sol/token/abc123_${PLAIN_MINT}`);
  assert.equal(found?.address, PLAIN_MINT);
});

test('une adresse de POOL n’est jamais présentée comme un mint', () => {
  // DexScreener et Photon mettent la paire dans l'URL. Scanner la pool au lieu
  // du token produirait un verdict faux sur le mauvais compte.
  for (const url of [
    `https://dexscreener.com/solana/${PLAIN_MINT}`,
    `https://photon-sol.tinyastro.io/en/lp/${PLAIN_MINT}`,
  ]) {
    const found = detectToken(url);
    assert.equal(found?.kind, 'pair', url);
  }
});

test('le suffixe pump est préféré sur un site inconnu', () => {
  const found = detectToken(`https://un-site-inconnu.xyz/t/${PLAIN_MINT}/x/${PUMP_MINT}`);
  assert.equal(found?.address, PUMP_MINT);
  assert.equal(found?.kind, 'mint');
});

test('les programmes et tokens système sont ignorés', () => {
  const noise = [
    'So11111111111111111111111111111111111111112',
    'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
    '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
    'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  ];
  assert.deepEqual(extractAddresses(noise.join(' ')), []);
  // Et dans une URL : aucune détection plutôt qu'une fausse.
  assert.equal(detectToken(`https://site.xyz/x/${noise[0]}`), null);
});

test('l’URL prime sur la page : une liste de tokens ne doit rien déclencher', () => {
  // Une page de classement contient des dizaines d'adresses ; aucune n'est
  // « le token regardé ».
  const pageText = `${PLAIN_MINT} ${PLAIN_MINT.slice(0, 43)}X autres tokens`;
  assert.equal(detectToken('https://site.xyz/trending', pageText), null);
  // Avec un suffixe pump, en revanche, l'intention est claire.
  assert.equal(detectToken('https://site.xyz/trending', `blah ${PUMP_MINT} blah`)?.address, PUMP_MINT);
});

test('entrées dégénérées : jamais d’exception', () => {
  for (const url of ['', 'pas-une-url', 'about:blank', 'chrome://extensions']) {
    assert.doesNotThrow(() => detectToken(url));
  }
  assert.equal(detectToken('https://site.xyz/'), null);
});

test('extractAddresses déduplique en conservant l’ordre', () => {
  const text = `${PUMP_MINT} ${PLAIN_MINT} ${PUMP_MINT}`;
  assert.deepEqual(extractAddresses(text), [PUMP_MINT, PLAIN_MINT]);
});

test('les caractères hors base58 ne forment pas une adresse', () => {
  // 0, O, I et l sont absents de l'alphabet base58.
  assert.deepEqual(extractAddresses('0OIl0OIl0OIl0OIl0OIl0OIl0OIl0OIl0OIl'), []);
});

// ---------------------------------------------------------------------------
// Endpoints RPC hostiles au navigateur
// ---------------------------------------------------------------------------

import { isBrowserHostile, explainRpcError, ConfigError } from '../extension/src/rpc-errors.js';

test('les endpoints publics Solana sont reconnus comme hostiles au navigateur', () => {
  // Vérifié par requête réelle : 200 sans Origin, 403 avec un Origin
  // chrome-extension://. Les proposer par défaut garantissait l'échec.
  for (const url of [
    'https://api.mainnet-beta.solana.com',
    'https://api.devnet.solana.com/',
    'https://api.testnet.solana.com',
  ]) {
    assert.equal(isBrowserHostile(url), true, url);
  }
  for (const url of [
    'https://mainnet.helius-rpc.com/?api-key=abc',
    'https://solana-mainnet.g.alchemy.com/v2/xyz',
    'https://example.quiknode.pro/abc/',
  ]) {
    assert.equal(isBrowserHostile(url), false, url);
  }
  assert.equal(isBrowserHostile('pas-une-url'), false);
});

test('un 403 devient une phrase actionnable, pas du JSON brut', () => {
  const raw = '403 : {"jsonrpc":"2.0","error":{"code": 403, "message":"Access forbidden"}}';
  const explained = explainRpcError(new Error(raw), 'https://api.mainnet-beta.solana.com');
  assert.ok(explained instanceof ConfigError, 'doit proposer d’ouvrir les réglages');
  assert.match(explained.message, /refuse les requêtes venant d'un navigateur/);
  assert.match(explained.message, /RPC privé/);
  assert.doesNotMatch(explained.message, /jsonrpc/);
});

test('un 403 sur un RPC privé pointe vers la clé, pas vers l’endpoint public', () => {
  const explained = explainRpcError(new Error('403 forbidden'), 'https://mainnet.helius-rpc.com/?api-key=x');
  assert.match(explained.message, /clé d'API/);
  assert.match(explained.message, /helius-rpc\.com/);
});

test('les autres pannes RPC restent distinctes', () => {
  const url = 'https://mainnet.helius-rpc.com/?api-key=x';
  assert.match(explainRpcError(new Error('401 Unauthorized'), url).message, /invalide ou absente/);
  assert.match(explainRpcError(new Error('429 Too Many Requests'), url).message, /limite le débit/);
  assert.match(explainRpcError(new Error('Failed to fetch'), url).message, /injoignable/);
  // Une erreur inconnue est transmise telle quelle plutôt que travestie.
  const unknown = new Error('bizarrerie inattendue');
  assert.equal(explainRpcError(unknown, url), unknown);
});
