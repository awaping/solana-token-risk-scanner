/**
 * src/trader/position.ts
 * ---------------------------------------------------------------------------
 * Etat d'une position, en memoire.
 *
 * Volontairement passif : cette classe ne lit rien, n'envoie rien, ne decide
 * rien. Elle ne fait que tenir des compteurs et exposer des ratios. Toute la
 * logique de sortie vit dans `exit.ts`, sous forme de fonction pure - ce qui
 * la rend testable sans RPC ni horloge.
 *
 * PRIX D'ENTREE : c'est le prix EFFECTIF, `solDepense / tokensRecus`, pas le
 * prix de la courbe a l'instant du snipe. Il inclut donc les frais et le
 * slippage payes a l'entree. Consequence voulue : un multiple de 2.0 signifie
 * "j'ai vraiment double ma mise", pas "la courbe a double depuis mon entree".
 * Comparer un prix de courbe a un prix de courbe donnerait un multiple flatteur
 * qui declencherait les paliers de TP trop tot.
 * ---------------------------------------------------------------------------
 */

import type { PublicKey } from '@solana/web3.js';

/**
 * Reliquat considere comme non vendable : 1000 unites de base = 0.001 token.
 * En dessous, la vente coute plus en frais que le reliquat ne vaut, et une
 * position qui ne se ferme jamais laisse un moniteur tourner indefiniment.
 */
export const DUST_TOKENS = 1000n;

/** Un palier de prise de profit. */
export interface TakeProfitTier {
  /** Multiple du prix d'entree a partir duquel le palier declenche. */
  multiplier: number;
  /** Pourcentage de la position INITIALE a vendre sur ce palier. */
  sellPct: number;
}

export interface PositionInit {
  mint: PublicKey;
  /** Createur du token : determine le creator_vault au moment de vendre. */
  creator: PublicKey;
  /** SOL reellement depense a l'entree (frais inclus), en lamports. */
  entrySolLamports: bigint;
  /** Tokens reellement recus, en unites de base (6 decimales). */
  tokensBought: bigint;
  /** Epoch ms d'atterrissage du bundle de deploiement. */
  deployedAt: number;
  tiers: TakeProfitTier[];
}

export interface PositionSnapshot {
  mint: string;
  tokensBought: string;
  tokensRemaining: string;
  entrySolLamports: string;
  solRecovered: string;
  entryPrice: number;
  peakMultiple: number;
  tiersHit: boolean[];
  realizedPnlLamports: string;
  closed: boolean;
  ageMs: number;
}

export class Position {
  readonly mint: PublicKey;
  readonly creator: PublicKey;
  readonly entrySolLamports: bigint;
  readonly tokensBought: bigint;
  readonly deployedAt: number;
  readonly tiers: readonly TakeProfitTier[];
  /** Prix effectif d'entree, en lamports par unite de base de token. */
  readonly entryPrice: number;

  /** Tokens encore detenus. Decremente a chaque vente confirmee. */
  tokensRemaining: bigint;
  /** SOL encaisse par les ventes, en lamports. */
  solRecovered = 0n;
  /** Un drapeau par palier, dans l'ordre de `tiers`. */
  readonly tiersHit: boolean[];
  /** Plus haut multiple observe - base du trailing stop. */
  peakMultiple = 1;
  closed = false;
  /**
   * Verrou de vente. Le monitor peut declencher plusieurs fois pendant qu'une
   * vente est en vol ; sans ce verrou on vendrait deux fois les memes tokens
   * et la seconde transaction echouerait - au mieux.
   */
  selling = false;

  constructor(init: PositionInit) {
    if (init.tokensBought <= 0n) throw new Error('Position: tokensBought must be > 0');
    if (init.entrySolLamports <= 0n) throw new Error('Position: entrySolLamports must be > 0');
    assertTiers(init.tiers);

    this.mint = init.mint;
    this.creator = init.creator;
    this.entrySolLamports = init.entrySolLamports;
    this.tokensBought = init.tokensBought;
    this.tokensRemaining = init.tokensBought;
    this.deployedAt = init.deployedAt;
    this.tiers = [...init.tiers].sort((a, b) => a.multiplier - b.multiplier);
    this.tiersHit = this.tiers.map(() => false);
    this.entryPrice = Number(init.entrySolLamports) / Number(init.tokensBought);
  }

  /** Multiple courant par rapport au prix d'entree effectif. */
  multipleAt(price: number): number {
    return price / this.entryPrice;
  }

  /** Met a jour le sommet. A appeler a chaque tick du monitor. */
  updatePeak(price: number): number {
    const m = this.multipleAt(price);
    if (m > this.peakMultiple) this.peakMultiple = m;
    return m;
  }

