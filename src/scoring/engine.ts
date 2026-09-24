/**
 * Moteur de scoring : transforme les métriques de chaque module en un
 * sous-score de dangerosité (0-100), puis en score global pondéré.
 *
 *   score global = max( Σ poids·sous-score / Σ poids disponibles , planchers )
 *
 * Les "planchers" garantissent qu'un pattern de manipulation avéré (wallets
 * clonés, supply monopolisée, autorité de gel active...) ne peut pas être
 * dilué par de bons scores ailleurs.
 *
 * Niveaux : VERT 0-30 · ORANGE 31-69 · ROUGE 70-100.
 */
import type {
  ClusteringAnalysis,
  CreatorAnalysis,
  DustingAnalysis,
  Finding,
  HoldersAnalysis,
  ModuleId,
  ModuleOutcome,
  ModuleScore,
  ReserveAnalysis,
  RiskLevel,
  RiskScore,
  ScoreFloor,
  TokenInfo,
} from '../types.js';
import { clamp, piecewise } from '../utils/math.js';
import { fmtNum, fmtPct, fmtSol, shortAddr } from '../utils/format.js';

export const MODULE_WEIGHTS: Record<ModuleId, number> = {
  authorities: 10,
  holders: 25,
  clustering: 20,
  dusting: 10,
  reserve: 20,
  creator: 15,
};

export const MODULE_LABELS: Record<ModuleId, string> = {
  authorities: 'Autorités & extensions du mint',
  holders: 'Distribution des holders (Top 20)',
  clustering: 'Clustering de wallets',
  dusting: 'Dusting (faux holders)',
  reserve: 'Réserve réelle & liquidité',
  creator: 'Traçabilité du créateur',
};

export function levelFor(score: number): RiskLevel {
  if (score >= 70) return 'ROUGE';
  if (score > 30) return 'ORANGE';
  return 'VERT';
}

export interface SubScore {
  score: number;
  findings: Finding[];
  floors: ScoreFloor[];
}

const round1 = (n: number) => Math.round(n * 10) / 10;
const plural = (n: number, word: string) => `${fmtNum(n)} ${word}${n > 1 ? 's' : ''}`;

// ---------------------------------------------------------------------------
// Autorités & extensions
// ---------------------------------------------------------------------------

export function scoreAuthorities(token: TokenInfo): SubScore {
  const findings: Finding[] = [];
  const floors: ScoreFloor[] = [];
  let points = 0;

  if (token.mintAuthority) {
    points += 60;
    findings.push({
      severity: 'critical',
      message: `Mint authority active (${shortAddr(token.mintAuthority)}) : la supply peut être gonflée à volonté`,
    });
    floors.push({ floor: 60, reason: 'Mint authority non révoquée' });
  } else {
    findings.push({ severity: 'ok', message: 'Mint authority révoquée (supply figée)' });
  }

  if (token.freezeAuthority) {
    points += 50;
    findings.push({
      severity: 'critical',
      message: `Freeze authority active (${shortAddr(token.freezeAuthority)}) : les comptes des holders peuvent être gelés (honeypot)`,
    });
    floors.push({ floor: 65, reason: 'Freeze authority non révoquée' });
  } else {
    findings.push({ severity: 'ok', message: 'Freeze authority révoquée' });
  }

  for (const ext of token.dangerousExtensions) {
    findings.push({ severity: ext.severity, message: `Extension ${ext.name} : ${ext.detail}` });
    if (ext.severity === 'critical') {
      points += 60;
      floors.push({ floor: 70, reason: `Extension Token-2022 ${ext.name}` });
    } else if (ext.severity === 'warning') {
      points += 25;
    }
  }

  if (token.metadataMutable) {
    points += 5;
    findings.push({ severity: 'info', message: 'Métadonnées modifiables (nom / image peuvent être changés)' });
  }

  return { score: clamp(points), findings, floors };
}

// ---------------------------------------------------------------------------
// Distribution des holders
// ---------------------------------------------------------------------------

