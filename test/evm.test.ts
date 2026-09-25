import { after, afterEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPublicClient, defineChain, http, type PublicClient } from 'viem';
import { publicEndpoints } from '../src/chains/endpoints.js';
import { CHAINS, findChain, type EvmChain } from '../src/chains/registry.js';
import { auditToken, detectCapabilities } from '../src/evm/audit.js';
import { EvmStreamEngine, type EvmVerdictEvent } from '../src/evm/engine.js';
import { decodeEvmLog, type EvmLog } from '../src/evm/events.js';
import { computeEvmScore } from '../src/evm/score.js';
import { EvmHttpPollingSource } from '../src/evm/sources.js';
import { buildEvmBoard, renderBoard } from '../src/stream/dashboard.js';
import { ReputationStore } from '../src/stream/reputation.js';
import { fakeBytecode, logs, MockEvmNode, randomAddress, randomHash, startMockEvm, type RawLog } from './fixtures/evm.js';

const WETH = '0x4200000000000000000000000000000000000006';
const MULTICALL = '0xca11bde05977b3631167028862be2a173976ca11';
const E18 = 10n ** 18n;

let logIndex = 0;
const asLog = (raw: RawLog, block = 100): EvmLog => ({
  ...raw,
  address: raw.address.toLowerCase(),
  topics: raw.topics.map((t) => t.toLowerCase()),
  blockNumber: block,
  transactionHash: randomHash(),
  logIndex: logIndex++,
  source: 'test',
  receivedAt: process.hrtime.bigint(),
});