  /**
   * Nombre de tokens correspondant a un pourcentage de la position INITIALE.
   *
   * Balaye la poussiere : des paliers 33/33/34 laissent quelques unites de base
   * en division entiere. Les laisser trainer couterait plus cher en frais qu'
   * elles ne valent, et surtout empecherait la position de se fermer.
   */
  tokensForPct(pct: number): bigint {
    const wanted = (this.tokensBought * BigInt(Math.round(pct * 100))) / 10_000n;
    if (wanted >= this.tokensRemaining) return this.tokensRemaining;
    return this.tokensRemaining - wanted <= DUST_TOKENS ? this.tokensRemaining : wanted;
  }

  /**
   * Enregistre une vente confirmee.
   * `tokensSold` doit venir d'une reconciliation on-chain, pas de l'intention :
   * une vente partiellement executee ou un bundle non atterri fausserait l'etat.
   */
  recordFill(tokensSold: bigint, solReceived: bigint, tierIndex?: number): void {
    if (tokensSold < 0n) throw new Error('Position: tokensSold must be >= 0');
    if (tokensSold > this.tokensRemaining) {
      throw new Error(
        `Position: sold ${tokensSold} but only ${this.tokensRemaining} remained - state is out of sync`,
      );
    }
    this.tokensRemaining -= tokensSold;
    this.solRecovered += solReceived;
    if (tierIndex !== undefined) {
      const hit = this.tiersHit[tierIndex];
      if (hit === undefined) throw new Error(`Position: unknown tier index ${tierIndex}`);
      this.tiersHit[tierIndex] = true;
    }
    if (this.tokensRemaining <= DUST_TOKENS) this.closed = true;
  }

  /** Marque tous les paliers atteints comme consommes (vente groupee). */
  markTiersHit(indexes: readonly number[]): void {
    for (const i of indexes) {
      if (this.tiersHit[i] === undefined) throw new Error(`Position: unknown tier index ${i}`);
      this.tiersHit[i] = true;
    }
  }

  /** PnL realise : uniquement ce qui est encaisse, sans valoriser le reliquat. */
  get realizedPnlLamports(): bigint {
    return this.solRecovered - this.entrySolLamports;
  }

  /** true des que les ventes ont rembourse la mise : le reliquat joue gratuitement. */
  get isDeRisked(): boolean {
    return this.solRecovered >= this.entrySolLamports;
  }

  ageMs(now = Date.now()): number {
    return now - this.deployedAt;
  }

  snapshot(now = Date.now()): PositionSnapshot {
    return {
      mint: this.mint.toBase58(),
      tokensBought: this.tokensBought.toString(),
      tokensRemaining: this.tokensRemaining.toString(),
      entrySolLamports: this.entrySolLamports.toString(),
      solRecovered: this.solRecovered.toString(),
      entryPrice: this.entryPrice,
      peakMultiple: this.peakMultiple,
      tiersHit: [...this.tiersHit],
      realizedPnlLamports: this.realizedPnlLamports.toString(),
      closed: this.closed,
      ageMs: this.ageMs(now),
    };
  }
}

/**
 * Valide la configuration des paliers au demarrage plutot qu'au moment de
 * vendre : une somme de pourcentages superieure a 100 ne se decouvrirait
 * sinon qu'au troisieme palier, position deja engagee.
 */
export function assertTiers(tiers: readonly TakeProfitTier[]): void {
  if (tiers.length === 0) throw new Error('Position: at least one take-profit tier is required');
  let total = 0;
  for (const t of tiers) {
    if (!(t.multiplier > 1)) {
      throw new Error(`Position: tier multiplier must be > 1, got ${t.multiplier}`);
    }
    if (!(t.sellPct > 0) || t.sellPct > 100) {
      throw new Error(`Position: tier sellPct must be in (0, 100], got ${t.sellPct}`);
    }
    total += t.sellPct;
  }
  if (total > 100) {
    throw new Error(`Position: take-profit tiers sell ${total}% in total, which exceeds 100%`);
  }
}

/** Parse "2,5,10" + "40,30,30" en paliers. Utilise par le chargement du .env. */
export function parseTiers(multipliers: string, percentages: string): TakeProfitTier[] {
  const m = multipliers.split(',').map((s) => Number(s.trim()));
  const p = percentages.split(',').map((s) => Number(s.trim()));
  if (m.length !== p.length) {
    throw new Error(
      `take-profit config mismatch: ${m.length} multipliers vs ${p.length} percentages`,
    );
  }
  if (m.some(Number.isNaN) || p.some(Number.isNaN)) {
    throw new Error('take-profit config contains a non-numeric value');
  }
  const tiers = m.map((multiplier, i) => ({ multiplier, sellPct: p[i] as number }));
  assertTiers(tiers);
  return tiers;
}
