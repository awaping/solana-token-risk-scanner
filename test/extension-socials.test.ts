/**
 * Réseaux sociaux et dev d'un token (informatif, hors note) : lecture du JSON
 * de métadonnées, contenu non fiable filtré, et remontée depuis un vrai scan.
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { HistoryStore, type KeyValueStore } from '../extension/src/history-store.js';
import { toSnapshot } from '../extension/src/history-snapshot.js';
import { toPanelResult } from '../extension/src/panel-result.js';
import { extractSocials, ipfsFallback, metadataCandidates, parseTwitter, pumpUsername, resolveMetadataUri, safeUrl, twitterLabel } from '../extension/src/socials.js';
import { scanToken } from '../src/scanner.js';
import { startMockRpc } from './fixtures/mock-rpc.js';
import { buildHealthyChain } from './fixtures/scenarios.js';

test('lien X : pseudo, profil, tweet, communauté ; liens étrangers ou dangereux écartés', () => {
  assert.deepEqual(parseTwitter('@pumpdev'), { handle: 'pumpdev', url: 'https://x.com/pumpdev', kind: 'profile' });
  assert.deepEqual(parseTwitter('https://twitter.com/PumpDev/'), { handle: 'PumpDev', url: 'https://x.com/PumpDev', kind: 'profile' });
  assert.deepEqual(parseTwitter('https://x.com/pumpdev/status/1234567890'), { handle: 'pumpdev', url: 'https://x.com/pumpdev/status/1234567890', kind: 'tweet' });
  assert.equal(parseTwitter('https://x.com/i/communities/1890')?.kind, 'community');
  assert.equal(parseTwitter('https://x.com/search?q=%24PUMP')?.kind, 'link');
  assert.equal(parseTwitter('https://evil.example/pumpdev')?.kind, 'link');
  assert.equal(parseTwitter('javascript:alert(1)'), undefined);
  assert.equal(parseTwitter(''), undefined);
  assert.equal(twitterLabel(parseTwitter('x.com/pumpdev/status/1')!), 'tweet de @pumpdev');
});

test('URI de métadonnées : IPFS et Arweave via passerelle, http(s) seulement', () => {
  assert.equal(resolveMetadataUri('ipfs://QmAbc'), 'https://ipfs.io/ipfs/QmAbc');
  assert.equal(resolveMetadataUri('ipfs://ipfs/QmAbc'), 'https://ipfs.io/ipfs/QmAbc');
  assert.equal(resolveMetadataUri('ar://xyz'), 'https://arweave.net/xyz');
  assert.equal(resolveMetadataUri('https://ipfs.io/ipfs/QmAbc'), 'https://ipfs.io/ipfs/QmAbc');
  assert.equal(resolveMetadataUri('javascript:alert(1)'), undefined);
  assert.equal(resolveMetadataUri('data:application/json,{}'), undefined);
  assert.equal(safeUrl('example.com'), 'https://example.com/');
  assert.equal(safeUrl(`https://a.com/${'x'.repeat(400)}`), undefined);
});

test('JSON pump.fun ou Metaplex : twitter, telegram, site, description ; valeurs piégées ignorées', () => {
  assert.deepEqual(
    extractSocials({ name: 'Pump', twitter: 'https://x.com/pumpdev', telegram: 'pumpgroup', website: 'pump.example', description: '  Le meilleur  ' }),
    {
      twitter: { handle: 'pumpdev', url: 'https://x.com/pumpdev', kind: 'profile' },
      telegram: 'https://t.me/pumpgroup',
      website: 'https://pump.example/',
      description: 'Le meilleur',
    },
  );
  assert.deepEqual(extractSocials({ extensions: { twitter: '@meta_dev', website: 'https://meta.example' } }), {
    twitter: { handle: 'meta_dev', url: 'https://x.com/meta_dev', kind: 'profile' },
    website: 'https://meta.example/',
  });
  assert.deepEqual(extractSocials({ website: 'javascript:alert(1)', telegram: 'data:text/html,x', twitter: 42 }), {});
  assert.deepEqual(extractSocials('pas un objet'), {});
  assert.equal(pumpUsername({ username: 'dev_01' }), 'dev_01');
  assert.equal(pumpUsername({ username: '<img src=x>' }), undefined);
  assert.equal(pumpUsername(null), undefined);
});

test('hébergeur non autorisé : repli sur la passerelle IPFS publique quand c’est un fichier IPFS', () => {
  const cid = 'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG';
  const cidV1 = 'bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy';
  assert.equal(ipfsFallback(`https://pump.mypinata.cloud/ipfs/${cid}`), `https://ipfs.io/ipfs/${cid}`);
  assert.equal(ipfsFallback(`https://gw.example/ipfs/${cid}/meta.json?x=1`), `https://ipfs.io/ipfs/${cid}/meta.json`);
  assert.equal(ipfsFallback(`https://${cidV1}.ipfs.dweb.link/`), `https://ipfs.io/ipfs/${cidV1}`);
  assert.equal(ipfsFallback(`https://ipfs.io/ipfs/${cid}`), undefined, 'déjà la passerelle publique');
  assert.equal(ipfsFallback('https://metadata.j7tracker.io/metadata/VoBD45SnYb.json'), undefined, 'pas un fichier IPFS');
  assert.deepEqual(metadataCandidates(`https://cdn.example/ipfs/${cid}`), [`https://cdn.example/ipfs/${cid}`, `https://ipfs.io/ipfs/${cid}`]);
  assert.deepEqual(metadataCandidates('https://metadata.j7tracker.io/metadata/VoBD45SnYb.json'), ['https://metadata.j7tracker.io/metadata/VoBD45SnYb.json']);
  assert.deepEqual(metadataCandidates('javascript:alert(1)'), []);
});

const servers: Server[] = [];
after(() => servers.forEach((s) => s.close()));

test('vrai scan : lien de métadonnées et dev remontés au panneau ; réseaux ajoutés à l’historique', async () => {
  const { chain, mint } = buildHealthyChain();
  const { url, server } = await startMockRpc(chain);
  servers.push(server);
  const result = await scanToken(mint.toBase58(), { rpcUrl: url, concurrency: 8, maxRetries: 0, creatorTxScanLimit: 50, mintHistoryMaxPages: 2, holderCensus: true });
  assert.equal(result.token.metadataUri, 'https://example.org/meta.json');

  const panel = toPanelResult(result);
  assert.equal(panel.token.uri, 'https://example.org/meta.json');
  assert.equal(panel.creator, result.creator.status === 'ok' ? result.creator.data.address : undefined);
  assert.ok(panel.creator);

  const data = new Map<string, unknown>();
  const store: KeyValueStore = {
    get: async (keys) => Object.fromEntries(keys.filter((k) => data.has(k)).map((k) => [k, data.get(k)])),
    set: async (items) => void Object.entries(items).forEach(([k, v]) => data.set(k, JSON.parse(JSON.stringify(v)))),
    remove: async (keys) => void keys.forEach((k) => data.delete(k)),
  };
  const history = new HistoryStore(store);
  await history.record(toSnapshot(result));
  await history.attachSocials(result.mint, { twitter: { handle: 'dev', url: 'https://x.com/dev', kind: 'profile' }, dev: { address: panel.creator! }, at: 1 });
  const coin = await history.get(result.mint);
  assert.equal(coin?.socials?.twitter?.handle, 'dev');
  assert.equal(coin?.latest.token.uri, 'https://example.org/meta.json');
  assert.equal(coin?.scans.length, 1, 'les réseaux ne créent pas une analyse de plus');
});