describe('registre des blockchains', () => {
  test('19 réseaux Based Bot, alias et Robinhood Chain', () => {
    assert.equal(findChain('robinhood')?.key, 'robinhood');
    assert.equal(findChain('Robinhood Chain')?.kind, 'evm');
    assert.equal(findChain('bnb')?.key, 'bsc');
    assert.equal(findChain('sol')?.kind, 'solana');
    const hood = findChain('hood') as EvmChain;
    assert.equal(hood.chainId, 4663);
    assert.equal(hood.wrappedNative?.symbol, 'WETH');
    assert.equal(findChain('inconnue'), null);
  });

  test("endpoints publics : au moins un RPC HTTP par chaîne EVM, aucune clé d'API", () => {
    for (const chain of CHAINS) {
      if (chain.kind !== 'evm') continue;
      const endpoints = publicEndpoints(chain);
      assert.ok(endpoints.http.length > 0, chain.key);
      assert.equal(new Set(endpoints.http).size, endpoints.http.length, `${chain.key} : doublons`);
      for (const url of [...endpoints.http, ...endpoints.ws]) {
        assert.match(url, /^(https|wss):\/\//, url);
        assert.doesNotMatch(url, /api[_-]?key|demo|[0-9a-f]{32}/i, url);
      }
    }
    const hood = publicEndpoints(findChain('robinhood') as EvmChain);
    assert.ok(hood.ws.length >= 3);
    assert.ok(hood.http.includes('https://rpc.mainnet.chain.robinhood.com'));
  });
});

describe('sources EVM : bascule entre endpoints et relais HTTP', () => {
  const servers: Server[] = [];
  after(() => servers.forEach((s) => s.close()));
  const until = async (predicate: () => boolean, ms = 5_000) => {
    const start = Date.now();
    while (!predicate()) {
      if (Date.now() - start > ms) throw new Error('délai dépassé');
      await new Promise((r) => setTimeout(r, 20));
    }
  };
  const collector = () => {
    const statuses: string[] = [];
    const received: EvmLog[] = [];
    return { statuses, received, onLog: (log: EvmLog) => received.push(log), onStatus: (_source: string, message: string) => statuses.push(message) };
  };

  test('endpoint HTTP injoignable : bascule sur le suivant de la liste', async () => {
    const node = new MockEvmNode(8453, MULTICALL);
    const { url, server } = await startMockEvm(node);
    servers.push(server);
    const c = collector();
    const source = new EvmHttpPollingSource({ urls: ['http://127.0.0.1:1', url], pollMs: 30 });
    await source.start(c.onLog, c.onStatus);
    try {
      assert.ok(c.statuses.some((m) => /injoignable .* bascule sur http:127\.0\.0\.1:\d+/.test(m)), c.statuses.join('\n'));
      node.mine([logs.pairCreatedV2(randomAddress(), randomAddress(), WETH, randomAddress())]);
      await until(() => c.received.length === 1);
      assert.equal(source.name, `http:${new URL(url).host}`);
    } finally {
      await source.stop();
    }
  });

  test("relais en veille tant qu'un WebSocket fonctionne, puis reprise sans trou", async () => {
    const node = new MockEvmNode(8453, MULTICALL);
    const { url, server } = await startMockEvm(node);
    servers.push(server);
    const c = collector();
    let wsUp = true;
    let lastSeen = 0;
    const source = new EvmHttpPollingSource({ urls: [url], pollMs: 30, standby: () => wsUp, lastSeenBlock: () => lastSeen });
    await source.start(c.onLog, c.onStatus);
    try {
      // Bloc livré par le WebSocket : le relais ne consomme pas le RPC.
      node.mine([logs.pairCreatedV2(randomAddress(), randomAddress(), WETH, randomAddress())]);
      lastSeen = node.block;
      await new Promise((r) => setTimeout(r, 200));
      assert.equal(node.calls.get('eth_getLogs') ?? 0, 0);

      // Le WebSocket tombe : le bloc miné pendant la coupure est récupéré.
      node.mine([logs.pairCreatedV2(randomAddress(), randomAddress(), WETH, randomAddress())]);
      wsUp = false;
      await until(() => c.received.length === 1);
      assert.equal(c.received[0]!.blockNumber, lastSeen + 1);
      assert.ok(c.statuses.some((m) => m.includes('aucun WebSocket disponible')));

      wsUp = true;
      await until(() => c.statuses.some((m) => m.includes('WebSocket rétabli')));
    } finally {
      await source.stop();
    }
  });
});

describe('décodage des événements EVM', () => {
  const token = randomAddress();
  test('créations de pool : v2, v3, v4', () => {
    const pair = randomAddress();
    const v2 = decodeEvmLog(logs.pairCreatedV2(randomAddress(), token, WETH, pair));
    assert.equal(v2?.kind, 'pool');
    if (v2?.kind === 'pool') {
      assert.equal(v2.dex, 'v2');
      assert.equal(v2.poolKey, pair.toLowerCase());
      assert.equal(v2.token0, token.toLowerCase());
      assert.equal(v2.token1, WETH);
    }
    const pool = randomAddress();
    const v3 = decodeEvmLog(logs.poolCreatedV3(randomAddress(), WETH, token, pool));
    assert.equal(v3?.kind === 'pool' && v3.poolAddress, pool.toLowerCase());
    const manager = randomAddress();
    const id = randomHash();
    const v4 = decodeEvmLog(logs.initializeV4(manager, id, '0x0000000000000000000000000000000000000000', token));
    assert.equal(v4?.kind === 'pool' && v4.poolKey, `${manager.toLowerCase()}:${id}`);
  });

  test('swaps normalisés du point de vue de la pool (v2, v3, v4)', () => {
    const v2 = decodeEvmLog(logs.swapV2(randomAddress(), 0n, 5n * E18, 1000n, 0n)); // WETH entre, token sort
    assert.deepEqual(v2?.kind === 'swap' && [v2.delta0, v2.delta1], [-1000n, 5n * E18]);
    const v3 = decodeEvmLog(logs.swapV3(randomAddress(), -1000n, 5n * E18));
    assert.deepEqual(v3?.kind === 'swap' && [v3.delta0, v3.delta1], [-1000n, 5n * E18]);
    // v4 : l'appelant paie 5 WETH (−) et reçoit 1000 tokens (+) → la pool reçoit 5 WETH et cède 1000 tokens.
    const v4 = decodeEvmLog(logs.swapV4(randomAddress(), randomHash(), 1000n, -5n * E18));
    assert.deepEqual(v4?.kind === 'swap' && [v4.delta0, v4.delta1], [-1000n, 5n * E18]);
  });

  test('log inconnu ou tronqué : null', () => {
    assert.equal(decodeEvmLog({ address: randomAddress(), topics: [randomHash()], data: '0x' }), null);
    assert.equal(decodeEvmLog({ ...logs.swapV2(randomAddress(), 1n, 1n, 1n, 1n), data: '0x1234' }), null);
  });
});

describe('moteur EVM', () => {
  const engines: EvmStreamEngine[] = [];
  afterEach(() => engines.splice(0).forEach((e) => e.stop()));
  const chain = findChain('base') as EvmChain;

  function setup(extra: Partial<ConstructorParameters<typeof EvmStreamEngine>[0]> = {}) {
    const engine = new EvmStreamEngine({ chain, reputation: new ReputationStore(), minTrades: 5, trackSeconds: 1_800, ...extra });
    engines.push(engine);
    const verdicts: EvmVerdictEvent[] = [];
    engine.on('verdict', (v) => verdicts.push(v));
    return { engine, verdicts };
  }

  test('nouvelle pool token/WETH → T0 puis ACTIF au seuil de trades, achats et ventes', () => {
    const { engine, verdicts } = setup();
    const token = randomAddress();
    const pair = randomAddress();
    engine.handleLog(asLog(logs.pairCreatedV2(chain.dexes[0]!.address, token, WETH, pair)));
    assert.equal(verdicts[0]?.phase, 'T0');
    assert.equal(verdicts[0]?.token.dexName, 'Uniswap v2');
    for (let i = 0; i < 4; i++) engine.handleLog(asLog(logs.swapV2(pair, 0n, E18, 1_000n, 0n))); // achats
    assert.equal(verdicts.filter((v) => v.phase === 'ACTIF').length, 0);
    engine.handleLog(asLog(logs.swapV2(pair, 500n, 0n, 0n, E18 / 2n))); // vente
    const actif = verdicts.find((v) => v.phase === 'ACTIF');
    assert.ok(actif);
    assert.equal(actif.token.activity.buys, 4);
    assert.equal(actif.token.activity.sells, 1);
    assert.equal(actif.token.activity.volumeRaw, 4n * E18 + E18 / 2n);
  });

  test('pool entre deux devises ignorée ; swaps de pools inconnues ignorés', () => {
    const { engine, verdicts } = setup({ quotes: ['0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'] });
    engine.handleLog(asLog(logs.poolCreatedV3(randomAddress(), WETH, '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', randomAddress())));
    engine.handleLog(asLog(logs.swapV3(randomAddress(), 1n, -1n)));
    assert.equal(verdicts.length, 0);
    assert.equal(engine.stats().tracked, 0);
  });

  test('devise de cotation inconnue apprise sur les premières pools', () => {
    const noWrapped = { ...chain, wrappedNative: undefined };
    const { engine, verdicts } = setup({ chain: noWrapped });
    const usd = randomAddress();
    for (let i = 0; i < 3; i++) engine.handleLog(asLog(logs.pairCreatedV2(randomAddress(), randomAddress(), usd, randomAddress())));
    assert.equal(verdicts.length, 0); // apprentissage
    assert.equal(engine.isQuote(usd.toLowerCase()), true);
    const token = randomAddress();
    engine.handleLog(asLog(logs.pairCreatedV2(randomAddress(), usd, token, randomAddress())));
    assert.equal(verdicts[0]?.token.address, token.toLowerCase());
  });

  test('pool v4 en ETH natif : swaps suivis par identifiant de pool', () => {
    const { engine, verdicts } = setup({ minTrades: 2 });
    const manager = randomAddress();
    const id = randomHash();
    engine.handleLog(asLog(logs.initializeV4(manager, id, '0x0000000000000000000000000000000000000000', randomAddress())));
    engine.handleLog(asLog(logs.swapV4(manager, id, -E18, 1_000n)));
    engine.handleLog(asLog(logs.swapV4(manager, randomHash(), -E18, 1_000n))); // autre pool
    engine.handleLog(asLog(logs.swapV4(manager, id, -E18, 1_000n)));
    const actif = verdicts.find((v) => v.phase === 'ACTIF');
    assert.equal(actif?.token.activity.buys, 2);
  });

  test('doublons entre sources ignorés', () => {
    const { engine } = setup();
    const log = asLog(logs.pairCreatedV2(randomAddress(), randomAddress(), WETH, randomAddress()));
    engine.handleLog(log);
    engine.handleLog({ ...log, source: 'autre' });
    assert.equal(engine.stats().duplicates, 1);
    assert.equal(engine.stats().tracked, 1);
  });

  test('alertes : vente du dev et retrait de liquidité', () => {
    const { engine, verdicts } = setup();
    const token = randomAddress();
    const pair = randomAddress();
    engine.handleLog(asLog(logs.pairCreatedV2(randomAddress(), token, WETH, pair)));
    const state = engine.getToken(token)!;
    state.audit = {
      decimals: 18,
      totalSupply: 1_000n * E18,
      owner: null,
      ownerRenounced: true,
      codeSize: 100,
      proxy: 'none',
      capabilities: detectCapabilities('0x'),
      creator: randomAddress(),
      creatorBalance: 100n * E18,
      devPct: 10,
      quote: { address: WETH, symbol: 'WETH', decimals: 18 },
      liquidityQuote: 20,
      auditedAt: Date.now(),
    };
    state.maxDevBalance = 100n * E18;
    state.maxLiquidity = 20;
    engine.applyRefresh(state, 10n * E18, 19);
    assert.equal(verdicts.filter((v) => v.phase === 'ALERTE').length, 1);
    assert.equal(state.devSold, true);
    engine.applyRefresh(state, 10n * E18, 1);
    const last = verdicts.at(-1)!;
    assert.equal(last.phase, 'ALERTE');
    assert.equal(state.liquidityPulled, true);
    assert.ok(last.verdict.score >= 90);
  });
});

describe('score EVM', () => {
  const base = {
    decimals: 18,
    totalSupply: 1_000n,
    owner: null,
    ownerRenounced: true,
    codeSize: 500,
    proxy: 'none' as const,
    capabilities: detectCapabilities('0x'),
    quote: { address: WETH, symbol: 'WETH', decimals: 18 },
    auditedAt: 0,
  };
  const score = (audit: object, extra = {}) =>
    computeEvmScore({ audit: { ...base, ...audit }, creatorLaunches24h: 1, creatorDevSells: 0, devSold: false, liquidityPulled: false, ...extra });

  test('token standard, propriété renoncée, LP brûlés → VERT', () => {
    const v = score({ devPct: 2, lpBurnedPct: 100, liquidityQuote: 12 });
    assert.equal(v.level, 'VERT');
  });

  test('mint + blacklist avec propriétaire actif → ROUGE', () => {
    const v = score({
      owner: randomAddress(),
      ownerRenounced: false,
      capabilities: detectCapabilities(fakeBytecode(['mint(address,uint256)', 'setBots(address[],bool)'])),
    });
    assert.equal(v.level, 'ROUGE');
    assert.ok(v.findings.some((f) => f.message.includes('honeypot')));
  });

  test('proxy modifiable → plancher 65 ; créateur à 45 % → plancher 75', () => {
    assert.ok(score({ proxy: 'eip1967' }).score >= 65);
    assert.ok(score({ devPct: 45 }).score >= 75);
  });

  test('audit en cours : score neutre avec mention', () => {
    const v = computeEvmScore({ creatorLaunches24h: 0, creatorDevSells: 0, devSold: false, liquidityPulled: false });
    assert.equal(v.score, 0);
    assert.ok(v.findings.some((f) => f.message.includes('Audit du contrat en cours')));
  });
});

describe('audit on-chain (faux nœud JSON-RPC)', () => {
  const servers: Server[] = [];
  after(() => servers.forEach((s) => s.close()));

  test('métadonnées, propriétaire, fonctions dangereuses, créateur, liquidité et LP (Multicall3)', async () => {
    const node = new MockEvmNode(31337, MULTICALL);
    const { url, server } = await startMockEvm(node);
    servers.push(server);
    const token = randomAddress().toLowerCase();
    const pair = randomAddress().toLowerCase();
    const creator = randomAddress().toLowerCase();
    node.addToken(token, {
      name: 'Hood Frog',
      symbol: 'HFROG',
      decimals: 18,
      totalSupply: 1_000_000n * E18,
      balances: new Map([[creator, 300_000n * E18]]),
      owner: creator,
      functions: ['mint(address,uint256)', 'setFees(uint256,uint256)'],
    });
    node.addToken(WETH, { name: 'Wrapped Ether', symbol: 'WETH', decimals: 18, totalSupply: 0n, balances: new Map([[pair, 4n * E18]]) });
    node.addToken(pair, { name: 'LP', symbol: 'UNI-V2', decimals: 18, totalSupply: 100n, balances: new Map([['0x000000000000000000000000000000000000dead', 99n]]) });
    node.nonces.set(creator, 2);
    const txHash = node.mine([logs.pairCreatedV2(randomAddress(), token, WETH, pair)], { from: creator });

    const viemChain = defineChain({
      id: 31337,
      name: 'Mock',
      nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
      rpcUrls: { default: { http: [url] } },
      contracts: { multicall3: { address: MULTICALL } },
    });
    const chain: EvmChain = { ...(findChain('base') as EvmChain), viem: viemChain, chainId: 31337 };
    const client = createPublicClient({ chain: viemChain, transport: http(url) }) as PublicClient;
    const pool = decodeEvmLog(logs.pairCreatedV2(randomAddress(), token, WETH, pair));
    assert.ok(pool && pool.kind === 'pool');

    const audit = await auditToken(client, chain, { token, quote: WETH, pool, creationTx: txHash });
    assert.equal(audit.symbol, 'HFROG');
    assert.equal(audit.name, 'Hood Frog');
    assert.equal(audit.owner, creator);
    assert.equal(audit.ownerRenounced, false);
    assert.deepEqual(audit.capabilities.mint, ['mint(address,uint256)']);
    assert.deepEqual(audit.capabilities.fees, ['setFees(uint256,uint256)']);
    assert.equal(audit.creator, creator);
    assert.equal(audit.creatorNonce, 2);
    assert.equal(audit.devPct, 30);
    assert.equal(audit.liquidityQuote, 4);
    assert.equal(audit.lpBurnedPct, 99);
    assert.equal(audit.quote.symbol, 'WETH');
    assert.ok((node.calls.get('eth_call') ?? 0) > 0);
  });
});

describe('commande `npm run stream base` (bout en bout, RPC HTTP simulé)', () => {
  const servers: Server[] = [];
  after(() => servers.forEach((s) => s.close()));

  test('interrogation eth_getLogs → T0, ACTIF puis audit ROUGE en JSONL ; classement', async () => {
    const node = new MockEvmNode(8453, MULTICALL);
    const { url, server } = await startMockEvm(node);
    servers.push(server);
    const token = randomAddress().toLowerCase();
    const pair = randomAddress().toLowerCase();
    const creator = randomAddress().toLowerCase();
    node.addToken(token, {
      name: 'Rug Frog',
      symbol: 'RFROG',
      decimals: 18,
      totalSupply: 1_000_000n * E18,
      balances: new Map([[creator, 450_000n * E18]]),
      owner: creator,
      functions: ['mint(address,uint256)'],
    });
    node.addToken(WETH, { name: 'Wrapped Ether', symbol: 'WETH', decimals: 18, totalSupply: 0n, balances: new Map([[pair, 3n * E18]]) });

    const cache = join(mkdtempSync(join(tmpdir(), 'sol-risk-evm-')), 'creators.json');
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', 'src/index.ts', 'stream', 'base', '--rpc', url, '--jsonl', '--stats', '0', '--min-trades', '4', '--poll-ms', '100', '--cache', cache],
      { env: { ...process.env, NO_COLOR: '1' }, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    const exited = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)));
    const waitFor = async (predicate: () => boolean, ms = 20_000) => {
      const start = Date.now();
      while (!predicate()) {
        if (Date.now() - start > ms) throw new Error(`délai dépassé\n${stderr}`);
        await new Promise((r) => setTimeout(r, 50));
      }
    };

    try {
      // La source a lu le bloc courant : les blocs minés ensuite seront observés.
      await waitFor(() => stderr.includes('à partir du bloc'));
      node.mine([logs.pairCreatedV2('0x8909dc15e40173ff4699343b6eb8132c65e18ec6', token, WETH, pair)], { from: creator });
      for (let i = 0; i < 5; i++) node.mine([logs.swapV2(pair, 0n, E18 / 10n, 1_000n * E18, 0n)]);

      type Line = { phase: string; address: string; symbol: string | null; level: string | null; dex: string; audit: { capabilities: { mint: string[] } } | null };
      const lines = () => stdout.split('\n').filter(Boolean).map((l) => JSON.parse(l) as Line);
      await waitFor(() => lines().some((l) => l.phase === 'T1'));

      const t0 = lines().find((l) => l.phase === 'T0')!;
      assert.equal(t0.address, token);
      assert.equal(t0.dex, 'Uniswap v2');
      assert.ok(lines().some((l) => l.phase === 'ACTIF'));
      const t1 = lines().find((l) => l.phase === 'T1')!;
      assert.equal(t1.symbol, 'RFROG');
      assert.equal(t1.level, 'ROUGE');
      assert.deepEqual(t1.audit?.capabilities.mint, ['mint(address,uint256)']);

      child.kill('SIGINT');
      assert.equal(await exited, 0);
    } finally {
      if (child.exitCode === null) child.kill('SIGKILL');
    }
  });

  test('WebSocket injoignable : le relais HTTP prend le suivi en charge', async () => {
    const node = new MockEvmNode(8453, MULTICALL);
    const { url, server } = await startMockEvm(node);
    servers.push(server);
    const token = randomAddress().toLowerCase();
    node.addToken(token, { name: 'Relay', symbol: 'RLY', decimals: 18, totalSupply: 1_000n * E18, balances: new Map() });
    const cache = join(mkdtempSync(join(tmpdir(), 'sol-risk-evm-')), 'creators.json');
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', 'src/index.ts', 'stream', 'base', '--rpc', url, '--ws', 'ws://127.0.0.1:1', '--jsonl', '--all', '--stats', '0', '--poll-ms', '100', '--cache', cache],
      { env: { ...process.env, NO_COLOR: '1' }, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    const exited = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)));
    const waitFor = async (predicate: () => boolean, ms = 20_000) => {
      const start = Date.now();
      while (!predicate()) {
        if (Date.now() - start > ms) throw new Error(`délai dépassé\n${stderr}`);
        await new Promise((r) => setTimeout(r, 50));
      }
    };
    try {
      await waitFor(() => stderr.includes('aucun WebSocket disponible'));
      assert.match(stderr, /relais HTTP/);
      node.mine([logs.pairCreatedV2(randomAddress(), token, WETH, randomAddress())], { from: randomAddress() });
      await waitFor(() => stdout.includes('"phase":"T0"'));
      assert.match(stdout, new RegExp(token));
      child.kill('SIGINT');
      assert.equal(await exited, 0);
    } finally {
      if (child.exitCode === null) child.kill('SIGKILL');
    }
  });
});

