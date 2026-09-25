/**
 * Démo hors-ligne du mode stream sur une chaîne EVM : un faux nœud JSON-RPC
 * rejoue des lancements typiques, analysés par la vraie commande.
 *
 *   npm run demo:stream -- robinhood
 *   npm run demo:stream -- base --all
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EvmChain } from '../src/chains/registry.js';
import { ZERO_ADDRESS } from '../src/evm/events.js';
import { runStream } from '../src/stream/cli.js';
import { logs, MockEvmNode, randomAddress, randomHash, startMockEvm } from '../test/fixtures/evm.js';

const E18 = 10n ** 18n;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function runEvmDemo(chain: EvmChain, extraArgs: string[]): Promise<void> {
  const multicall = chain.viem.contracts?.multicall3?.address ?? '0xca11bde05977b3631167028862be2a173976ca11';
  const node = new MockEvmNode(chain.chainId, multicall);
  const { url, server } = await startMockEvm(node);

  // Devise de cotation : wrapped natif de la chaîne (ou un équivalent fictif, déclaré avec --quote).
  const quote = chain.wrappedNative?.address ?? randomAddress().toLowerCase();
  const quoteArgs = chain.wrappedNative ? [] : ['--quote', quote];
  const quoteBalances = new Map<string, bigint>();
  node.addToken(quote, { name: `Wrapped ${chain.nativeSymbol}`, symbol: chain.wrappedNative?.symbol ?? `W${chain.nativeSymbol}`, decimals: 18, totalSupply: 0n, balances: quoteBalances });

  const v2Factory = chain.dexes.find((d) => d.kind === 'v2')?.address ?? randomAddress();
  const v3Factory = chain.dexes.find((d) => d.kind === 'v3')?.address ?? randomAddress();
  const v4Manager = chain.dexes.find((d) => d.kind === 'v4')?.address ?? randomAddress();
  const SUPPLY = 1_000_000_000n * E18;

  // 1. Token sain : pas de propriétaire, LP brûlés, dev à 2 %.
  const hood = randomAddress().toLowerCase();
  const hoodPair = randomAddress().toLowerCase();
  const hoodDev = randomAddress().toLowerCase();
  node.addToken(hood, { name: 'Hood Frog', symbol: 'HFROG', decimals: 18, totalSupply: SUPPLY, balances: new Map([[hoodDev, (SUPPLY * 2n) / 100n]]) });
  node.addToken(hoodPair, { name: 'LP', symbol: 'UNI-V2', decimals: 18, totalSupply: 1_000n, balances: new Map([['0x000000000000000000000000000000000000dead', 1_000n]]) });
  node.nonces.set(hoodDev, 240);
  quoteBalances.set(hoodPair, 8n * E18);

  // 2. Rug : propriétaire actif, mint + blacklist, dev à 35 %.
  const rug = randomAddress().toLowerCase();
  const rugPool = randomAddress().toLowerCase();
  const rugDev = randomAddress().toLowerCase();
  const rugBalances = new Map([[rugDev, (SUPPLY * 35n) / 100n]]);
  node.addToken(rug, { name: 'Moon Rocket', symbol: 'MOON', decimals: 18, totalSupply: SUPPLY, balances: rugBalances, owner: rugDev, functions: ['mint(address,uint256)', 'setBots(address[],bool)'] });
  node.nonces.set(rugDev, 1);
  quoteBalances.set(rugPool, 5n * E18);

  // 3. Pool Uniswap v4 cotée en natif (launchpad), propriété renoncée.
  const pons = randomAddress().toLowerCase();
  const ponsId = randomHash();
  const ponsDev = randomAddress().toLowerCase();
  node.addToken(pons, { name: 'Pons Cat', symbol: 'PCAT', decimals: 18, totalSupply: SUPPLY, balances: new Map([[ponsDev, (SUPPLY * 5n) / 100n]]), owner: ZERO_ADDRESS });
  node.nonces.set(ponsDev, 57);

  const cache = join(mkdtempSync(join(tmpdir(), 'sol-risk-demo-evm-')), 'creators.json');
  const run = runStream([chain.key, '--rpc', url, '--poll-ms', '100', '--min-trades', '10', '--monitor', '1', '--refresh', '1', '--cache', cache, ...quoteArgs, ...extraArgs]);
  await sleep(1_500); // la source lit le bloc courant

  node.mine([logs.pairCreatedV2(v2Factory, hood, quote, hoodPair)], { from: hoodDev });
  node.mine([logs.poolCreatedV3(v3Factory, rug, quote, rugPool)], { from: rugDev });
  node.mine([logs.initializeV4(v4Manager, ponsId, ZERO_ADDRESS, pons)], { from: ponsDev });
  // 10 pools mortes : aucun swap, elles n'apparaîtront jamais au classement.
  for (let i = 0; i < 10; i++) {
    const dead = randomAddress().toLowerCase();
    node.addToken(dead, { name: `Dead ${i}`, symbol: `DEAD${i}`, decimals: 18, totalSupply: SUPPLY, balances: new Map() });
    node.mine([logs.pairCreatedV2(v2Factory, dead, quote, randomAddress())], { from: randomAddress() });
  }

  // Achats : 0,1 à 0,4 unité de devise pour ~1 M de tokens ; quelques ventes.
  for (let round = 0; round < 32; round++) {
    const sol = BigInt(1 + (round % 4)) * (E18 / 10n);
    const tokens = BigInt(1_000_000 - round * 5_000) * E18 * BigInt(1 + (round % 4));
    const sell = round % 5 === 4;
    node.mine([
      sell ? logs.swapV2(hoodPair, tokens / 2n, 0n, 0n, sol / 2n) : logs.swapV2(hoodPair, 0n, sol, tokens, 0n),
      ...(round < 22 ? [logs.swapV3(rugPool, -tokens, sol * 3n)] : []),
      ...(round % 2 === 0 ? [logs.swapV4(v4Manager, ponsId, -sol, tokens * 2n)] : []),
    ]);
    if (round === 24) {
      // Le dev du rug vend puis retire la liquidité.
      rugBalances.set(rugDev, SUPPLY / 100n);
      quoteBalances.set(rugPool, E18 / 20n);
    }
    await sleep(round < 24 ? 120 : 250);
  }
  await sleep(2_500);

  process.emit('SIGINT');
  await run;
  server.close();
}
