/**
 * Message du service worker vers le panneau : doit survivre à la sérialisation
 * JSON de chrome.runtime (un ScanResult complet échoue à cause de ses BigInt).
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { describeMissingModule, toPanelResult } from '../extension/src/panel-result.js';
import { bondingCurvePda } from '../src/analyzers/pumpfun.js';
import { scanToken } from '../src/scanner.js';
import { startMockRpc } from './fixtures/mock-rpc.js';
import { buildHealthyChain } from './fixtures/scenarios.js';

const servers: Server[] = [];
after(() => servers.forEach((s) => s.close()));

test('résultat du panneau sérialisable en JSON, sans perte, y compris le mint retrouvé', async () => {
  const { chain, mint } = buildHealthyChain();
  const { url, server } = await startMockRpc(chain);
  servers.push(server);
  const result = await scanToken(bondingCurvePda(mint).toBase58(), {
    rpcUrl: url,
    concurrency: 8,
    maxRetries: 0,
    creatorTxScanLimit: 50,
    mintHistoryMaxPages: 2,
    holderCensus: true,
  });

  // Le résultat complet ne passe pas : c'était l'erreur « Could not serialize message ».
  assert.throws(() => JSON.stringify(result), /BigInt/);

  const panel = toPanelResult(result);
  assert.deepEqual(JSON.parse(JSON.stringify(panel)), panel);
  assert.equal(panel.mint, mint.toBase58());
  assert.equal(panel.resolvedFrom?.kind, 'bonding curve Pump.fun');
  assert.equal(panel.risk.score, result.risk.score);
  assert.equal(panel.risk.modules.length, result.risk.modules.length);
});

test('bandeau « note incomplète » : la vraie raison, pas un RPC accusé à tort', () => {
  assert.match(describeMissingModule('recensement désactivé (--no-census / HOLDER_CENSUS=false)'), /désactivé dans les réglages/);
  assert.match(describeMissingModule('RPC saturé (429)'), /réessaie/);
  assert.match(describeMissingModule('Method getProgramAccounts is not supported (indexed)'), /refuse cette méthode/);
  assert.equal(describeMissingModule('autre raison'), 'autre raison');
});
