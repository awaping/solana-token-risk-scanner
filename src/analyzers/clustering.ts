/**
 * Module "Clustering de wallets".
 *
 * Une distribution organique suit une loi de puissance : quelques gros
 * holders puis une longue traîne, donc une forte dispersion (écart-type élevé
 * par rapport à la moyenne). Un opérateur qui répartit sa supply sur N wallets
 * "clonés" produit au contraire des soldes quasi identiques :
 *   - coefficient de variation (σ/μ) anormalement bas ;
 *   - groupes de wallets détenant la même part à 0,1 point de % près.
 */
import type { ClusteringAnalysis, Holder, WalletCluster } from '../types.js';
import { bn, distribution, gini } from '../utils/math.js';

export interface ClusteringOptions {
  /** Tolérance absolue entre deux parts, en points de % de supply (0,1 par défaut). */
  toleranceAbsPct: number;
  /**
   * Tolérance relative maximale (5 % par défaut) : évite de regrouper les
   * petites positions de la traîne où 0,1 point représente un écart énorme.
   */
  toleranceRel: number;
  /** Écart relatif maximal pour considérer des soldes comme "clones stricts". */
  strictCloneRel: number;
  /** Taille minimale d'un groupe pour être signalé. */
  minClusterSize: number;
  /** Part minimale (en %) d'un wallet pour participer à la détection. */
  minPct: number;
}

/** Seuil sous lequel un solde est considéré comme de la poussière (% de supply). */
const DUST_PCT = 0.001;

export const DEFAULT_CLUSTERING_OPTIONS: ClusteringOptions = {
  toleranceAbsPct: 0.1,
  toleranceRel: 0.05,
  strictCloneRel: 0.001,
  minClusterSize: 3,
  minPct: 0.1,
};

/** Tolérance effective autour d'une part donnée. */
function toleranceFor(pct: number, opts: ClusteringOptions): number {
  return Math.min(opts.toleranceAbsPct, opts.toleranceRel * pct);
}

/**
 * Regroupe les holders de parts voisines (algorithme glouton sur la liste
 * triée) : un wallet rejoint le groupe courant tant que l'écart avec le plus
 * gros wallet du groupe reste dans la tolérance.
 */
export function detectClusters(holders: Holder[], opts: ClusteringOptions = DEFAULT_CLUSTERING_OPTIONS): WalletCluster[] {
  const sorted = holders.filter((h) => h.pct >= opts.minPct).sort((a, b) => b.pct - a.pct);
  const clusters: WalletCluster[] = [];

  let group: Holder[] = [];
  const flush = () => {
    if (group.length >= opts.minClusterSize) {
      const pcts = group.map((h) => h.pct);
      const amounts = group.map((h) => h.amount);
      const maxAmount = amounts.reduce((a, b) => (b > a ? b : a));
      const minAmount = amounts.reduce((a, b) => (b < a ? b : a));
      const relSpread = maxAmount === 0n ? 0 : bn(maxAmount - minAmount).div(bn(maxAmount)).toNumber();
      const totalPct = pcts.reduce((a, b) => a + b, 0);
      clusters.push({
        owners: group.map((h) => h.owner),
        avgPct: totalPct / group.length,
        spreadPct: Math.max(...pcts) - Math.min(...pcts),
        totalPct,
        strictClone: relSpread <= opts.strictCloneRel,
      });
    }
    group = [];
  };

  for (const holder of sorted) {
    const head = group[0];
    // Epsilon : 3,0 - 2,9 vaut 0,10000000000000009 en virgule flottante.
    if (head && head.pct - holder.pct <= toleranceFor(head.pct, opts) + 1e-9) {
      group.push(holder);
    } else {
      flush();
      group = [holder];
    }
  }
  flush();

  // Les clones stricts d'abord, puis les groupes les plus lourds.
  return clusters.sort((a, b) => Number(b.strictClone) - Number(a.strictClone) || b.totalPct - a.totalPct);
}

/**
 * Statistiques de dispersion (moyenne, variance, écart-type, CV, Gini) et
 * détection de groupes sur les wallets du top 20 (hors comptes protocolaires).
 */
export function analyzeClustering(
  wallets: Holder[],
  opts: ClusteringOptions = DEFAULT_CLUSTERING_OPTIONS,
): ClusteringAnalysis {
  // Les soldes-poussière (< 0,001 % de la supply) qui complètent parfois le
  // top 20 d'un token peu distribué fausseraient la dispersion : on les écarte.
  const sample = wallets.slice(0, 20).filter((h) => h.pct >= DUST_PCT);
  const pcts = sample.map((h) => h.pct);
  const stats = distribution(pcts);
  const clusters = detectClusters(sample, opts);
  const largestCluster =
    clusters.length === 0
      ? null
      : clusters.reduce((best, c) =>
          c.owners.length > best.owners.length || (c.owners.length === best.owners.length && c.totalPct > best.totalPct)
            ? c
            : best,
        );

  return {
    sampleSize: stats.n,
    meanPct: stats.mean,
    variancePct: stats.variance,
    stdDevPct: stats.stdDev,
    coefficientOfVariation: stats.coefficientOfVariation,
    gini: gini(sample.map((h) => h.amount)),
    clusters,
    largestCluster,
    toleranceAbsPct: opts.toleranceAbsPct,
  };
}
