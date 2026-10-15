/**
 * scripts/simulateBundle.ts
 * ---------------------------------------------------------------------------
 * Simulation de bout en bout de l'assemblage : pool -> create -> buy -> tip.
 *
 * AUCUN FONDS N'EST ENGAGE. Le script :
 *   - force `dryRun: true` sur le bundler (verifie par assertion) ;
 *   - n'utilise par defaut que des keypairs ephemeres, jamais celles du .env ;
 *   - n'appelle que des methodes RPC en lecture : getAccountInfo,
 *     getLatestBlockhash, simulateTransaction.
 *
 *   node scripts/simulateBundle.ts                       # payeur jetable
 *   USE_REAL_PAYER=true node scripts/simulateBundle.ts   # payeur finance
 *
 * LIRE LE VERDICT
 * Le but n'est pas d'obtenir une simulation sans erreur, mais de savoir ce que
 * l'erreur prouve :
 *   not-exercised : rejet au niveau transaction, 0 CU consommee. Le programme
 *                   n'a pas ete atteint - ce run ne dit RIEN sur la table de
 *                   comptes. C'est le resultat attendu avec un payeur jetable.
 *   shape-ok      : le programme a tourne et n'a bute que sur les fonds. La
 *                   forme des instructions est bonne.
 *   shape-broken  : erreur de compte ou de desserialisation. L'IDL a derive,
 *                   corriger CREATE_ACCOUNTS / BUY_ACCOUNTS dans pumpfun.ts.
 *
 * Pour un vrai controle de forme il faut donc un payeur finance : soit
 * USE_REAL_PAYER=true, soit RPC_URL pointe sur devnet avec une cle airdroppee.
 * ---------------------------------------------------------------------------
 */

import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
import pino from 'pino';

import { JitoBundler } from '../src/solana/jitoBundle.ts';
import { KeypairPool } from '../src/solana/keypairPool.ts';
import {
  DEFAULT_GLOBAL_PARAMS,
  GLOBAL_PDA,
  MAX_TX_BYTES,
  PUMP_PROGRAM_ID,
  buildCreateAndBuyTx,
  fetchGlobal,
  type PumpGlobal,
} from '../src/solana/pumpfun.ts';

const log = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  transport: { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss.l' } },
});

const RPC_URL = process.env.RPC_URL ?? 'https://api.mainnet-beta.solana.com';
const SOL_BUDGET = Number(process.env.INITIAL_BUY_SOL ?? '0.15');
const SLIPPAGE_BPS = Number(process.env.SLIPPAGE_BPS ?? '500');
const CU_LIMIT = Number(process.env.COMPUTE_UNIT_LIMIT ?? '350000');
const CU_PRICE = Number(process.env.COMPUTE_UNIT_PRICE_MICROLAMPORTS ?? '150000');

/** Metadonnees representatives : URI d'une vraie longueur de gateway Irys. */
const SAMPLE = {
  name: 'Gigachad Frog',
  symbol: 'GFROG',
  uri: 'https://gateway.irys.xyz/1RVCLbcy4FEgTJ8Wnfo1BjZqoUWmCFTraqLNYMyXktA',
};

/**
 * Classe l'erreur de simulation pour dire a l'operateur ce qu'elle prouve.
 * C'est tout l'interet du script : distinguer "manque de SOL" (attendu) de
 * "l'IDL a bouge" (a corriger tout de suite).
 */