test('classement EVM : tokens actifs uniquement, volume en devise de cotation', () => {
  const chain = findChain('base') as EvmChain;
  const engine = new EvmStreamEngine({ chain, reputation: new ReputationStore(), minTrades: 2, trackSeconds: 1_800 });
  const token = randomAddress();
  const pair = randomAddress();
  engine.handleLog(asLog(logs.pairCreatedV2(randomAddress(), token, WETH, pair)));
  engine.handleLog(asLog(logs.pairCreatedV2(randomAddress(), randomAddress(), WETH, randomAddress()))); // inactif
  for (let i = 0; i < 3; i++) engine.handleLog(asLog(logs.swapV2(pair, 0n, E18, 1_000n * E18, 0n)));
  const state = engine.getToken(token)!;
  state.audit = {
    symbol: 'LIVE',
    decimals: 18,
    totalSupply: 1_000_000n * E18,
    owner: null,
    ownerRenounced: true,
    codeSize: 100,
    proxy: 'none',
    capabilities: detectCapabilities('0x'),
    quote: { address: WETH, symbol: 'WETH', decimals: 18 },
    auditedAt: Date.now(),
  };
  const rows = buildEvmBoard(engine, { sort: 'volume', limit: 10, now: Date.now() });
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.symbol, 'LIVE');
  assert.equal(rows[0]!.volume, 3);
  assert.equal(rows[0]!.unit, 'WETH');
  // prix = 1 WETH / 1000 tokens ; mcap = 1 000 000 × 0,001 = 1000 WETH
  assert.equal(rows[0]!.mcap, 1000);
  // Pas de holders ni de bonding curve sur EVM : colonnes masquées.
  const header = renderBoard(rows, 'volume')[0]!.replace(/\x1b\[[0-9;]*m/g, '');
  assert.match(header, /Volume/);
  assert.doesNotMatch(header, /Holders|Courbe|Top10/);
  engine.stop();
});
