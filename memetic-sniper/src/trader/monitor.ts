/**
 * src/trader/monitor.ts
 * ---------------------------------------------------------------------------
 * Surveillance de la bonding curve apres lancement.
 *
 * STRATEGIE : websocket en primaire, polling en filet.
 *
 * `onAccountChange` est pousse par le validateur : la mise a jour arrive des
 * que le compte change, sans aller-retour. C'est strictement meilleur qu'un
 * polling a 400 ms, qui ajoute en moyenne 200 ms de retard et brule du quota
 * RPC quand rien ne bouge.
 *
 * Mais une souscription websocket peut mourir en silence : la socket reste
 * ouverte, le serveur ne pousse plus, et on ne le remarque jamais. Sur une
 * position ouverte, "ne plus recevoir de prix" et "le prix ne bouge plus" se
 * ressemblent, et l'un des deux vide le portefeuille. D'ou le filet : si rien
 * n'est arrive depuis `pollIntervalMs`, on va chercher l'etat activement.
 * Le cout est nul quand le websocket fonctionne, et la latence est bornee par
 * `pollIntervalMs` quand il ne fonctionne plus.
 * ---------------------------------------------------------------------------
 */

import type { Connection, PublicKey } from '@solana/web3.js';
import type { Logger } from 'pino';

import {
  type BondingCurveState,
  curveMarketCapLamports,
  curvePrice,
  decodeBondingCurve,
  deriveBondingCurve,
  fetchBondingCurve,
} from '../solana/pumpfun.ts';

export interface CurveSnapshot {
  curve: BondingCurveState;
  /** Lamports par unite de base de token. */
  price: number;
  marketCapLamports: number;
  /** Epoch ms de reception. */
  at: number;
  /** Epoch ms du dernier changement REEL des reserves (detection d'assechement). */
  lastChangeAt: number;
  source: 'ws' | 'poll';
}

export interface MonitorConfig {
  /** Intervalle du filet de polling. 300-400 ms en pratique. */
  pollIntervalMs: number;
  /** Nombre d'erreurs consecutives tolerees avant d'alerter. */
  maxConsecutiveErrors?: number;
}

export type CurveListener = (snapshot: CurveSnapshot) => void;

export class CurveMonitor {
  private readonly connection: Connection;
  private readonly mint: PublicKey;
  private readonly curvePda: PublicKey;
  private readonly cfg: Required<MonitorConfig>;
  private readonly log: Logger;

  private listener: CurveListener | undefined;
  private subscriptionId: number | undefined;
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private polling = false;

  private lastAt = 0;
  private lastChangeAt = 0;
  private lastReserves: string | undefined;
  private consecutiveErrors = 0;
  private wsUpdates = 0;
  private pollUpdates = 0;

  constructor(connection: Connection, mint: PublicKey, cfg: MonitorConfig, logger: Logger) {
    if (!(cfg.pollIntervalMs > 0)) throw new Error('CurveMonitor: pollIntervalMs must be > 0');
    this.connection = connection;
    this.mint = mint;
    this.curvePda = deriveBondingCurve(mint);
    this.cfg = { maxConsecutiveErrors: 5, ...cfg };
    this.log = logger.child({ module: 'monitor', mint: mint.toBase58() });
  }

  get stats() {
    return {
      wsUpdates: this.wsUpdates,
      pollUpdates: this.pollUpdates,
      lastAt: this.lastAt,
      lastChangeAt: this.lastChangeAt,
      consecutiveErrors: this.consecutiveErrors,
    };
  }

  /**
   * Demarre la surveillance. Emet un premier snapshot synchrone (via polling)
   * pour que l'appelant dispose d'un prix des le retour, sans attendre un
   * premier push.
   */
  async start(listener: CurveListener): Promise<CurveSnapshot> {
    if (this.running) throw new Error('CurveMonitor: already running');
    this.running = true;
    this.listener = listener;

    // Etat initial : indispensable pour amorcer `lastChangeAt` et le sommet.
    const initial = await this.pollOnce();

    // `processed` : on veut le prix le plus frais possible, quitte a ce qu'il
    // soit parfois reorganise. Une decision de sortie sur un prix vieux de
    // deux slots vaut moins qu'une decision sur un prix legerement incertain.
    this.subscriptionId = this.connection.onAccountChange(
      this.curvePda,
      (accountInfo, context) => {
        try {
          const curve = decodeBondingCurve(accountInfo.data as Buffer);
          this.emit(curve, 'ws');
        } catch (err) {
          this.log.error({ err, slot: context.slot }, 'failed to decode pushed curve account');
        }
      },
      'processed',
    );

    this.timer = setInterval(() => {
      // Filet : ne declenche que si le websocket n'a rien livre a temps.
      if (Date.now() - this.lastAt >= this.cfg.pollIntervalMs) {
        void this.pollOnce().catch(() => undefined);
      }
    }, this.cfg.pollIntervalMs);
    this.timer.unref();

    this.log.info({ curve: this.curvePda.toBase58() }, 'monitor started');
    return initial;
  }

  async stop(): Promise<void> {
    this.running = false;
    this.listener = undefined;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    if (this.subscriptionId !== undefined) {
      try {
        await this.connection.removeAccountChangeListener(this.subscriptionId);
      } catch (err) {
        // Souscription deja morte : rien a nettoyer, mais on le trace.
        this.log.warn({ err }, 'failed to remove account listener');
      }
      this.subscriptionId = undefined;
    }
    this.log.info(this.stats, 'monitor stopped');
  }

  /** Lecture active immediate. Utilisee au demarrage et par le filet. */
  async pollOnce(): Promise<CurveSnapshot> {
    if (this.polling) {
      // Un poll est deja en vol : empiler n'accelererait rien et doublerait
      // la consommation de quota RPC.
      throw new Error('CurveMonitor: poll already in flight');
    }
    this.polling = true;
    try {
      const curve = await fetchBondingCurve(this.connection, this.mint);
      this.consecutiveErrors = 0;
      return this.emit(curve, 'poll');
    } catch (err) {
      this.consecutiveErrors++;
      if (this.consecutiveErrors >= this.cfg.maxConsecutiveErrors) {
        this.log.error(
          { err, consecutiveErrors: this.consecutiveErrors },
          'curve is unreachable - exit decisions are running blind',
        );
      } else {
        this.log.warn({ err, consecutiveErrors: this.consecutiveErrors }, 'curve poll failed');
      }
      throw err;
    } finally {
      this.polling = false;
    }
  }

  private emit(curve: BondingCurveState, source: 'ws' | 'poll'): CurveSnapshot {
    const at = Date.now();
    // Signature des reserves : distingue "le prix n'a pas bouge" de "je ne
    // recois plus rien". C'est la base de la detection d'assechement.
    const signature = `${curve.virtualSolReserves}:${curve.virtualTokenReserves}`;
    if (signature !== this.lastReserves) {
      this.lastReserves = signature;
      this.lastChangeAt = at;
    }
    this.lastAt = at;
    if (source === 'ws') this.wsUpdates++;
    else this.pollUpdates++;

    const snapshot: CurveSnapshot = {
      curve,
      price: curvePrice(curve),
      marketCapLamports: curveMarketCapLamports(curve),
      at,
      lastChangeAt: this.lastChangeAt,
      source,
    };
    this.listener?.(snapshot);
    return snapshot;
  }
}