export function scoreHolders(h: HoldersAnalysis): SubScore {
  const findings: Finding[] = [];
  const floors: ScoreFloor[] = [];

  const top10Score = piecewise(h.top10Pct, [[10, 0], [20, 25], [30, 50], [50, 85], [70, 100]]);
  const top20Score = piecewise(h.top20Pct, [[15, 0], [30, 30], [45, 60], [60, 85], [80, 100]]);
  const maxScore = piecewise(h.maxWalletPct, [[2, 0], [5, 30], [10, 60], [20, 90], [30, 100]]);
  const score = 0.3 * top10Score + 0.3 * top20Score + 0.4 * maxScore;

  if (h.wallets.length === 0) {
    findings.push({ severity: 'info', message: 'Aucun wallet hors protocole dans le top 20' });
  }

  const biggest = h.wallets[0];
  if (biggest) {
    const who = `${shortAddr(biggest.owner)}${biggest.kind === 'creator' ? ' (créateur)' : ''}`;
    if (h.maxWalletPct >= 20) {
      findings.push({ severity: 'critical', message: `Le wallet ${who} détient à lui seul ${fmtPct(h.maxWalletPct)} de la supply` });
    } else if (h.maxWalletPct >= 10) {
      findings.push({ severity: 'warning', message: `Le plus gros wallet (${who}) détient ${fmtPct(h.maxWalletPct)} de la supply` });
    } else {
      findings.push({ severity: 'ok', message: `Plus gros wallet : ${fmtPct(h.maxWalletPct)} de la supply` });
    }
  }

  const concentration = `Top 10 : ${fmtPct(h.top10Pct)} · Top 20 : ${fmtPct(h.top20Pct)} (${fmtPct(h.top20CirculatingPct)} de la supply circulante)`;
  if (h.top10Pct >= 50) findings.push({ severity: 'critical', message: `Concentration extrême — ${concentration}` });
  else if (h.top10Pct >= 30) findings.push({ severity: 'warning', message: `Forte concentration — ${concentration}` });
  else findings.push({ severity: 'ok', message: `Concentration modérée — ${concentration}` });

  if (h.protocolPct > 0) {
    findings.push({
      severity: 'info',
      message: `${fmtPct(h.protocolPct)} détenus par la bonding curve / les pools (exclus du calcul)`,
    });
  }
  if (h.burnedPct > 0) findings.push({ severity: 'info', message: `${fmtPct(h.burnedPct)} envoyés à l'incinérateur (burn)` });

  const programPct = h.wallets.filter((w) => w.kind === 'program').reduce((acc, w) => acc + w.pct, 0);
  if (programPct >= 5) {
    findings.push({
      severity: 'warning',
      message: `${fmtPct(programPct)} détenus par des comptes-programmes non identifiés (locker, vesting, CEX ?)`,
    });
  }

  if (h.maxWalletPct >= 50) floors.push({ floor: 85, reason: `Un wallet contrôle ${fmtPct(h.maxWalletPct)} de la supply` });
  else if (h.maxWalletPct >= 30 || h.top10Pct >= 60) {
    floors.push({ floor: 75, reason: `Supply monopolisée (top 10 = ${fmtPct(h.top10Pct)})` });
  }

  return { score: clamp(score), findings, floors };
}

// ---------------------------------------------------------------------------
// Clustering
// ---------------------------------------------------------------------------

