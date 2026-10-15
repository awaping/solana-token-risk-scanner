/**
 * scripts/testRoundtrip.ts
 * ---------------------------------------------------------------------------
 * Cycle financier complet : pool -> create+buy -> monitoring -> sell -> fees.
 *
 * DEUX MODES
 *
 *   Par defaut (SIMULATION) : rien n'est diffuse. Chaque transaction est
 *   construite, signee et simulee contre le RPC ; le monitoring est rejoue sur
 *   une trajectoire de prix synthetique qui exerce reellement `decideExit`.
 *   Aucune cle du .env n'est lue, aucun SOL n'est engage.
 *
 *   EXECUTE=true (REEL, MAINNET) : deploie vraiment un token et depense
 *   vraiment du SOL. Double verrou volontaire :
 *       EXECUTE=true
 *       I_UNDERSTAND_THIS_SPENDS_REAL_SOL=true
 *   Un seul drapeau ne suffit pas : ce script cree un token public, permanent
 *   et attribue a votre adresse. Ce n'est pas annulable.
 *
 *   node scripts/testRoundtrip.ts
 *   EXECUTE=true I_UNDERSTAND_THIS_SPENDS_REAL_SOL=true node scripts/testRoundtrip.ts
 * ---------------------------------------------------------------------------
 */

import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey } from '@solana/web3.js';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';
import bs58 from 'bs58';
import pino from 'pino';

import { JitoBundler } from '../src/solana/jitoBundle.ts';
import { KeypairPool } from '../src/solana/keypairPool.ts';
import {
  DEFAULT_GLOBAL_PARAMS,
  MAX_TX_BYTES,
  buildCreateAndBuyTx,
  buildSellTx,
  curvePrice,
  fetchBondingCurve,
  fetchGlobal,
  quoteExactInputSell,
  type BondingCurveState,
  type PumpGlobal,
} from '../src/solana/pumpfun.ts';
import { CurveMonitor, type CurveSnapshot } from '../src/trader/monitor.ts';
import { Position, parseTiers } from '../src/trader/position.ts';
import { ExitExecutor, decideExit, type ExitConfig } from '../src/trader/exit.ts';
import {
  DEFAULT_FEE_CLAIM_CONFIG,
  claimCreatorFees,
  creatorVaultBalance,
} from '../src/trader/fees.ts';

const log = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  transport: { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss.l' } },
});

const EXECUTE =
  process.env.EXECUTE === 'true' && process.env.I_UNDERSTAND_THIS_SPENDS_REAL_SOL === 'true';

const RPC_URL = process.env.RPC_URL ?? 'https://api.mainnet-beta.solana.com';
/** Montant minime : le but est de valider la chaine, pas de trader. */
const BUY_SOL = Number(process.env.ROUNDTRIP_BUY_SOL ?? '0.01');
const SLIPPAGE_BPS = Number(process.env.SLIPPAGE_BPS ?? '500');

const EXIT_CFG: ExitConfig = {
  stopLossPct: 40,
  trailingStopPct: 25,
  trailingArmsAtMultiple: 2,
  volumeDryUpMs: 30_000,
  maxHoldMs: 900_000,
  slippageBps: SLIPPAGE_BPS,
  computeUnitLimit: 220_000,
  computeUnitPriceMicroLamports: 120_000,
};

const META = {
  name: 'Roundtrip Probe',
  symbol: 'RTPROBE',
  uri: 'https://gateway.irys.xyz/1RVCLbcy4FEgTJ8Wnfo1BjZqoUWmCFTraqLNYMyXktA',
};

const sol = (lamports: bigint | number) => Number(lamports) / LAMPORTS_PER_SOL;

/**
 * Applique un achat a un etat de courbe, pour obtenir l'etat post-buy sans
 * avoir a le lire on-chain. Sert uniquement au mode simulation.
 */
function curveAfterBuy(global: PumpGlobal, solIn: bigint, tokensOut: bigint, creator: PublicKey): BondingCurveState {
  return {
    virtualSolReserves: global.initialVirtualSolReserves + solIn,
    virtualTokenReserves: global.initialVirtualTokenReserves - tokensOut,
    realSolReserves: solIn,
    realTokenReserves: global.initialRealTokenReserves - tokensOut,
    tokenTotalSupply: global.tokenTotalSupply,
    complete: false,
    creator,
  };
}

