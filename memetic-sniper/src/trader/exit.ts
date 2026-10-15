/**
 * src/trader/exit.ts
 * ---------------------------------------------------------------------------
 * Decision de sortie (pure) et execution de la vente (via bundle Jito).
 *
 * La decision est separee de l'execution pour une raison precise : la logique
 * de sortie est ce qui determine le resultat financier, et on ne teste
 * correctement que ce qui est pur. `decideExit` ne touche ni au reseau ni a
 * l'horloge - `now` est un parametre. Tous les scenarios (krach, pump,
 * assechement, trailing) se testent en memoire, en quelques microsecondes.
 *
 * VENTE = BUNDLE JITO. Une vente diffusee dans le mempool public est la proie
 * ideale d'un sandwich : l'attaquant vend devant vous, vous encaissez un prix
 * degrade, il rachete derriere. Le bundle rend la transaction invisible
 * jusqu'a son inclusion.
 * ---------------------------------------------------------------------------
 */

import { getAssociatedTokenAddressSync } from '@solana/spl-token';
import type { Connection, Keypair } from '@solana/web3.js';
import type { Logger } from 'pino';

import type { JitoBundler } from '../solana/jitoBundle.ts';
import {
  type PumpGlobal,
  buildSellTx,
  fetchBondingCurve,
} from '../solana/pumpfun.ts';
import type { CurveSnapshot } from './monitor.ts';
import type { Position } from './position.ts';

export type ExitReason =
  | 'take-profit'
  | 'stop-loss'
  | 'trailing-stop'
  | 'volume-dry-up'
  | 'max-hold'
  | 'curve-complete';

export interface ExitDecision {
  reason: ExitReason;
  /** Tokens a vendre, unites de base. 0n = sortie impossible, arreter le suivi. */
  tokensToSell: bigint;
  /** Paliers de TP consommes par cette decision. */
  tierIndexes: number[];
  /** Ligne lisible pour les logs et le post-mortem. */
  detail: string;
}

export interface ExitConfig {
  /** Sortie totale si le multiple tombe sous (1 - stopLossPct/100). */
  stopLossPct: number;
  /** Sortie totale si le prix retombe de trailingStopPct % sous le sommet. */
  trailingStopPct: number;
  /**
   * Le trailing ne s'arme qu'au-dessus de ce multiple.
   * Sans cet armement, le bruit des premieres secondes declencherait le
   * trailing avant meme que la position ait pris de la valeur.
   */
  trailingArmsAtMultiple: number;
  /** Sortie totale si les reserves n'ont pas bouge depuis ce delai. */
  volumeDryUpMs: number;
  /** Sortie totale au-dela de cette duree de detention. */
  maxHoldMs: number;
  slippageBps: number;
  computeUnitLimit: number;
  computeUnitPriceMicroLamports: number;
}

// ---------------------------------------------------------------------------
// Decision — pure
// ---------------------------------------------------------------------------

/**
 * Determine s'il faut vendre, et combien.
 *
 * ORDRE DES TESTS, et pourquoi il compte :
 *   1. curve-complete  : la courbe a migre, `sell` n'est plus jouable dessus.
 *                        Inutile de decider quoi que ce soit d'autre.
 *   2. stop-loss       : protection du capital avant tout le reste.
 *   3. trailing-stop   : protege un gain deja acquis.
 *   4. volume-dry-up   : plus personne n'echange - le prix affiche n'est plus
 *                        realisable, mieux vaut sortir tant qu'il y a une
 *                        contrepartie.
 *   5. max-hold        : garde-fou temporel.
 *   6. take-profit     : en dernier, car c'est le seul cas non urgent.
 *
 * Les paliers de TP sont groupes : si le prix saute de 1x a 6x entre deux
 * ticks, tous les paliers franchis declenchent en une seule vente. Les traiter
 * un par un ferait vendre le deuxieme palier a un prix deja redescendu.
 */
