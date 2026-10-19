/**
 * Chemin rapide du scan : moins de requêtes, note provisoire, cache, et wallets
 * frais. Les comptes de requêtes par méthode prouvent ce qui n'est plus envoyé.
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { MintLayout, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';
import { PublicKey } from '@solana/web3.js';
import { memoryCache } from '../src/cache.js';
import type { ScannerConfig } from '../src/config.js';
import { fetchCensus } from '../src/analyzers/dusting.js';
import { analyzeHolders, holdersFromCensus } from '../src/analyzers/holders.js';
import { loadToken } from '../src/analyzers/token.js';
import { RpcClient } from '../src/rpc/client.js';
import { hedge, scanToken } from '../src/scanner.js';
import type { ScanResult } from '../src/types.js';
import { MockChain, randomKey, startMockRpc } from './fixtures/mock-rpc.js';
import { buildHealthyChain, buildRugChain } from './fixtures/scenarios.js';

const servers: Server[] = [];
after(() => servers.forEach((s) => s.close()));

/** RPC simulé qui compte les appels par méthode. */
async function serve(chain: MockChain) {
  const calls = new Map<string, number>();
  const handle = chain.handle.bind(chain);
  chain.handle = (method: string, params: unknown[]) => {
    calls.set(method, (calls.get(method) ?? 0) + 1);
    return handle(method, params);
  };
  const { url, server } = await startMockRpc(chain);
  servers.push(server);
  return { url, calls, reset: () => calls.clear() };
}

const config = (rpcUrl: string): ScannerConfig => ({ rpcUrl, concurrency: 8, maxRetries: 0, creatorTxScanLimit: 50, mintHistoryMaxPages: 2, holderCensus: true });

test('token migré : pool PumpSwap lue à son adresse canonique, sans recherche getProgramAccounts', async () => {
  const { chain, mint } = buildRugChain();
  const { url, calls } = await serve(chain);
  const result = await scanToken(mint.toBase58(), config(url));
  assert.equal(result.reserve.status, 'ok');
  if (result.reserve.status === 'ok') {
    assert.equal(result.reserve.data.venue, 'PumpSwap');
    assert.equal(result.reserve.data.realReserveSol, 3);
  }
  assert.equal(calls.get('getProgramAccounts'), 1, 'seulement le recensement des holders');
  assert.equal(calls.get('getTokenLargestAccounts'), undefined, 'holders tirés du recensement');
  assert.equal(calls.get('getAccountInfo'), undefined, 'bonding curve lue avec le mint');
});

test('pool ailleurs qu’à l’adresse canonique : toujours trouvée par la recherche', async () => {
  const { chain, mint } = buildRugChain({ canonicalPool: false });
  const { url, calls } = await serve(chain);
  const result = await scanToken(mint.toBase58(), config(url));
  assert.equal(result.reserve.status === 'ok' && result.reserve.data.venue, 'PumpSwap');
  assert.ok((calls.get('getProgramAccounts') ?? 0) > 1);
});

test('holders tirés du recensement = holders via getTokenLargestAccounts', async () => {
  const { chain, mint } = buildRugChain();
  const { url } = await serve(chain);
  const rpc = new RpcClient({ url, concurrency: 8, maxRetries: 0 });
  const { token } = await loadToken(rpc, mint);
  const [fromLargest, fromCensus] = await Promise.all([analyzeHolders(rpc, token), fetchCensus(rpc, token).then((c) => holdersFromCensus(rpc, token, c))]);
  // Même classement, à l'ordre près entre soldes égaux (et hors poussière, départagée arbitrairement).
  const view = (h: typeof fromLargest) => h.top.filter((x) => x.pct > 1e-4).map((x) => `${x.owner}:${x.kind}:${x.pct.toFixed(6)}`).sort();
  assert.deepEqual(view(fromCensus), view(fromLargest));
  assert.equal(fromCensus.top.length, fromLargest.top.length);
  assert.equal(fromCensus.top10Pct, fromLargest.top10Pct);
});

test('note provisoire avant l’historique du dev et les wallets frais, puis note définitive', async () => {
  const { chain, mint } = buildHealthyChain();
  const { url } = await serve(chain);
  const partials: ScanResult[] = [];
  const result = await scanToken(mint.toBase58(), config(url), { onPartial: (r) => partials.push(r) });
  assert.equal(result.pending, undefined);
  assert.equal(partials.length, 1);
  const partial = partials[0]!;
  assert.ok(partial.pending && partial.pending.length > 0, 'analyses en cours signalées');
  assert.equal(partial.holders.status, 'ok');
  assert.equal(partial.reserve.status, 'ok');
  assert.equal(partial.dusting.status, 'ok');
  if (partial.pending!.includes('creator')) assert.equal(partial.creator.status, 'unavailable');
  assert.equal(result.creator.status, 'ok');
});