function classifySimulationError(
  err: unknown,
  logs: string[] | null,
  unitsConsumed: number,
): { verdict: 'shape-ok' | 'shape-broken' | 'not-exercised' | 'unknown'; explanation: string } {
  if (err === null) {
    return { verdict: 'shape-ok', explanation: 'simulation succeeded outright' };
  }

  // Erreur au niveau TRANSACTION (une chaine nue, pas un objet InstructionError) :
  // le runtime a rejete la tx avant d'entrer dans le moindre programme.
  // `unitsConsumed === 0` le confirme. Aucune conclusion possible sur la forme
  // des instructions : elles n'ont tout simplement pas ete executees.
  if (typeof err === 'string' && unitsConsumed === 0) {
    return {
      verdict: 'not-exercised',
      explanation:
        `transaction-level rejection ("${err}") with 0 compute units consumed: the pump program ` +
        'was never entered, so this run proves NOTHING about the account table. Re-run with a ' +
        'funded payer (USE_REAL_PAYER=true + DEPLOYER_PRIVATE_KEY, or point RPC_URL at devnet ' +
        'with a funded key) to actually exercise create/buy.',
    };
  }

  const blob = `${JSON.stringify(err)} ${(logs ?? []).join(' ')}`.toLowerCase();

  const fundingSignals = [
    'insufficient lamports',
    'insufficient funds',
    'attempt to debit an account but found no record of a prior credit',
    'transfer: insufficient',
  ];
  if (fundingSignals.some((s) => blob.includes(s))) {
    return {
      verdict: 'shape-ok',
      explanation:
        'failure is funding-related, not structural: the program accepted the instruction shape ' +
        '(discriminators, account list, borsh encoding) and only stopped on an underfunded payer',
    };
  }

  const shapeSignals = [
    'invalidaccountdata',
    'notenoughaccountkeys',
    'accountnotexecutable',
    'invalidinstructiondata',
    'failed to deserialize',
    'instructionfallbacknotfound',
    'declaredprogramidmismatch',
    'constraintseeds',
    'accountownedbywrongprogram',
    'privilege escalation',
  ];
  const hit = shapeSignals.find((s) => blob.includes(s));
  if (hit) {
    return {
      verdict: 'shape-broken',
      explanation:
        `structural failure ("${hit}"): the account table or the instruction encoding no longer ` +
        'matches the deployed program. Re-check CREATE_ACCOUNTS / BUY_ACCOUNTS in src/solana/pumpfun.ts ' +
        'against https://github.com/pump-fun/pump-public-docs/blob/main/idl/pump.json',
    };
  }

  return {
    verdict: 'unknown',
    explanation: 'unrecognised failure, inspect the raw logs below',
  };
}

