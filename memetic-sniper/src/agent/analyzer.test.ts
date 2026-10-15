/**
 * Verifie la seule logique du module qui puisse couter de l'argent si elle
 * casse : la post-validation de la sortie LLM et les pre-filtres.
 * `node --test src/agent/analyzer.test.ts`
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import pino from 'pino';

import { SemanticAnalyzer, truncateBytes, type TweetSignal } from './analyzer.ts';

const log = pino({ level: 'silent' });

const cfg = {
  baseUrl: 'https://example.invalid/v1',
  apiKey: 'test',
  model: 'm',
  visionModel: 'mv',
  timeoutMs: 1000,
  maxRetries: 0,
  temperature: 0,
  minConfidence: 0.7,
  nameBlocklist: ['hitler'],
  maxTweetAgeMs: 15_000,
};

const analyzer = new SemanticAnalyzer(cfg, log);
// Les deux methodes testees sont privees : on y accede explicitement plutot
// que de les exporter publiquement pour les besoins du test.
const validate = (raw: string) => (analyzer as never as { parseAndValidate(r: string, l: typeof log): unknown }).parseAndValidate(raw, log);
const preFilter = (t: TweetSignal) => (analyzer as never as { preFilter(t: TweetSignal): string | null }).preFilter(t);

const ok = {
  shouldDeploy: true,
  confidence: 0.9,
  name: 'Gigachad Frog',
  symbol: 'GFROG',
  description: 'A frog.',
  imagePrompt: 'cartoon frog',
  reasoning: '',
};

const tweet = (over: Partial<TweetSignal> = {}): TweetSignal => ({
  id: '1',
  authorId: '44196397',
  authorHandle: 'someone',
  text: 'the gigachad frog has arrived',
  imageUrls: [],
  createdAt: Date.now(),
  isRetweet: false,
  isReply: false,
  ...over,
});

test('truncateBytes ne coupe pas une paire de substitution', () => {
  // Un emoji fait 4 octets : avec un budget de 5 octets apres "ab", il ne
  // passe pas et doit disparaitre en entier, pas en moitie invalide.
  const out = truncateBytes('ab\u{1F600}cd', 5);
  assert.equal(Buffer.byteLength(out, 'utf8') <= 5, true);
  assert.equal(out.includes('�'), false);
});

test('accepte une sortie valide', () => {
  const r = validate(JSON.stringify(ok)) as { symbol: string } | null;
  assert.equal(r?.symbol, 'GFROG');
});

test('tolere une fence markdown autour du JSON', () => {
  const r = validate('```json\n' + JSON.stringify(ok) + '\n```') as { name: string } | null;
  assert.equal(r?.name, 'Gigachad Frog');
});

test('rejette un JSON invalide', () => {
  assert.equal(validate('not json'), null);
});

test('rejette un symbole hors [A-Z0-9]{2,10}', () => {
  assert.equal(validate(JSON.stringify({ ...ok, symbol: 'A' })), null);
  assert.equal(validate(JSON.stringify({ ...ok, symbol: 'WAY-TOO-LONG-TICKER' })), null);
});

test('normalise le prefixe $ et la casse du symbole', () => {
  const r = validate(JSON.stringify({ ...ok, symbol: '$gfrog' })) as { symbol: string } | null;
  assert.equal(r?.symbol, 'GFROG');
});

test('applique la blocklist', () => {
  assert.equal(validate(JSON.stringify({ ...ok, name: 'Hitler Coin' })), null);
});

test('tronque un nom trop long a 32 octets', () => {
  const r = validate(JSON.stringify({ ...ok, name: 'x'.repeat(80) })) as { name: string } | null;
  assert.equal(Buffer.byteLength(r?.name ?? '', 'utf8') <= 32, true);
});

test('retire les caracteres directionnels du nom', () => {
  const r = validate(JSON.stringify({ ...ok, name: 'Fro‮g' })) as { name: string } | null;
  assert.equal(r?.name, 'Frog');
});

test('preFilter ecarte retweets, replies et tweets perimes', () => {
  assert.equal(preFilter(tweet()), null);
  assert.notEqual(preFilter(tweet({ isRetweet: true })), null);
  assert.equal(preFilter(tweet({ isReply: true })), 'reply');
  assert.notEqual(preFilter(tweet({ createdAt: Date.now() - 60_000 })), null);
  assert.notEqual(preFilter(tweet({ text: 'https://t.co/abc @bob' })), null);
});