test('cache : rescanner le même token ne relit pas les transactions du dev', async () => {
  const { chain, mint } = buildHealthyChain();
  const { url, calls, reset } = await serve(chain);
  const cache = memoryCache();
  const first = await scanToken(mint.toBase58(), config(url), { cache });
  assert.ok((calls.get('getTransaction') ?? 0) > 0);
  reset();
  const second = await scanToken(mint.toBase58(), config(url), { cache });
  assert.equal(calls.get('getTransaction'), undefined, 'aucune transaction relue');
  assert.equal(second.risk.score, first.risk.score);
  assert.deepEqual(
    second.creator.status === 'ok' && second.creator.data.previousTokensCreated,
    first.creator.status === 'ok' && first.creator.data.previousTokensCreated,
  );
});

test('wallets frais : part de la supply détenue par des wallets créés il y a moins de 24 h', async () => {
  const { chain, mint } = buildHealthyChain();
  const now = Math.floor(Date.now() / 1000);
  const { url } = await serve(chain);
  const rpc = new RpcClient({ url, concurrency: 8, maxRetries: 0 });
  // Deux des plus gros wallets : premier mouvement il y a 2 h, 3 transactions.
  const baseline = await scanToken(mint.toBase58(), config(url), { rpc });
  const wallets = baseline.holders.status === 'ok' ? baseline.holders.data.wallets.filter((w) => w.kind === 'wallet') : [];
  for (const wallet of wallets.slice(0, 2)) {
    for (let i = 0; i < 3; i++) chain.addTransaction([new PublicKey(wallet.owner)], { signer: new PublicKey(wallet.owner), blockTime: now - 7_200 + i });
  }
  const result = await scanToken(mint.toBase58(), config(url));
  assert.equal(result.fresh?.status, 'ok');
  if (result.fresh?.status === 'ok') {
    assert.equal(result.fresh.data.fresh.length, 2);
    const expected = wallets[0]!.pct + wallets[1]!.pct;
    assert.ok(Math.abs(result.fresh.data.freshPct - expected) < 1e-9);
    assert.ok(Math.abs(result.fresh.data.fresh[0]!.ageHours - 2) < 0.1);
  }
  const clustering = result.risk.modules.find((m) => m.id === 'clustering')!;
  assert.ok(clustering.findings.some((f) => f.message.startsWith('Wallets frais : 2 wallets')), JSON.stringify(clustering.findings));
  // Sans wallet frais : constat « aucun ».
  const clean = baseline.risk.modules.find((m) => m.id === 'clustering')!;
  assert.ok(clean.findings.some((f) => f.message.startsWith('Aucun wallet frais')));
});

test('métadonnées Token-2022 lues dans le mint lui-même (aucune requête de plus)', async () => {
  const chain = new MockChain();
  const mint = randomKey();
  const base = Buffer.alloc(82);
  MintLayout.encode(
    { mintAuthorityOption: 0, mintAuthority: PublicKey.default, supply: 1_000_000_000_000_000n, decimals: 6, isInitialized: true, freezeAuthorityOption: 0, freezeAuthority: PublicKey.default },
    base,
  );
  const str = (s: string) => {
    const b = Buffer.from(s, 'utf8');
    const len = Buffer.alloc(4);
    len.writeUInt32LE(b.length);
    return Buffer.concat([len, b]);
  };
  const meta = Buffer.concat([Buffer.alloc(32), mint.toBuffer(), str('Pump Coin'), str('PUMPC'), str('https://ipfs.io/ipfs/QmMeta'), Buffer.alloc(4)]);
  const tlvHeader = Buffer.alloc(4);
  tlvHeader.writeUInt16LE(19, 0); // ExtensionType.TokenMetadata
  tlvHeader.writeUInt16LE(meta.length, 2);
  const data = Buffer.concat([base, Buffer.alloc(165 - 82), Buffer.from([1]), tlvHeader, meta]);
  chain.setAccount(mint, TOKEN_2022_PROGRAM_ID, data, 2_000_000);
  const { url, calls } = await serve(chain);
  const { token } = await loadToken(new RpcClient({ url, concurrency: 4, maxRetries: 0 }), mint);
  assert.equal(token.name, 'Pump Coin');
  assert.equal(token.symbol, 'PUMPC');
  assert.equal(token.metadataUri, 'https://ipfs.io/ipfs/QmMeta');
  assert.equal(token.metadataMutable, false, 'autorité de mise à jour nulle');
  assert.equal([...calls.values()].reduce((a, b) => a + b, 0), 1, 'une seule requête');
});

test('relais : le plus rapide gagne ; un échec bascule sur l’autre ; deux échecs échouent', async () => {
  const wait = (ms: number, value: string) => new Promise<string>((r) => setTimeout(() => r(value), ms));
  assert.equal(await hedge(wait(10, 'principal'), () => wait(10, 'relais'), 200), 'principal');
  assert.equal(await hedge(wait(400, 'principal'), () => wait(10, 'relais'), 50), 'relais');
  assert.equal(await hedge(Promise.reject(new Error('x')), () => wait(10, 'relais'), 5_000), 'relais');
  await assert.rejects(hedge(Promise.reject(new Error('a')), () => Promise.reject(new Error('b')), 10));
});
