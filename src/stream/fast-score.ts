/**
 * Score de risque "rapide" du mode stream : fonction pure, sans I/O,
 * évaluée en quelques microsecondes à partir de ce qui est connu à l'instant T.
 *
 *   T0  création       réputation du créateur (cache local), achat initial du dev, copie de symbole
 *   T1  fenêtre bundle acheteurs du/des premier(s) slot(s) : snipers, bundle Jito, montants clonés
 *   T2  enrichissement historique RPC du créateur (asynchrone, arrive en quelques secondes)
 *   +   activité       concentration réelle des holders (soldes reconstruits depuis les trades)
 *   +   alertes        vente du dev pendant la période de suivi
 *
 * Niveaux identiques au scan complet : VERT 0-30 · ORANGE 31-69 · ROUGE 70-100.
 */
import { levelFor } from '../scoring/engine.js';
import type { Finding, RiskLevel, ScoreFloor } from '../types.js';
import type { Concentration } from './activity.js';
import { fmtNum, fmtPct, fmtSol, shortAddr } from '../utils/format.js';
import { clamp, lamportsToSol, piecewise } from '../utils/math.js';

export interface TradeRecord {
  signature: string;
  slot: number;
  user: string;
  isBuy: boolean;
  solAmount: bigint;
  tokenAmount: bigint;
}

export interface BundleStats {
  /** Nombre de slots inclus dans la fenêtre (slot de création compris). */
  windowSlots: number;
  /** Acheteurs distincts (hors dev) dans le slot de création. */
  sameSlotBuyers: number;
  /** Acheteurs distincts (hors dev) dans toute la fenêtre. */
  windowBuyers: number;
  /** Part de la supply acquise par ces acheteurs (%). */
  bundlePct: number;
  /** Part de la supply acquise par le dev dans la fenêtre (%). */
  devPct: number;
  /** Plus grand groupe de wallets ayant acheté le même montant de SOL (±0,1 %). */
  cloneGroupSize: number;
  cloneGroupSol: number;
}

export interface CreatorSnapshot {
  address: string;
  /** Créations observées par le flux sur 24 h (token courant inclus). */
  launches24h: number;
  /** Tokens précédents dont le dev a vendu pendant la période de suivi. */
  devSellsSeen: number;
  /** Historique RPC (disponible après enrichissement asynchrone). */
  enrichment?: {
    previousTokensCreated: number;
    signatureCount: number;
    fullHistory: boolean;
    walletAgeDays?: number;
    solBalance: number;
    txScanned: number;
  };
}

export interface FastSnapshot {
  creator: CreatorSnapshot;
  /** Achat initial du dev dans la transaction de création (% de supply). */
  devBuyPct: number;
  bundle?: BundleStats;
  /** Le dev a vendu pendant le suivi. */
  devSold: boolean;
  /** Mint d'un token récent portant le même symbole. */
  copycatOf?: string;
  /** Concentration réelle des holders (à partir de 5 holders). */
  concentration?: Concentration;
}

export interface FastVerdict {
  score: number;
  level: RiskLevel;
  findings: Finding[];
  floors: ScoreFloor[];
}

/** Tolérance des montants clonés : 1 / 1000 = 0,1 %. */
const CLONE_TOLERANCE_INV = 1000n;

/**
 * Statistiques d'achat sur la fenêtre [slot de création, slot de création + windowSlots - 1].
 */
