/**
 * Utilitaires numériques en précision arbitraire (bignumber.js).
 *
 * Les soldes u64 peuvent dépasser Number.MAX_SAFE_INTEGER (2^53) : toutes les
 * divisions / statistiques passent par BigNumber avant conversion finale.
 */
import BigNumber from 'bignumber.js';

BigNumber.config({ DECIMAL_PLACES: 40, ROUNDING_MODE: BigNumber.ROUND_HALF_UP });

export { BigNumber };

export const bn = (value: bigint | number | string | BigNumber): BigNumber =>
  BigNumber.isBigNumber(value) ? value : new BigNumber(typeof value === 'bigint' ? value.toString() : value);

/** Pourcentage (0-100) que représente `part` dans `total`. */
export function percentOf(part: bigint, total: bigint): number {
  if (total === 0n) return 0;
  return bn(part).times(100).div(bn(total)).toNumber();
}

/** Convertit un montant brut en unité "UI" selon le nombre de décimales. */
export function toUiAmount(raw: bigint, decimals: number): BigNumber {
  return bn(raw).shiftedBy(-decimals);
}

export function lamportsToSol(lamports: bigint): number {
  return toUiAmount(lamports, 9).toNumber();
}

export interface Distribution {
  n: number;
  mean: number;
  /** Variance de population (σ²). */
  variance: number;
  /** Écart-type de population (σ). */
  stdDev: number;
  /** Coefficient de variation σ/μ (0 si μ = 0). */
  coefficientOfVariation: number;
}

/**
 * Moyenne, variance et écart-type (population) d'une série de valeurs.
 * Les calculs intermédiaires sont faits en BigNumber pour éviter la perte
 * de précision sur des soldes très élevés.
 */
export function distribution(values: ReadonlyArray<BigNumber | number | bigint>): Distribution {
  const n = values.length;
  if (n === 0) return { n: 0, mean: 0, variance: 0, stdDev: 0, coefficientOfVariation: 0 };

  const nums = values.map((v) => bn(v));
  const mean = nums.reduce((acc, v) => acc.plus(v), bn(0)).div(n);
  const variance = nums.reduce((acc, v) => acc.plus(v.minus(mean).pow(2)), bn(0)).div(n);
  const stdDev = variance.sqrt();
  const cv = mean.isZero() ? bn(0) : stdDev.div(mean);

  return {
    n,
    mean: mean.toNumber(),
    variance: variance.toNumber(),
    stdDev: stdDev.toNumber(),
    coefficientOfVariation: cv.toNumber(),
  };
}

/**
 * Indice de Gini (0 = égalité parfaite, → 1 = concentration maximale).
 * Formule sur valeurs triées : G = Σ (2i - n - 1)·xᵢ / (n · Σ xᵢ).
 */
export function gini(values: ReadonlyArray<BigNumber | number | bigint>): number {
  const n = values.length;
  if (n === 0) return 0;
  const sorted = values.map((v) => bn(v)).sort((a, b) => a.comparedTo(b) ?? 0);
  const total = sorted.reduce((acc, v) => acc.plus(v), bn(0));
  if (total.isZero()) return 0;
  const weighted = sorted.reduce((acc, v, i) => acc.plus(v.times(2 * (i + 1) - n - 1)), bn(0));
  return weighted.div(total.times(n)).toNumber();
}

/**
 * Interpolation linéaire par morceaux : transforme une métrique en score.
 * Les points doivent être triés par abscisse croissante ; en dehors de
 * l'intervalle, la valeur est bornée au premier / dernier point.
 *
 * @example piecewise(25, [[10, 0], [40, 60]]) === 30
 */
export function piecewise(value: number, points: ReadonlyArray<readonly [number, number]>): number {
  if (points.length === 0) return 0;
  const first = points[0]!;
  const last = points[points.length - 1]!;
  if (!Number.isFinite(value) || value <= first[0]) return first[1];
  if (value >= last[0]) return last[1];
  for (let i = 1; i < points.length; i++) {
    const [x1, y1] = points[i]!;
    const [x0, y0] = points[i - 1]!;
    if (value <= x1) {
      const t = (value - x0) / (x1 - x0);
      return y0 + t * (y1 - y0);
    }
  }
  return last[1];
}

export const clamp = (value: number, min = 0, max = 100): number => Math.min(max, Math.max(min, value));
