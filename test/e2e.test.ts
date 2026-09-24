/**
 * Tests de bout en bout : le scanner complet interroge un faux nœud RPC
 * (JSON-RPC HTTP) via @solana/web3.js, sur trois scénarios on-chain.
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import type { Server } from 'node:http';
import { promisify } from 'node:util';
import type { ScannerConfig } from '../src/config.js';
import { RAYDIUM_AMM_V4_AUTHORITY } from '../src/constants.js';
import { renderJson, renderReport } from '../src/report/console.js';
import { scanToken } from '../src/scanner.js';
import type { ScanResult } from '../src/types.js';
import { setColorEnabled } from '../src/utils/format.js';
import { MockChain, randomKey, startMockRpc } from './fixtures/mock-rpc.js';
import { buildHealthyChain, buildRaydiumChain, buildRugChain } from './fixtures/scenarios.js';

const config = (rpcUrl: string, overrides: Partial<ScannerConfig> = {}): ScannerConfig => ({
  rpcUrl,
  concurrency: 8,
  maxRetries: 0,
  creatorTxScanLimit: 150,
  mintHistoryMaxPages: 3,
  holderCensus: true,
  ...overrides,
});

describe('scan de bout en bout (RPC simulé)', () => {
  const servers: Server[] = [];
  const serve = async (chain: MockChain) => {
    const { url, server } = await startMockRpc(chain);
    servers.push(server);
    return url;
  };

  before(() => setColorEnabled(false));
  after(() => servers.forEach((s) => s.close()));

  test('rug Pump.fun : wallets clonés + dusting + liquidité retirée → ROUGE', async () => {
    const { chain, mint, creator, clones } = buildRugChain();
    const result = await scanToken(mint.toBase58(), config(await serve(chain)));

    assert.equal(result.risk.level, 'ROUGE', `score ${result.risk.score}`);
    assert.ok(result.risk.score >= 80);

    assert.equal(result.holders.status, 'ok');
    if (result.holders.status === 'ok') {
      const pool = result.holders.data.top.find((h) => h.kind === 'liquidity-pool');
      assert.equal(pool?.label, 'PumpSwap');
      assert.equal(result.holders.data.top.find((h) => h.owner === creator.toBase58())?.kind, 'creator');
    }

    assert.equal(result.clustering.status, 'ok');
    if (result.clustering.status === 'ok') {
      const cluster = result.clustering.data.largestCluster;
      assert.equal(cluster?.strictClone, true);
      assert.deepEqual(new Set(cluster?.owners), new Set(clones.map((c) => c.toBase58())));
    }

    assert.equal(result.dusting.status, 'ok');
    if (result.dusting.status === 'ok') {
      assert.equal(result.dusting.data.dustHolders, 800);
      assert.ok(result.dusting.data.dustRatio > 0.95);
    }

    assert.equal(result.reserve.status, 'ok');
    if (result.reserve.status === 'ok') {
      assert.equal(result.reserve.data.marketType, 'amm-pool');
      assert.equal(result.reserve.data.venue, 'PumpSwap');
      assert.equal(result.reserve.data.realReserveSol, 3);
    }

    assert.equal(result.creator.status, 'ok');
    if (result.creator.status === 'ok') {
      assert.equal(result.creator.data.address, creator.toBase58());
      assert.equal(result.creator.data.source, 'pump.fun bonding curve');
      assert.equal(result.creator.data.previousTokensCreated, 3);
      assert.ok(Math.abs(result.creator.data.holdingPct - 5) < 1e-9);
    }

    const report = renderReport(result);
    assert.match(report, /\[ROUGE\]/);
    assert.match(report, /Wallets clonés/);
    assert.match(report, /INDICATEURS CRITIQUES/);
  });

  test('bonding curve active, distribution organique → VERT', async () => {
    const { chain, mint } = buildHealthyChain();
    const result = await scanToken(mint.toBase58(), config(await serve(chain)));

    assert.equal(result.risk.level, 'VERT', `score ${result.risk.score}\n${renderReport(result)}`);
    assert.equal(result.risk.confidence, 1);
    assert.equal(result.token.name, 'Healthy Token');
    assert.equal(result.token.symbol, 'HLTH');

    assert.equal(result.reserve.status, 'ok');
    if (result.reserve.status === 'ok') {
      const r = result.reserve.data;
      assert.equal(r.marketType, 'bonding-curve');
      assert.equal(r.realReserveSol, 40);
      assert.ok(r.bondingCurveProgressPct! > 75 && r.bondingCurveProgressPct! < 80);
      assert.ok(Math.abs(r.reserveDiscrepancyPct ?? 1) < 1e-9);
      // mcap = 70 SOL / 459,86 M tokens × 1 Md ≈ 152 SOL
      assert.ok(Math.abs(r.marketCapSol - 152.2) < 0.5, `mcap ${r.marketCapSol}`);
    }

    if (result.holders.status === 'ok') {
      assert.equal(result.holders.data.top[0]?.kind, 'bonding-curve');
      assert.ok(result.holders.data.protocolPct > 30);
    }
    if (result.creator.status === 'ok') {
      assert.equal(result.creator.data.previousTokensCreated, 0);
      assert.equal(result.creator.data.fullHistory, true);
    }

    const json = JSON.parse(renderJson(result)) as ScanResult;
    assert.equal(json.risk.level, 'VERT');
    assert.equal(typeof json.token.supply, 'string');
  });

  test('pool Raydium AMM v4 + mint authority active + créateur retrouvé via l’historique du mint', async () => {
    const { chain, mint, creator } = buildRaydiumChain();
    const result = await scanToken(mint.toBase58(), config(await serve(chain)));

    assert.ok(result.risk.score >= 60, `score ${result.risk.score}`);
    assert.ok(result.risk.floors.some((f) => f.reason.includes('Mint authority')));

    assert.equal(result.reserve.status, 'ok');
    if (result.reserve.status === 'ok') {
      assert.equal(result.reserve.data.venue, 'Raydium AMM v4');
      assert.equal(result.reserve.data.realReserveSol, 500);
      // prix = 500 SOL / 300 M tokens → mcap = 500 / 0,3 ≈ 1666,7 SOL
      assert.ok(Math.abs(result.reserve.data.marketCapSol - 1666.67) < 0.1);
    }

    if (result.holders.status === 'ok') {
      const vault = result.holders.data.top.find((h) => h.owner === RAYDIUM_AMM_V4_AUTHORITY.toBase58());
      assert.equal(vault?.kind, 'liquidity-pool');
    }

    assert.equal(result.creator.status, 'ok');
    if (result.creator.status === 'ok') {
      assert.equal(result.creator.data.address, creator.toBase58());
      assert.equal(result.creator.data.source, 'mint creation tx');
    }
  });

  test('census désactivé : module dusting indisponible, confiance réduite', async () => {
    const { chain, mint } = buildHealthyChain();
    const result = await scanToken(mint.toBase58(), config(await serve(chain), { holderCensus: false }));
    assert.equal(result.dusting.status, 'unavailable');
    assert.equal(result.risk.confidence, 0.9);
    assert.equal(chain.calls.get('getProgramAccounts') ?? 0, 0);
  });

  test('adresse qui n’est pas un mint → erreur explicite', async () => {
    const chain = new MockChain();
    const url = await serve(chain);
    await assert.rejects(() => scanToken(randomKey().toBase58(), config(url)), /Aucun compte trouvé/);
    await assert.rejects(() => scanToken('pas-une-adresse', config(url)), /Adresse de mint invalide/);
  });

  test('CLI : sortie JSON et code de sortie --fail-on', async () => {
    const { chain, mint } = buildRugChain();
    const url = await serve(chain);
    const run = promisify(execFile);
    const args = ['--import', 'tsx', 'src/index.ts', mint.toBase58(), '--rpc', url, '--json', '--fail-on', 'rouge'];
    const outcome = await run(process.execPath, args, { env: { ...process.env, NO_COLOR: '1' } }).then(
      (r) => ({ code: 0, stdout: r.stdout }),
      (e: { code: number; stdout: string }) => ({ code: e.code, stdout: e.stdout }),
    );
    assert.equal(outcome.code, 2);
    const json = JSON.parse(outcome.stdout) as ScanResult;
    assert.equal(json.risk.level, 'ROUGE');
    assert.equal(json.mint, mint.toBase58());
  });
});