export function computeBundleStats(
  trades: readonly TradeRecord[],
  createSlot: number,
  windowSlots: number,
  devWallets: ReadonlySet<string>,
  supply: bigint,
): BundleStats {
  const lastSlot = createSlot + windowSlots - 1;
  const buys = trades.filter((t) => t.isBuy && t.slot >= createSlot && t.slot <= lastSlot);
  const external = buys.filter((t) => !devWallets.has(t.user));

  const sameSlot = new Set(external.filter((t) => t.slot === createSlot).map((t) => t.user));
  const windowBuyers = new Set(external.map((t) => t.user));
  const sum = (list: TradeRecord[]) => list.reduce((acc, t) => acc + t.tokenAmount, 0n);
  // Arithmétique entière native (chemin chaud) : précision au millionième de point.
  const pct = (amount: bigint) => (supply === 0n ? 0 : Number((amount * 100_000_000n) / supply) / 1_000_000);

  // Groupes de montants SOL identiques (un achat retenu par wallet : le premier).
  const firstBuyByUser = new Map<string, bigint>();
  for (const t of external) if (!firstBuyByUser.has(t.user)) firstBuyByUser.set(t.user, t.solAmount);
  const amounts = [...firstBuyByUser.values()].sort((a, b) => (a > b ? -1 : a < b ? 1 : 0));
  let best = { size: 0, sol: 0n };
  let i = 0;
  while (i < amounts.length) {
    const head = amounts[i]!;
    let j = i + 1;
    // (head - x) / head <= 0,1 %  ⇔  (head - x) × 1000 <= head
    while (j < amounts.length && head > 0n && (head - amounts[j]!) * CLONE_TOLERANCE_INV <= head) j++;
    if (j - i > best.size) best = { size: j - i, sol: head };
    i = j;
  }

  return {
    windowSlots,
    sameSlotBuyers: sameSlot.size,
    windowBuyers: windowBuyers.size,
    bundlePct: pct(sum(external)),
    devPct: pct(sum(buys.filter((t) => devWallets.has(t.user)))),
    cloneGroupSize: best.size >= 2 ? best.size : 0,
    cloneGroupSol: best.size >= 2 ? lamportsToSol(best.sol) : 0,
  };
}