export function scoreClustering(cl: ClusteringAnalysis, top20Pct: number): SubScore {
  const findings: Finding[] = [];
  const floors: ScoreFloor[] = [];

  findings.push({
    severity: 'info',
    message: `n = ${cl.sampleSize} · moyenne ${fmtPct(cl.meanPct, 3)} · écart-type ${fmtPct(cl.stdDevPct, 3)} · variance ${fmtNum(cl.variancePct, 4)} · CV ${fmtNum(cl.coefficientOfVariation, 3)} · Gini ${fmtNum(cl.gini, 3)}`,
  });

  // Uniformité : une distribution organique a un CV typiquement > 0,6.
  let cvScore = 0;
  if (cl.sampleSize >= 5) {
    const significance = piecewise(top20Pct, [[3, 0.3], [10, 1]]);
    cvScore = piecewise(cl.coefficientOfVariation, [[0.1, 100], [0.2, 85], [0.35, 55], [0.5, 25], [0.7, 0]]) * significance;
    const cv = fmtNum(cl.coefficientOfVariation, 3);
    if (cl.coefficientOfVariation < 0.2) {
      findings.push({ severity: 'critical', message: `Distribution anormalement uniforme (CV = ${cv}) : soldes quasi identiques` });
    } else if (cl.coefficientOfVariation < 0.35) {
      findings.push({ severity: 'warning', message: `Distribution suspecte, peu dispersée (CV = ${cv})` });
    } else if (cl.clusters.length > 0) {
      findings.push({ severity: 'info', message: `Dispersion globale normale (CV = ${cv}), mais groupe(s) de parts identiques détecté(s)` });
    } else {
      findings.push({ severity: 'ok', message: `Dispersion naturelle des soldes (CV = ${cv})` });
    }
    if (cl.coefficientOfVariation < 0.15 && cl.sampleSize >= 10 && top20Pct >= 15) {
      floors.push({ floor: 70, reason: `Top ${cl.sampleSize} anormalement uniforme (CV ${cv})` });
    }
  } else {
    findings.push({ severity: 'info', message: 'Échantillon trop petit pour mesurer la dispersion (< 5 wallets)' });
  }

  // Groupes de wallets détenant la même part.
  let clusterScore = 0;
  for (const cluster of cl.clusters) {
    const size = cluster.owners.length;
    const sizeScore = piecewise(size, [[2, 0], [3, 35], [5, 65], [8, 90], [10, 100]]);
    const weight = piecewise(cluster.totalPct, [[1, 0.5], [5, 0.8], [10, 1]]);
    let s = sizeScore * weight;
    const desc = `${size} wallets à ~${fmtPct(cluster.avgPct)} chacun`;

    if (cluster.strictClone) {
      s = Math.max(s, piecewise(size, [[3, 80], [5, 95], [6, 100]]));
      findings.push({
        severity: 'critical',
        message: `Wallets clonés : ${desc}, soldes identiques à 0,1 % près (${fmtPct(cluster.totalPct)} cumulés)`,
      });
      if (cluster.totalPct >= 3) floors.push({ floor: 80, reason: `${size} wallets clonés (${fmtPct(cluster.totalPct)} de la supply)` });
    } else {
      findings.push({
        severity: size >= 5 ? 'critical' : 'warning',
        message: `Cluster : ${desc} (écart ${fmtNum(cluster.spreadPct, 3)} pt ≤ ${fmtNum(cl.toleranceAbsPct, 1)} pt) — ${fmtPct(cluster.totalPct)} cumulés`,
      });
      if (size >= 5 && cluster.totalPct >= 10) {
        floors.push({ floor: 70, reason: `Cluster de ${size} wallets détenant ${fmtPct(cluster.totalPct)}` });
      }
    }
    clusterScore = Math.max(clusterScore, s);
  }
  if (cl.clusters.length === 0) {
    findings.push({ severity: 'ok', message: `Aucun groupe de ≥ 3 wallets à parts identiques (±${fmtNum(cl.toleranceAbsPct, 1)} pt)` });
  }

  return { score: clamp(Math.max(cvScore, clusterScore)), findings, floors };
}

// ---------------------------------------------------------------------------
// Dusting
// ---------------------------------------------------------------------------

export function scoreDusting(d: DustingAnalysis): SubScore {
  const findings: Finding[] = [];
  let score = piecewise(d.dustRatio, [[0.1, 0], [0.2, 20], [0.35, 50], [0.5, 75], [0.7, 100]]);
  const ratio = fmtPct(d.dustRatio * 100, 1);
  const threshold = fmtPct(d.dustThresholdPct, 3);

  findings.push({
    severity: 'info',
    message: `${fmtNum(d.totalHolders)} holders recensés · ${fmtNum(d.effectiveHolders)} significatifs · ${fmtNum(d.emptyAccounts)} comptes vides`,
  });

  if (d.totalHolders < 20) {
    score *= 0.5;
    findings.push({ severity: 'info', message: 'Trop peu de holders pour un diagnostic de dusting fiable' });
  }

  if (d.dustRatio >= 0.5) {
    findings.push({
      severity: 'critical',
      message: `${ratio} des holders (${fmtNum(d.dustHolders)}) ont un solde < ${threshold} de la supply : compteur gonflé artificiellement`,
    });
  } else if (d.dustRatio >= 0.25) {
    findings.push({ severity: 'warning', message: `${ratio} des holders ont un solde infinitésimal (< ${threshold})` });
  } else {
    findings.push({ severity: 'ok', message: `Peu de poussière : ${ratio} des holders sous ${threshold}` });
  }

  return { score: clamp(score), findings, floors: [] };
}

// ---------------------------------------------------------------------------
// Réserve réelle
// ---------------------------------------------------------------------------

