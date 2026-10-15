/**
 * src/core/guards.ts
 * ---------------------------------------------------------------------------
 * Barrieres de securite financiere. Dernier point de controle avant depense.
 *
 * TROIS REGLES, evaluees a chaque deploiement :
 *   1. Plafond de depense glissant sur 24 h.
 *   2. Plafond de lancements sur 1 h.
 *   3. Solde minimum sur le wallet de deploiement.
 *
 * Les compteurs vivent dans le Store (Redis en production), PAS en memoire :
 * un plafond qui se remet a zero a chaque redemarrage ne plafonne rien, et un
 * bot qui crashe en boucle est precisement le scenario ou il depense le plus.
 *
 * VERROU D'ARRET : `halted` est un interrupteur a sens unique. Une fois le
 * solde passe sous le seuil, le bot ne redemarre pas tout seul parce qu'une
 * vente a temporairement renfloue le compte - c'est a un humain de constater
 * le probleme et de relancer.
 * ---------------------------------------------------------------------------
 */

import { LAMPORTS_PER_SOL } from '@solana/web3.js';
import type { Connection, PublicKey } from '@solana/web3.js';
import type { Logger } from 'pino';

import type { GuardConfig } from './config.ts';
import type { Store } from './store.ts';

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

const SPEND_KEY = 'guards:spend';
const DEPLOY_KEY = 'guards:deploys';

export type GuardVerdict =
  | { allowed: true }
  | { allowed: false; rule: 'daily-spend' | 'hourly-deploys' | 'min-balance' | 'halted'; detail: string };

export interface GuardStatus {
  halted: boolean;
  haltReason?: string;
  spentLast24hLamports: number;
  deploysLastHour: number;
  balanceLamports: number;
}

export class Guards {
  private readonly store: Store;
  private readonly connection: Connection;
  private readonly deployer: PublicKey;
  private readonly cfg: GuardConfig;
  private readonly log: Logger;

  private halted = false;
  private haltReason: string | undefined;

  constructor(
    store: Store,
    connection: Connection,
    deployer: PublicKey,
    cfg: GuardConfig,
    logger: Logger,
  ) {
    this.store = store;
    this.connection = connection;
    this.deployer = deployer;
    this.cfg = cfg;
    this.log = logger.child({ module: 'guards' });
  }

  get isHalted(): boolean {
    return this.halted;
  }

  /**
   * Arrete definitivement les deploiements pour cette execution.
   * Sans effet si deja arrete : la premiere raison est la bonne, les suivantes
   * ne sont que des consequences.
   */
  halt(reason: string): void {
    if (this.halted) return;
    this.halted = true;
    this.haltReason = reason;
    this.log.error({ reason }, 'GUARDS HALTED - no further deploys this run');
  }

  /**
   * Autorise ou refuse un deploiement de `costLamports`.
   *
   * Les trois lectures sont independantes -> en parallele. Sur le chemin
   * critique, les enchainer ajouterait deux allers-retours reseau entre le
   * signal et le bundle.
   */
  async canDeploy(costLamports: bigint): Promise<GuardVerdict> {
    if (this.halted) {
      return { allowed: false, rule: 'halted', detail: this.haltReason ?? 'halted' };
    }

    const now = Date.now();
    const [spend, deploys, balance] = await Promise.all([
      this.store.windowStats(SPEND_KEY, now - DAY_MS),
      this.store.windowStats(DEPLOY_KEY, now - HOUR_MS),
      this.connection.getBalance(this.deployer, 'confirmed'),
    ]);

    // Le solde minimum doit couvrir le rent et les frais APRES l'achat :
    // on teste le solde projete, pas le solde courant.
    const projected = BigInt(balance) - costLamports;
    if (projected < this.cfg.minDeployerBalanceLamports) {
      const detail =
        `balance ${(balance / LAMPORTS_PER_SOL).toFixed(4)} SOL minus a ` +
        `${(Number(costLamports) / LAMPORTS_PER_SOL).toFixed(4)} SOL buy would leave ` +
        `${(Number(projected) / LAMPORTS_PER_SOL).toFixed(4)} SOL, below the ` +
        `${(Number(this.cfg.minDeployerBalanceLamports) / LAMPORTS_PER_SOL).toFixed(4)} SOL floor`;
      // Un solde insuffisant n'est pas un incident passager : on arrete.
      this.halt(detail);
      return { allowed: false, rule: 'min-balance', detail };
    }

    const wouldSpend = BigInt(Math.round(spend.sum)) + costLamports;
    if (wouldSpend > this.cfg.maxDailySpendLamports) {
      return {
        allowed: false,
        rule: 'daily-spend',
        detail:
          `${(Number(wouldSpend) / LAMPORTS_PER_SOL).toFixed(4)} SOL would exceed the 24h cap of ` +
          `${(Number(this.cfg.maxDailySpendLamports) / LAMPORTS_PER_SOL).toFixed(4)} SOL ` +
          `(already spent ${(spend.sum / LAMPORTS_PER_SOL).toFixed(4)})`,
      };
    }

    if (deploys.count >= this.cfg.maxDeploysPerHour) {
      return {
        allowed: false,
        rule: 'hourly-deploys',
        detail: `${deploys.count} deploys in the last hour, cap is ${this.cfg.maxDeploysPerHour}`,
      };
    }

    return { allowed: true };
  }

  /**
   * Enregistre un deploiement effectif.
   *
   * A appeler APRES l'atterrissage du bundle, jamais avant : compter une
   * depense qui n'a pas eu lieu consommerait le quota pour rien. Le risque
   * inverse (deux deploiements simultanes qui passent tous deux le controle)
   * est couvert ailleurs, par la file de deploiement a concurrence 1.
   */
  async recordDeploy(costLamports: bigint): Promise<void> {
    const now = Date.now();
    await Promise.all([
      this.store.addEvent(SPEND_KEY, now, Number(costLamports)),
      this.store.addEvent(DEPLOY_KEY, now, 1),
    ]);
    this.log.info({ costSol: Number(costLamports) / LAMPORTS_PER_SOL }, 'deploy recorded against caps');
  }

  async status(): Promise<GuardStatus> {
    const now = Date.now();
    const [spend, deploys, balance] = await Promise.all([
      this.store.windowStats(SPEND_KEY, now - DAY_MS),
      this.store.windowStats(DEPLOY_KEY, now - HOUR_MS),
      this.connection.getBalance(this.deployer, 'confirmed').catch(() => 0),
    ]);
    return {
      halted: this.halted,
      ...(this.haltReason ? { haltReason: this.haltReason } : {}),
      spentLast24hLamports: spend.sum,
      deploysLastHour: deploys.count,
      balanceLamports: balance,
    };
  }
}