async function main(): Promise<void> {
  log.info({ rpc: RPC_URL.replace(/api-key=[^&]+/, 'api-key=***') }, 'simulateBundle starting');

  const connection = new Connection(RPC_URL, 'confirmed');

  // --- 1. Pool de keypairs -------------------------------------------------
  const pool = new KeypairPool({ targetSize: 10, refillIntervalMs: 1000 }, log);
  const poolStart = performance.now();
  await pool.start();
  log.info(
    { warmupMs: +(performance.now() - poolStart).toFixed(1), stats: pool.stats },
    '1/6 keypair pool warmed',
  );

  const acquireStart = performance.now();
  const mint = pool.acquire();
  log.info(
    {
      acquireMicros: +((performance.now() - acquireStart) * 1000).toFixed(1),
      mint: mint.publicKey.toBase58(),
      remaining: pool.size,
    },
    '2/6 mint acquired from pool',
  );

  // --- 2. Parametres on-chain ---------------------------------------------
  let global: PumpGlobal;
  try {
    global = await fetchGlobal(connection);
    log.info(
      {
        feeRecipient: global.feeRecipient.toBase58(),
        feeBasisPoints: global.feeBasisPoints.toString(),
        virtualSol: global.initialVirtualSolReserves.toString(),
        virtualTokens: global.initialVirtualTokenReserves.toString(),
      },
      '3/6 global account read on-chain',
    );
  } catch (err) {
    log.warn({ err, globalPda: GLOBAL_PDA.toBase58() }, 'could not read global, using offline defaults');
    global = {
      initialized: true,
      authority: PublicKey.default,
      // Repli hors-ligne uniquement : ce feeRecipient n'est pas le vrai.
      feeRecipient: Keypair.generate().publicKey,
      ...DEFAULT_GLOBAL_PARAMS,
    };
  }

  // --- 3. Payeur -----------------------------------------------------------
  //
  // Par defaut : keypair jetable. Le script ne lit aucune cle du .env et la
  // simulation s'arrete alors au niveau transaction (payeur inexistant), ce
  // qui suffit a valider la taille, la cotation et les PDA - mais PAS la table
  // de comptes, puisque le programme n'est jamais atteint.
  //
  // Avec USE_REAL_PAYER=true, on signe avec la vraie cle deployeur. Cela reste
  // sans risque : `simulateTransaction` est un appel en lecture, la tx n'est
  // jamais diffusee et le bundler est verrouille en dry-run. C'est le seul
  // moyen d'exercer reellement create + buy contre le programme deploye.
  let payer: Keypair;
  const useRealPayer = process.env.USE_REAL_PAYER === 'true';
  if (useRealPayer) {
    const secret = process.env.DEPLOYER_PRIVATE_KEY;
    if (!secret) throw new Error('USE_REAL_PAYER=true but DEPLOYER_PRIVATE_KEY is not set');
    payer = Keypair.fromSecretKey(bs58.decode(secret.trim()));
    const balance = await connection.getBalance(payer.publicKey, 'confirmed');
    log.warn(
      { payer: payer.publicKey.toBase58(), balanceSol: balance / LAMPORTS_PER_SOL },
      'signing the simulation with the real deployer key (read-only, nothing is broadcast)',
    );
    if (balance < (SOL_BUDGET + 0.05) * LAMPORTS_PER_SOL) {
      log.warn(
        { needSol: SOL_BUDGET + 0.05 },
        'balance is below budget + rent: the simulation will still stop on funds',
      );
    }
  } else {
    payer = Keypair.generate();
    log.info(
      'using a throwaway payer: the program will NOT be reached. ' +
        'Set USE_REAL_PAYER=true to validate the account table for real.',
    );
  }

  // --- 4. Bundler Jito en dry-run -----------------------------------------
  const bundler = new JitoBundler(
    {
      blockEngines: (process.env.JITO_BLOCK_ENGINES ?? 'ny.mainnet.block-engine.jito.wtf').split(','),
      httpUrl: process.env.JITO_HTTP_URL ?? 'https://mainnet.block-engine.jito.wtf',
      tipFloorUrl: process.env.JITO_TIP_FLOOR_URL ?? 'https://bundles.jito.wtf/api/v1/bundles/tip_floor',
      dynamicTip: true,
      tipPercentile: 75,
      tipMinLamports: 1_000_000,
      tipMaxLamports: 20_000_000,
      tipMultiplier: 1.3,
      bundleTimeoutMs: 25_000,
      dryRun: true, // non negociable dans ce script
    },
    connection,
    log,
  );
  if (!(bundler as unknown as { cfg: { dryRun: boolean } }).cfg.dryRun) {
    throw new Error('refusing to run: bundler is not in dry-run mode');
  }
  await bundler.init();

  const tipInstruction = bundler.buildTipInstruction(payer.publicKey);
  log.info(
    { tipLamports: bundler.tipLamports, tipSol: bundler.tipLamports / LAMPORTS_PER_SOL },
    '4/6 jito tip sized from the live tip floor',
  );

  // --- 5. Assemblage de la transaction ------------------------------------
  const { blockhash } = await connection.getLatestBlockhash('confirmed');

  const buildStart = performance.now();
  const built = buildCreateAndBuyTx({
    payer,
    mint,
    metadata: SAMPLE,
    solBudgetLamports: BigInt(Math.round(SOL_BUDGET * LAMPORTS_PER_SOL)),
    slippageBps: SLIPPAGE_BPS,
    global,
    recentBlockhash: blockhash,
    computeUnitLimit: CU_LIMIT,
    computeUnitPriceMicroLamports: CU_PRICE,
    tipInstruction,
  });
  const buildMs = +(performance.now() - buildStart).toFixed(2);

  const tokens = Number(built.quote.amount) / 10 ** 6;
  log.info(
    {
      buildMs,
      sizeBytes: built.size,
      headroomBytes: MAX_TX_BYTES - built.size,
      usedLookupTables: built.usedLookupTables,
      instructions: built.tx.message.compiledInstructions.length,
      accountKeys: built.tx.message.staticAccountKeys.length,
      signatures: built.tx.signatures.length,
    },
    '5/6 transaction compiled',
  );
  log.info(
    {
      budgetSol: SOL_BUDGET,
      slippageBps: SLIPPAGE_BPS,
      tokensRequested: tokens.toLocaleString('en-US'),
      quotedTokens: (Number(built.quote.quotedTokens) / 10 ** 6).toLocaleString('en-US'),
      supplyPct: `${built.quote.supplyPct.toFixed(3)}%`,
      solIntoCurve: Number(built.quote.solIntoCurve) / LAMPORTS_PER_SOL,
      protocolFeeSol: Number(built.quote.feeLamports) / LAMPORTS_PER_SOL,
      maxSolCostSol: Number(built.quote.maxSolCost) / LAMPORTS_PER_SOL,
    },
    'bonding curve quote',
  );
  log.info(
    Object.fromEntries(Object.entries(built.addresses).map(([k, v]) => [k, v.toBase58()])),
    'derived addresses',
  );

  if (built.size > MAX_TX_BYTES) {
    log.error({ size: built.size }, 'transaction exceeds the packet limit');
  }

  // --- 6. Simulation on-chain ---------------------------------------------
  const sim = await connection.simulateTransaction(built.tx, {
    sigVerify: false,
    replaceRecentBlockhash: true,
    commitment: 'confirmed',
  });

  const { verdict, explanation } = classifySimulationError(sim.value.err, sim.value.logs, sim.value.unitsConsumed ?? 0);
  const line = { verdict, explanation, unitsConsumed: sim.value.unitsConsumed, err: sim.value.err };
  if (verdict === 'shape-broken') log.error(line, '6/6 SIMULATION VERDICT');
  else if (verdict === 'not-exercised') log.warn(line, '6/6 SIMULATION VERDICT');
  else log.info(line, '6/6 SIMULATION VERDICT');

  if (sim.value.logs?.length) {
    log.info({ logs: sim.value.logs.slice(-20) }, 'program logs (tail)');
  }

  // --- 7. Recapitulatif du bundle -----------------------------------------
  // Rien a envoyer : `buildCreateAndBuyTx` a deja produit LA transaction qui
  // constituerait le bundle, tip inclus. Le bundle reel est donc cette unique
  // transaction - un seul slot, une seule signature a surveiller.
  const tipAccount = tipInstruction.keys[1]?.pubkey.toBase58();
  log.info(
    {
      bundleTxCount: 1,
      txSignature: built.tx.signatures[0] ? Buffer.from(built.tx.signatures[0]).toString('hex').slice(0, 16) + '...' : null,
      tipAccount,
      tipLamports: bundler.tipLamports,
      blockEngines: (process.env.JITO_BLOCK_ENGINES ?? 'ny.mainnet.block-engine.jito.wtf').split(','),
    },
    'bundle composition (nothing was sent)',
  );

  // --- Nettoyage -----------------------------------------------------------
  pool.dispose(mint);
  pool.stop();
  bundler.close();

  const wiped = mint.secretKey.every((b) => b === 0);
  log.info({ mintSecretWiped: wiped, poolStats: pool.stats }, 'done');

  if (verdict === 'shape-broken') process.exitCode = 1;
}

main().catch((err) => {
  log.error({ err }, 'simulateBundle failed');
  process.exitCode = 1;
});