export function scoreReserve(r: ReserveAnalysis): SubScore {
  const findings: Finding[] = [];
  const floors: ScoreFloor[] = [];
  const ratioTxt = fmtPct(r.reserveToMcapRatio * 100, 2);

  for (const err of r.searchErrors) findings.push({ severity: 'info', message: `Recherche incomplète — ${err}` });

  if (r.marketType === 'none') {
    findings.push({
      severity: 'warning',
      message: `${r.venue} : aucune réserve SOL trouvée (DEX non supporté, pool non SOL, ou liquidité retirée)`,
    });
    return { score: 65, findings, floors };
  }

  if (r.marketType === 'bonding-curve') {
    const score = piecewise(r.realReserveSol, [[0.5, 70], [2, 55], [10, 35], [30, 20], [60, 10], [85, 5]]);
    findings.push({
      severity: 'info',
      message: `Bonding curve Pump.fun à ${fmtPct(r.bondingCurveProgressPct ?? 0, 1)} · réserve réelle ${fmtSol(r.realReserveSol)} · mcap théorique ${fmtSol(r.marketCapSol)} (ratio ${ratioTxt})`,
    });
    if (r.realReserveSol < 5) {
      findings.push({ severity: 'warning', message: `Liquidité faible : seulement ${fmtSol(r.realReserveSol)} réellement en réserve` });
    } else {
      findings.push({ severity: 'ok', message: `${fmtSol(r.realReserveSol)} réels adossés à la curve` });
    }

    let penalty = 0;
    const discrepancy = r.reserveDiscrepancyPct;
    if (discrepancy !== undefined) {
      if (discrepancy < -1) {
        penalty = 40;
        findings.push({
          severity: 'critical',
          message: `Réserve déclarée non couverte : les lamports du compte sont ${fmtPct(-discrepancy, 1)} sous la réserve comptable`,
        });
      } else {
        findings.push({ severity: 'ok', message: 'Réserve comptable couverte par les lamports du compte' });
      }
    }
    return { score: clamp(score + penalty), findings, floors };
  }

  // Pool AMM
  const absScore = piecewise(r.realReserveSol, [[1, 100], [5, 80], [20, 55], [50, 35], [100, 20], [300, 5]]);
  const ratioScore = piecewise(r.reserveToMcapRatio, [[0.01, 100], [0.03, 75], [0.07, 45], [0.15, 15], [0.25, 0]]);
  const score = 0.5 * absScore + 0.5 * ratioScore;

  findings.push({
    severity: 'info',
    message: `${r.venue} · réserve ${fmtSol(r.realReserveSol)} · mcap théorique ${fmtSol(r.marketCapSol)} (ratio ${ratioTxt})${r.pools.length > 1 ? ` · ${r.pools.length} pools, ${fmtSol(r.totalReserveSol)} au total` : ''}`,
  });

  if (r.realReserveSol < 5) {
    findings.push({ severity: 'critical', message: `Liquidité quasi inexistante : ${fmtSol(r.realReserveSol)} dans la pool principale` });
  } else if (r.realReserveSol < 20) {
    findings.push({ severity: 'warning', message: `Liquidité faible : ${fmtSol(r.realReserveSol)} dans la pool principale` });
  } else {
    findings.push({ severity: 'ok', message: `Liquidité de ${fmtSol(r.realReserveSol)} dans la pool principale` });
  }

  if (r.reserveToMcapRatio < 0.02) {
    findings.push({ severity: 'critical', message: `La réserve ne couvre que ${ratioTxt} de la capitalisation : mcap largement fictive` });
  } else if (r.reserveToMcapRatio < 0.07) {
    findings.push({ severity: 'warning', message: `Réserve faible face à la capitalisation (${ratioTxt})` });
  }

  if (r.realReserveSol < 1) floors.push({ floor: 70, reason: `Liquidité retirée ou inexistante (${fmtSol(r.realReserveSol)})` });

  return { score: clamp(score), findings, floors };
}

// ---------------------------------------------------------------------------
// Créateur
// ---------------------------------------------------------------------------