export function decideExit(
  position: Position,
  snapshot: CurveSnapshot,
  cfg: ExitConfig,
  now = Date.now(),
): ExitDecision | null {
  if (position.closed || position.tokensRemaining === 0n) return null;

  if (snapshot.curve.complete) {
    return {
      reason: 'curve-complete',
      tokensToSell: 0n,
      tierIndexes: [],
      detail:
        'bonding curve is complete: the token migrated to the AMM and pump `sell` no longer ' +
        'applies. Position must be exited on the AMM - not implemented here.',
    };
  }

  const multiple = position.multipleAt(snapshot.price);
  const all = position.tokensRemaining;

  const stopLossMultiple = 1 - cfg.stopLossPct / 100;
  if (multiple <= stopLossMultiple) {
    return {
      reason: 'stop-loss',
      tokensToSell: all,
      tierIndexes: [],
      detail: `multiple ${multiple.toFixed(3)} <= stop-loss ${stopLossMultiple.toFixed(3)}`,
    };
  }

  if (position.peakMultiple >= cfg.trailingArmsAtMultiple) {
    const trailFloor = position.peakMultiple * (1 - cfg.trailingStopPct / 100);
    if (multiple <= trailFloor) {
      return {
        reason: 'trailing-stop',
        tokensToSell: all,
        tierIndexes: [],
        detail: `multiple ${multiple.toFixed(3)} <= ${trailFloor.toFixed(3)} (peak ${position.peakMultiple.toFixed(3)} minus ${cfg.trailingStopPct}%)`,
      };
    }
  }

  const stillMs = now - snapshot.lastChangeAt;
  if (stillMs >= cfg.volumeDryUpMs) {
    return {
      reason: 'volume-dry-up',
      tokensToSell: all,
      tierIndexes: [],
      detail: `reserves unchanged for ${stillMs}ms (threshold ${cfg.volumeDryUpMs}ms)`,
    };
  }

  const age = position.ageMs(now);
  if (age >= cfg.maxHoldMs) {
    return {
      reason: 'max-hold',
      tokensToSell: all,
      tierIndexes: [],
      detail: `held for ${age}ms (max ${cfg.maxHoldMs}ms)`,
    };
  }

  // Paliers de TP franchis et pas encore consommes.
  const tierIndexes: number[] = [];
  let pct = 0;
  position.tiers.forEach((tier, i) => {
    if (!position.tiersHit[i] && multiple >= tier.multiplier) {
      tierIndexes.push(i);
      pct += tier.sellPct;
    }
  });
  if (tierIndexes.length > 0) {
    const tokensToSell = position.tokensForPct(pct);
    if (tokensToSell > 0n) {
      return {
        reason: 'take-profit',
        tokensToSell,
        tierIndexes,
        detail: `multiple ${multiple.toFixed(3)} cleared tier(s) ${tierIndexes.join(',')} -> selling ${pct}% of the initial position`,
      };
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

export interface ExitResult {
  status: 'sold' | 'skipped' | 'failed';
  reason: ExitReason;
  /** Tokens reellement vendus, reconcilies on-chain. */
  tokensSold: bigint;
  /** SOL encaisse, mesure par la variation de solde. */
  solReceived: bigint;
  bundleId?: string;
  detail: string;
}

export class ExitExecutor {
  private readonly connection: Connection;
  private readonly bundler: JitoBundler;
  private readonly payer: Keypair;
  private readonly global: PumpGlobal;
  private readonly cfg: ExitConfig;
  private readonly log: Logger;

  constructor(
    connection: Connection,
    bundler: JitoBundler,
    payer: Keypair,
    global: PumpGlobal,
    cfg: ExitConfig,
    logger: Logger,
  ) {
    this.connection = connection;
    this.bundler = bundler;
    this.payer = payer;
    this.global = global;
    this.cfg = cfg;
    this.log = logger.child({ module: 'exit' });
  }

  /**
   * Execute une decision de sortie.
   *
   * Reconciliation obligatoire : le solde de tokens et le solde SOL sont
   * mesures AVANT et APRES, et c'est la difference qui est enregistree dans la
   * position - jamais l'intention. Un bundle peut atterrir apres notre timeout,
   * ou echouer apres avoir ete accepte ; se fier a l'intention ferait diverger
   * l'etat local de la realite on-chain, et la divergence se paierait au
   * prochain ordre de vente.
   */
  async execute(
    position: Position,
    snapshot: CurveSnapshot,
    decision: ExitDecision,
  ): Promise<ExitResult> {
    const log = this.log.child({ mint: position.mint.toBase58(), reason: decision.reason });

    if (decision.tokensToSell === 0n) {
      log.warn({ detail: decision.detail }, 'exit decision is not actionable');
      return {
        status: 'skipped',
        reason: decision.reason,
        tokensSold: 0n,
        solReceived: 0n,
        detail: decision.detail,
      };
    }
    if (position.selling) {
      return {
        status: 'skipped',
        reason: decision.reason,
        tokensSold: 0n,
        solReceived: 0n,
        detail: 'a sell is already in flight for this position',
      };
    }

    position.selling = true;
    try {
      const ata = getAssociatedTokenAddressSync(position.mint, this.payer.publicKey, false);

      // Etat frais + soldes de reference, en parallele : le snapshot qui a
      // declenche la decision peut avoir plusieurs centaines de ms.
      const [curve, tokensBefore, solBefore, { blockhash }] = await Promise.all([
        fetchBondingCurve(this.connection, position.mint),
        this.tokenBalance(ata),
        this.solBalance(),
        this.connection.getLatestBlockhash('confirmed'),
      ]);

      if (curve.complete) {
        return {
          status: 'skipped',
          reason: decision.reason,
          tokensSold: 0n,
          solReceived: 0n,
          detail: 'curve completed between decision and execution',
        };
      }

      // On ne vend jamais plus que ce que la chaine dit qu'on detient.
      const amount = decision.tokensToSell < tokensBefore ? decision.tokensToSell : tokensBefore;
      if (amount === 0n) {
        return {
          status: 'skipped',
          reason: decision.reason,
          tokensSold: 0n,
          solReceived: 0n,
          detail: 'on-chain token balance is zero - position already exited',
        };
      }

      const { tx, quote, size } = buildSellTx({
        payer: this.payer,
        mint: position.mint,
        creator: curve.creator,
        amount,
        curve,
        slippageBps: this.cfg.slippageBps,
        feeRecipient: this.global.feeRecipient,
        feeBasisPoints: this.global.feeBasisPoints,
        recentBlockhash: blockhash,
        computeUnitLimit: this.cfg.computeUnitLimit,
        computeUnitPriceMicroLamports: this.cfg.computeUnitPriceMicroLamports,
        tipInstruction: this.bundler.buildTipInstruction(this.payer.publicKey),
      });

      log.info(
        {
          amount: amount.toString(),
          expectedSol: Number(quote.netSolOut) / 1e9,
          minSolOutput: Number(quote.minSolOutput) / 1e9,
          multiple: position.multipleAt(snapshot.price).toFixed(3),
          sizeBytes: size,
          detail: decision.detail,
        },
        'submitting sell bundle',
      );

      const submission = await this.bundler.submitSignedTransactions([tx]);
      const outcome = await this.bundler.waitForLanded(submission.bundleId);

      // Reconciliation, quel que soit le verdict du bundle : un timeout n'est
      // pas une preuve de non-execution.
      const [tokensAfter, solAfter] = await Promise.all([
        this.tokenBalance(ata),
        this.solBalance(),
      ]);
      const tokensSold = tokensBefore > tokensAfter ? tokensBefore - tokensAfter : 0n;
      const solReceived = solAfter > solBefore ? solAfter - solBefore : 0n;

      if (tokensSold > 0n) {
        position.recordFill(tokensSold, solReceived);
        if (decision.tierIndexes.length > 0) position.markTiersHit(decision.tierIndexes);
        log.info(
          {
            bundleId: submission.bundleId,
            outcome: outcome.status,
            tokensSold: tokensSold.toString(),
            solReceived: Number(solReceived) / 1e9,
            remaining: position.tokensRemaining.toString(),
            realizedPnlSol: Number(position.realizedPnlLamports) / 1e9,
          },
          'sell reconciled',
        );
        return {
          status: 'sold',
          reason: decision.reason,
          tokensSold,
          solReceived,
          bundleId: submission.bundleId,
          detail: decision.detail,
        };
      }

      log.error(
        { bundleId: submission.bundleId, outcome },
        'sell did not execute - token balance unchanged',
      );
      return {
        status: 'failed',
        reason: decision.reason,
        tokensSold: 0n,
        solReceived: 0n,
        bundleId: submission.bundleId,
        detail: `bundle ${outcome.status}, on-chain balance unchanged`,
      };
    } finally {
      position.selling = false;
    }
  }

  private async solBalance(): Promise<bigint> {
    return BigInt(await this.connection.getBalance(this.payer.publicKey, 'confirmed'));
  }

  /** Solde de l'ATA. Un compte absent vaut 0, pas une erreur. */
  private async tokenBalance(ata: import('@solana/web3.js').PublicKey): Promise<bigint> {
    const info = await this.connection.getTokenAccountBalance(ata, 'confirmed').catch(() => null);
    return info ? BigInt(info.value.amount) : 0n;
  }
}