export function computeFastScore(s: FastSnapshot): FastVerdict {
  const findings: Finding[] = [];
  const floors: ScoreFloor[] = [];
  let points = 0;
  const who = shortAddr(s.creator.address);

  // --- Créateur -------------------------------------------------------------
  const seen = s.creator.launches24h;
  const enriched = s.creator.enrichment;
  const serialFromStream = piecewise(seen, [[1, 0], [2, 20], [3, 40], [5, 65], [10, 90]]);
  const serialFromHistory = enriched
    ? piecewise(enriched.previousTokensCreated, [[0, 0], [1, 20], [3, 50], [5, 70], [10, 90]])
    : 0;
  points += Math.max(serialFromStream, serialFromHistory);

  if (seen >= 3) {
    findings.push({ severity: seen >= 5 ? 'critical' : 'warning', message: `Créateur ${who} : ${seen} lancements en 24 h (déployeur en série)` });
  } else if (seen === 2) {
    findings.push({ severity: 'warning', message: `Créateur ${who} : 2e lancement en 24 h` });
  }
  if (enriched) {
    const n = enriched.previousTokensCreated;
    const window = enriched.fullHistory ? 'sur tout son historique' : `sur ses ${fmtNum(enriched.txScanned)} dernières tx`;
    if (n >= 1) {
      findings.push({ severity: n >= 5 ? 'critical' : 'warning', message: `${n} ${n > 1 ? 'autres tokens créés' : 'autre token créé'} ${window}` });
    } else {
      findings.push({ severity: 'ok', message: `Aucun autre token créé ${window}` });
    }
    if (enriched.fullHistory && enriched.signatureCount < 15) {
      points += 15;
      findings.push({ severity: 'warning', message: `Wallet jetable (${enriched.signatureCount} transactions)` });
    }
    if (enriched.walletAgeDays !== undefined && enriched.walletAgeDays < 2) {
      points += 10;
      findings.push({ severity: 'warning', message: `Wallet créé il y a ${fmtNum(enriched.walletAgeDays * 24, 1)} h` });
    }
    if (n >= 10) floors.push({ floor: 60, reason: `Déployeur en série (${n} tokens)` });
  }
  if (seen >= 10) floors.push({ floor: 70, reason: `${seen} lancements en 24 h` });

  if (s.creator.devSellsSeen >= 1) {
    points += s.creator.devSellsSeen >= 3 ? 45 : 25;
    findings.push({
      severity: s.creator.devSellsSeen >= 3 ? 'critical' : 'warning',
      message: `Ce créateur a déjà vendu rapidement ${s.creator.devSellsSeen} de ses tokens`,
    });
    if (s.creator.devSellsSeen >= 3) floors.push({ floor: 70, reason: 'Créateur récidiviste (ventes rapides)' });
  }

  // --- Achat du dev -----------------------------------------------------------
  const devPct = Math.max(s.devBuyPct, s.bundle?.devPct ?? 0);
  if (devPct > 20) {
    points += 40;
    findings.push({ severity: 'critical', message: `Le dev s'est servi ${fmtPct(devPct)} de la supply au lancement` });
  } else if (devPct > 10) {
    points += 25;
    findings.push({ severity: 'warning', message: `Achat initial du dev : ${fmtPct(devPct)} de la supply` });
  } else if (devPct > 5) {
    points += 10;
    findings.push({ severity: 'info', message: `Achat initial du dev : ${fmtPct(devPct)} de la supply` });
  } else if (devPct > 0) {
    findings.push({ severity: 'ok', message: `Achat initial du dev modéré : ${fmtPct(devPct)}` });
  }
  if (devPct > 30) floors.push({ floor: 70, reason: `Dev à ${fmtPct(devPct)} dès le lancement` });

  // --- Bundle / snipers -----------------------------------------------------
  const b = s.bundle;
  if (b) {

    points += piecewise(b.sameSlotBuyers, [[2, 0], [3, 15], [6, 30], [10, 45]]);
    points += piecewise(b.bundlePct, [[5, 0], [10, 15], [25, 30], [40, 45]]);
    const buyers = `${b.sameSlotBuyers} acheteur${b.sameSlotBuyers > 1 ? 's' : ''} dans le slot de création`;
    const wider = b.windowSlots > 1 ? `, ${b.windowBuyers} sur les ${b.windowSlots} premiers slots` : '';
    const message = `${buyers}${wider} → ${fmtPct(b.bundlePct)} de la supply`;
    if (b.bundlePct >= 25 || b.sameSlotBuyers >= 6) findings.push({ severity: 'critical', message: `Bundle au lancement : ${message}` });
    else if (b.bundlePct >= 10 || b.sameSlotBuyers >= 3) findings.push({ severity: 'warning', message: `Snipers : ${message}` });
    else findings.push({ severity: 'ok', message: `Lancement propre : ${message}` });

    if (b.cloneGroupSize >= 3) {
      points += 40;
      findings.push({
        severity: 'critical',
        message: `Wallets clonés : ${b.cloneGroupSize} achats identiques de ${fmtSol(b.cloneGroupSol)} (±0,1 %) dans la fenêtre`,
      });
      floors.push({ floor: 80, reason: `${b.cloneGroupSize} wallets clonés au lancement` });
    }
    if (b.bundlePct + b.devPct >= 40) {
      floors.push({ floor: 75, reason: `Dev + bundle = ${fmtPct(b.bundlePct + b.devPct)} de la supply raflée au lancement` });
    }
  }

  // --- Concentration réelle (soldes reconstruits depuis les trades) ----------
  const conc = s.concentration;
  if (conc && conc.holders >= 5) {
    const top10 = `Top 10 holders : ${fmtPct(conc.top10Pct)} de la supply (${conc.holders} holders)`;
    if (conc.top10Pct >= 50) {
      points += 30;
      findings.push({ severity: 'critical', message: top10 });
      if (conc.top10Pct >= 70) floors.push({ floor: 75, reason: `Supply monopolisée (top 10 = ${fmtPct(conc.top10Pct)})` });
    } else if (conc.top10Pct >= 30) {
      points += 15;
      findings.push({ severity: 'warning', message: top10 });
    } else {
      findings.push({ severity: 'ok', message: top10 });
    }
    // Le dev est déjà évalué via son achat : seul un autre wallet dominant est pénalisé ici.
    if (!conc.top1IsDev && conc.top1Pct >= 10) {
      points += conc.top1Pct >= 20 ? 25 : 10;
      findings.push({
        severity: conc.top1Pct >= 20 ? 'critical' : 'warning',
        message: `Un wallet détient ${fmtPct(conc.top1Pct)} de la supply`,
      });
      if (conc.top1Pct >= 30) floors.push({ floor: 70, reason: `Baleine à ${fmtPct(conc.top1Pct)}` });
    }
  }

  // --- Événements de suivi ---------------------------------------------------
  if (s.devSold) {
    points += 40;
    findings.push({ severity: 'critical', message: 'Le dev a vendu ses tokens' });
    floors.push({ floor: 70, reason: 'Vente du dev' });
  }
  if (s.copycatOf) {
    points += 10;
    findings.push({ severity: 'warning', message: `Symbole déjà lancé récemment (${shortAddr(s.copycatOf)}) : possible copie` });
  }

  const maxFloor = floors.reduce((acc, f) => Math.max(acc, f.floor), 0);
  const score = Math.round(clamp(Math.max(points, maxFloor)));
  return { score, level: levelFor(score), findings, floors };
}
