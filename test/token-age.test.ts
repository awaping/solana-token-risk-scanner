/**
 * Âge du token : date de la première transaction du mint, lue une seule fois
 * et partagée avec l'identification du créateur.
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { findMintOrigin } from '../src/analyzers/creator.js';
import { RpcClient } from '../src/rpc/client.js';
import { scanToken } from '../src/scanner.js';
import { ageAt, formatAge } from '../src/utils/age.js';
import { MockChain, randomKey, startMockRpc } from './fixtures/mock-rpc.js';
import { buildRaydiumChain } from './fixtures/scenarios.js';

const servers: Server[] = [];
after(() => servers.forEach((s) => s.close()));
const serve = async (chain: MockChain) => {
  const { url, server } = await startMockRpc(chain);
  servers.push(server);
  return url;
};

test('durées lisibles : secondes, minutes, heures, jours', () => {
  assert.equal(formatAge(17.8), '17 s');
  assert.equal(formatAge(65), '1 min 05 s');
  assert.equal(formatAge(3 * 3600 + 12 * 60 + 5), '3 h 12 min');
  assert.equal(formatAge(5 * 86_400 + 4 * 3600), '5 j 4 h');
  assert.equal(formatAge(-3), '0 s');
  assert.equal(ageAt(1_000, 40_000), 39);
  assert.equal(ageAt(undefined, 40_000), undefined);
});

test('token de quelques secondes : création trouvée en une requête, date exacte', async () => {
  const chain = new MockChain();
  const mint = randomKey();
  const now = Math.floor(Date.now() / 1000);
  chain.addTransaction([mint], { signer: randomKey(), blockTime: now - 39 });
  for (let i = 0; i < 25; i++) chain.addTransaction([mint], { signer: randomKey(), blockTime: now - 39 + i });
  const rpc = new RpcClient({ url: await serve(chain), concurrency: 4, maxRetries: 0 });
  const origin = await findMintOrigin(rpc, mint, 3);
  assert.equal(origin.complete, true);
  assert.equal(origin.oldest?.blockTime, now - 39);
  assert.equal(rpc.requestCount, 1);
});

test('historique plus long que la limite : date donnée comme borne (token au moins aussi vieux)', async () => {
  const chain = new MockChain();
  const mint = randomKey();
  for (let i = 0; i < 2_100; i++) chain.addTransaction([mint], { signer: randomKey(), blockTime: 1_700_000_000 + i });
  const rpc = new RpcClient({ url: await serve(chain), concurrency: 4, maxRetries: 0 });
  const origin = await findMintOrigin(rpc, mint, 2);
  assert.equal(origin.complete, false);
  assert.equal(origin.oldest?.blockTime, 1_700_000_000 + 100);
});

test('scan complet : âge du token renseigné, créateur toujours retrouvé par la même lecture', async () => {
  const { chain, mint, creator } = buildRaydiumChain();
  const result = await scanToken(mint.toBase58(), { rpcUrl: await serve(chain), concurrency: 8, maxRetries: 0, creatorTxScanLimit: 50, mintHistoryMaxPages: 2, holderCensus: true });
  assert.ok(result.tokenAge, 'âge du token');
  assert.equal(result.tokenAge.exact, true);
  // Scénario : création il y a 30 jours.
  const days = (result.generatedAt.getTime() - result.tokenAge.createdAt.getTime()) / 86_400_000;
  assert.ok(Math.abs(days - 30) < 0.01, `${days} j`);
  assert.equal(result.creator.status, 'ok');
  if (result.creator.status === 'ok') {
    assert.equal(result.creator.data.address, creator.toBase58());
    assert.equal(result.creator.data.source, 'mint creation tx');
  }
});