/**
 * Snapshot synthetique a un multiple donne du prix d'entree.
 *
 * La courbe est REBATIE pour que son prix reel soit le prix cible, au lieu de
 * simplement annoncer un prix a cote d'une courbe figee. Sans cela, toutes les
 * cotations de vente retomberaient sur l'etat post-buy et rapporteraient le
 * meme SOL a 2x qu'a 4x - une simulation qui afficherait une perte apres un
 * 4x, et sur laquelle on calibrerait ses paliers de travers.
 *
 * price = vSol / vTok, donc a reserve de tokens constante :
 *   vSol' = prixCible * vTok
 */
function syntheticSnapshot(
  base: BondingCurveState,
  position: Position,
  multiple: number,
  at: number,
  lastChangeAt: number,
): CurveSnapshot {
  const targetPrice = position.entryPrice * multiple;
  const curve: BondingCurveState = {
    ...base,
    virtualSolReserves: BigInt(Math.round(targetPrice * Number(base.virtualTokenReserves))),
  };
  return {
    curve,
    price: curvePrice(curve),
    marketCapLamports: curvePrice(curve) * Number(curve.tokenTotalSupply),
    at,
    lastChangeAt,
    source: 'poll',
  };
}

async function main(): Promise<void> {
  if (EXECUTE) {
    log.warn(
      { buySol: BUY_SOL },
      'EXECUTE MODE: this will deploy a real token on mainnet and spend real SOL',
    );
  } else {
    log.info('SIMULATION MODE: nothing is broadcast. Set EXECUTE=true + ' +
      'I_UNDERSTAND_THIS_SPENDS_REAL_SOL=true to run for real.');
  }

  const connection = new Connection(RPC_URL, 'confirmed');
  const global = await fetchGlobal(connection).catch((err) => {
    log.warn({ err }, 'global unreadable, falling back to offline defaults');
    return {
      initialized: true,
      authority: PublicKey.default,
      feeRecipient: Keypair.generate().publicKey,
      ...DEFAULT_GLOBAL_PARAMS,
    } satisfies PumpGlobal;
  });
  log.info(
    { feeRecipient: global.feeRecipient.toBase58(), feeBps: global.feeBasisPoints.toString() },
    'pump global parameters',
  );

  // --- payeur --------------------------------------------------------------
  let payer: Keypair;
  if (EXECUTE) {
    const secret = process.env.DEPLOYER_PRIVATE_KEY;
    if (!secret) throw new Error('EXECUTE mode requires DEPLOYER_PRIVATE_KEY');
    payer = Keypair.fromSecretKey(bs58.decode(secret.trim()));
    const balance = await connection.getBalance(payer.publicKey, 'confirmed');
    log.warn({ payer: payer.publicKey.toBase58(), balanceSol: balance / LAMPORTS_PER_SOL }, 'deployer');
    if (balance < (BUY_SOL + 0.05) * LAMPORTS_PER_SOL) {
      throw new Error(`deployer balance too low: need at least ${BUY_SOL + 0.05} SOL for buy + rent + fees`);
    }
  } else {
    payer = Keypair.generate();
  }

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
      dryRun: !EXECUTE,
    },
    connection,
    log,
  );
  await bundler.init();

  // =========================================================================
  // 1. Pool
  // =========================================================================
  const pool = new KeypairPool({ targetSize: 10 }, log);
  await pool.start();
  const mintKp = pool.acquire();
  log.info({ mint: mintKp.publicKey.toBase58(), poolRemaining: pool.size }, '1/5 mint acquired');

  // =========================================================================
  // 2. Create + initial buy
  // =========================================================================
  const { blockhash } = await connection.getLatestBlockhash('confirmed');
  const built = buildCreateAndBuyTx({
    payer,
    mint: mintKp,
    metadata: META,
    solBudgetLamports: BigInt(Math.round(BUY_SOL * LAMPORTS_PER_SOL)),
    slippageBps: SLIPPAGE_BPS,
    global,
    recentBlockhash: blockhash,
    computeUnitLimit: 350_000,
    computeUnitPriceMicroLamports: 150_000,
    tipInstruction: bundler.buildTipInstruction(payer.publicKey),
  });
  log.info(
    {
      sizeBytes: built.size,
      headroom: MAX_TX_BYTES - built.size,
      budgetSol: BUY_SOL,
      tokensRequested: (Number(built.quote.amount) / 1e6).toLocaleString('en-US'),
      maxSolCost: sol(built.quote.maxSolCost),
      tipSol: sol(bundler.tipLamports),
    },
    '2/5 create+buy transaction built',
  );

  let position: Position;
  let liveCurve: BondingCurveState;
  /** Dernier etat de courbe observe : sert de base de cotation pour la vente. */
  let lastSnapshot: CurveSnapshot | undefined;

  if (EXECUTE) {
    const submission = await bundler.submitSignedTransactions([built.tx]);
    const outcome = await bundler.waitForLanded(submission.bundleId);
    log.info({ bundleId: submission.bundleId, outcome }, 'deploy bundle result');
    if (outcome.status !== 'landed') {
      throw new Error(`deploy bundle did not land (${outcome.status}) - aborting before the sell leg`);
    }

    // Reconciliation : on ne suppose jamais ce qu'on a recu.
    const ata = getAssociatedTokenAddressSync(mintKp.publicKey, payer.publicKey, false);
    const balance = await connection.getTokenAccountBalance(ata, 'confirmed');
    const tokensReceived = BigInt(balance.value.amount);
    liveCurve = await fetchBondingCurve(connection, mintKp.publicKey);
    position = new Position({
      mint: mintKp.publicKey,
      creator: liveCurve.creator,
      entrySolLamports: built.quote.maxSolCost,
      tokensBought: tokensReceived,
      deployedAt: Date.now(),
      tiers: parseTiers('2,3,5', '33,33,34'),
    });
    log.info(
      { tokensReceived: tokensReceived.toString(), entryPrice: position.entryPrice },
      'position opened (reconciled on-chain)',
    );
  } else {
    const sim = await connection.simulateTransaction(built.tx, {
      sigVerify: false,
      replaceRecentBlockhash: true,
    });
    log.info(
      { err: sim.value.err, unitsConsumed: sim.value.unitsConsumed },
      'create+buy simulated (a transaction-level error here is expected with a throwaway payer)',
    );
    liveCurve = curveAfterBuy(global, built.quote.solIntoCurve, built.quote.amount, payer.publicKey);
    position = new Position({
      mint: mintKp.publicKey,
      creator: payer.publicKey,
      entrySolLamports: built.quote.maxSolCost,
      tokensBought: built.quote.amount,
      deployedAt: Date.now(),
      tiers: parseTiers('2,3,5', '33,33,34'),
    });
    log.info(
      { entryPrice: position.entryPrice, postBuyCurvePrice: curvePrice(liveCurve) },
      'synthetic position opened',
    );
  }

  // =========================================================================
  // 3. Monitoring
  // =========================================================================
  if (EXECUTE) {
    const monitor = new CurveMonitor(connection, mintKp.publicKey, { pollIntervalMs: 400 }, log);
    let ticks = 0;
    await monitor.start((snap) => {
      ticks++;
      const m = position.updatePeak(snap.price);
      if (ticks % 5 === 0) {
        log.info(
          { multiple: m.toFixed(4), mcapSol: sol(snap.marketCapLamports), source: snap.source },
          'tick',
        );
      }
    });
    // Fenetre courte : ce script valide la mecanique, il ne gere pas la position.
    await new Promise((r) => setTimeout(r, 5_000));
    await monitor.stop();
    log.info({ ticks, peakMultiple: position.peakMultiple }, '3/5 monitoring window closed');
  } else {
    // Trajectoire synthetique : elle exerce reellement decideExit, palier par
    // palier, puis le trailing stop. C'est le coeur de ce que ce script valide.
    const path = [1.0, 1.4, 2.1, 2.8, 4.2, 3.9, 3.0];
    const t0 = position.deployedAt;
    path.forEach((multiple, i) => {
      const at = t0 + (i + 1) * 1000;
      const snap = syntheticSnapshot(liveCurve, position, multiple, at, at);
      lastSnapshot = snap;
      position.updatePeak(snap.price);
      const decision = decideExit(position, snap, EXIT_CFG, at);
      if (decision) {
        // Cotation contre la courbe DU MOMENT, pas contre l'etat post-buy.
        const q = quoteExactInputSell(
          decision.tokensToSell,
          snap.curve,
          SLIPPAGE_BPS,
          global.feeBasisPoints,
        );
        log.info(
          {
            multiple,
            reason: decision.reason,
            tokens: (Number(decision.tokensToSell) / 1e6).toLocaleString('en-US'),
            expectedSol: sol(q.netSolOut),
            detail: decision.detail,
          },
          'exit decision',
        );
        // Comptabilise comme si la vente avait ete executee, pour que la suite
        // de la trajectoire parte d'un etat coherent.
        position.recordFill(decision.tokensToSell, q.netSolOut);
        position.markTiersHit(decision.tierIndexes);
      } else {
        log.debug({ multiple }, 'no exit');
      }
    });
    log.info(
      {
        peakMultiple: position.peakMultiple.toFixed(3),
        tiersHit: position.tiersHit,
        remaining: (Number(position.tokensRemaining) / 1e6).toLocaleString('en-US'),
        recoveredSol: sol(position.solRecovered),
        realizedPnlSol: sol(position.realizedPnlLamports),
        deRisked: position.isDeRisked,
      },
      '3/5 simulated monitoring complete',
    );
  }

  // =========================================================================
  // 4. Vente du reliquat
  // =========================================================================
  if (position.tokensRemaining > 0n) {
    if (EXECUTE) {
      const executor = new ExitExecutor(connection, bundler, payer, global, EXIT_CFG, log);
      const snap = await new CurveMonitor(
        connection,
        mintKp.publicKey,
        { pollIntervalMs: 400 },
        log,
      ).pollOnce();
      const result = await executor.execute(position, snap, {
        reason: 'max-hold',
        tokensToSell: position.tokensRemaining,
        tierIndexes: [],
        detail: 'roundtrip script: liquidating the whole position',
      });
      log.info(
        {
          status: result.status,
          tokensSold: result.tokensSold.toString(),
          solReceived: sol(result.solReceived),
          bundleId: result.bundleId,
        },
        '4/5 sell executed',
      );
    } else {
      const { blockhash: sellBlockhash } = await connection.getLatestBlockhash('confirmed');
      const sellTx = buildSellTx({
        payer,
        mint: mintKp.publicKey,
        creator: position.creator,
        amount: position.tokensRemaining,
        curve: lastSnapshot?.curve ?? liveCurve,
        slippageBps: SLIPPAGE_BPS,
        feeRecipient: global.feeRecipient,
        feeBasisPoints: global.feeBasisPoints,
        recentBlockhash: sellBlockhash,
        computeUnitLimit: EXIT_CFG.computeUnitLimit,
        computeUnitPriceMicroLamports: EXIT_CFG.computeUnitPriceMicroLamports,
        tipInstruction: bundler.buildTipInstruction(payer.publicKey),
      });
      const sim = await connection.simulateTransaction(sellTx.tx, {
        sigVerify: false,
        replaceRecentBlockhash: true,
      });
      log.info(
        {
          sizeBytes: sellTx.size,
          headroom: MAX_TX_BYTES - sellTx.size,
          tokens: (Number(position.tokensRemaining) / 1e6).toLocaleString('en-US'),
          grossSol: sol(sellTx.quote.grossSolOut),
          feeSol: sol(sellTx.quote.feeLamports),
          netSol: sol(sellTx.quote.netSolOut),
          minSolOutput: sol(sellTx.quote.minSolOutput),
          simErr: sim.value.err,
        },
        '4/5 sell transaction built and simulated',
      );
      // Le bundler est en dry-run : ceci exerce le chemin de soumission sans
      // rien envoyer.
      const submission = await bundler.submitSignedTransactions([sellTx.tx]);
      log.info({ bundleId: submission.bundleId }, 'sell bundle dry-run assembled');
      position.recordFill(position.tokensRemaining, sellTx.quote.netSolOut);
    }
  }

  // =========================================================================
  // 5. Creator fees
  // =========================================================================
  const vault = await creatorVaultBalance(connection, payer);
  if (EXECUTE) {
    const claim = await claimCreatorFees(connection, payer, log);
    log.info({ claim }, '5/5 creator fee claim');
  } else {
    log.info(
      {
        creatorVaultSol: sol(vault),
        thresholdSol: sol(DEFAULT_FEE_CLAIM_CONFIG.minClaimLamports),
        wouldClaim: vault >= DEFAULT_FEE_CLAIM_CONFIG.minClaimLamports,
      },
      '5/5 creator vault checked (no claim sent)',
    );
  }

  // =========================================================================
  // Bilan
  // =========================================================================
  log.info(
    {
      mode: EXECUTE ? 'EXECUTE' : 'SIMULATION',
      ...position.snapshot(),
      recoveredSol: sol(position.solRecovered),
      spentSol: sol(position.entrySolLamports),
      realizedPnlSol: sol(position.realizedPnlLamports),
    },
    'ROUNDTRIP COMPLETE',
  );

  pool.dispose(mintKp);
  pool.stop();
  bundler.close();
}

main().catch((err) => {
  log.error({ err }, 'roundtrip failed');
  process.exitCode = 1;
});