export function scoreCreator(cr: CreatorAnalysis): SubScore {
  const findings: Finding[] = [];
  const floors: ScoreFloor[] = [];
  const window = cr.fullHistory ? 'sur tout son historique' : `sur ses ${fmtNum(cr.txScanned)} dernières transactions`;

  findings.push({
    severity: 'info',
    message: `Créateur ${shortAddr(cr.address, 6)} (source : ${cr.source}) · solde ${fmtSol(cr.solBalance)} · ${plural(cr.signatureCount, 'transaction')}${cr.fullHistory ? '' : ' (ou plus)'}`,
  });

  let score = piecewise(cr.previousTokensCreated, [[0, 0], [1, 20], [3, 50], [5, 70], [10, 90], [20, 100]]);
  const n = cr.previousTokensCreated;
  if (n >= 5) {
    findings.push({ severity: 'critical', message: `Déployeur en série : ${n} autres tokens créés ${window}` });
  } else if (n >= 1) {
    findings.push({ severity: 'warning', message: `${n} ${n > 1 ? 'autres tokens créés' : 'autre token créé'} ${window}` });
  } else if (cr.txScanned > 0) {
    findings.push({ severity: 'ok', message: `Aucun autre token créé ${window}` });
  }
  if (n >= 10) floors.push({ floor: 60, reason: `Déployeur en série (${n} tokens)` });

  if (cr.fullHistory && cr.signatureCount < 15) {
    score += 15;
    findings.push({ severity: 'warning', message: `Wallet jetable : seulement ${plural(cr.signatureCount, 'transaction')} au total` });
  }
  if (cr.walletAgeDays !== undefined && cr.walletAgeDays < 2) {
    score += 10;
    findings.push({ severity: 'warning', message: `Wallet créé il y a ${fmtNum(cr.walletAgeDays * 24, 1)} h` });
  }

  if (cr.holdingPct === 0) {
    score += 10;
    findings.push({ severity: 'warning', message: 'Le créateur ne détient plus aucun token (vendu ou transféré)' });
  } else if (cr.holdingPct > 20) {
    score += 40;
    findings.push({ severity: 'critical', message: `Le créateur détient encore ${fmtPct(cr.holdingPct)} de la supply` });
  } else if (cr.holdingPct > 10) {
    score += 25;
    findings.push({ severity: 'warning', message: `Le créateur détient ${fmtPct(cr.holdingPct)} de la supply` });
  } else {
    findings.push({ severity: 'ok', message: `Le créateur détient ${fmtPct(cr.holdingPct)} de la supply` });
  }

  if (cr.solBalance < 0.05) {
    score += 10;
    findings.push({ severity: 'warning', message: `Wallet du créateur quasiment vidé (${fmtSol(cr.solBalance)})` });
  }

  return { score: clamp(score), findings, floors };
}

// ---------------------------------------------------------------------------
// Agrégation
// ---------------------------------------------------------------------------

export interface ScoringInput {
  token: TokenInfo;
  holders: ModuleOutcome<HoldersAnalysis>;
  clustering: ModuleOutcome<ClusteringAnalysis>;
  dusting: ModuleOutcome<DustingAnalysis>;
  reserve: ModuleOutcome<ReserveAnalysis>;
  creator: ModuleOutcome<CreatorAnalysis>;
}

function toModuleScore<T>(id: ModuleId, outcome: ModuleOutcome<T>, scorer: (data: T) => SubScore, floors: ScoreFloor[]): ModuleScore {
  const base = { id, label: MODULE_LABELS[id], weight: MODULE_WEIGHTS[id] };
  if (outcome.status === 'unavailable') {
    return { ...base, score: null, findings: [], unavailableReason: outcome.reason };
  }
  const sub = scorer(outcome.data);
  floors.push(...sub.floors);
  return { ...base, score: round1(sub.score), findings: sub.findings };
}

export function computeRiskScore(input: ScoringInput): RiskScore {
  const floors: ScoreFloor[] = [];
  const top20Pct = input.holders.status === 'ok' ? input.holders.data.top20Pct : 0;

  const modules: ModuleScore[] = [
    toModuleScore('authorities', { status: 'ok', data: input.token }, scoreAuthorities, floors),
    toModuleScore('holders', input.holders, scoreHolders, floors),
    toModuleScore('clustering', input.clustering, (d) => scoreClustering(d, top20Pct), floors),
    toModuleScore('dusting', input.dusting, scoreDusting, floors),
    toModuleScore('reserve', input.reserve, scoreReserve, floors),
    toModuleScore('creator', input.creator, scoreCreator, floors),
  ];

  const available = modules.filter((m) => m.score !== null);
  const totalWeight = modules.reduce((acc, m) => acc + m.weight, 0);
  const availableWeight = available.reduce((acc, m) => acc + m.weight, 0);
  const weightedScore =
    availableWeight === 0 ? 0 : available.reduce((acc, m) => acc + m.weight * (m.score ?? 0), 0) / availableWeight;

  const maxFloor = floors.reduce((acc, f) => Math.max(acc, f.floor), 0);
  const score = Math.round(clamp(Math.max(weightedScore, maxFloor)));

  return {
    score,
    level: levelFor(score),
    weightedScore: round1(weightedScore),
    confidence: totalWeight === 0 ? 0 : availableWeight / totalWeight,
    modules,
    floors: floors.sort((a, b) => b.floor - a.floor),
  };
}
