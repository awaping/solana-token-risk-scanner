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
import { CONCENTRATION, PUMP_FUN_CIRCULATING_FACTOR } from '../constants.js';
import { levelFor } from '../scoring/engine.js';
import type { Finding, RiskLevel, ScoreFloor } from '../types.js';
import type { Concentration } from './activity.js';
import { fmtNum, fmtPct, fmtSol, shortAddr } from '../utils/format.js';
import { clamp, combineRisks, lamportsToSol, piecewise } from '../utils/math.js';

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
  /**
   * Progression de la bonding curve (0-100).
   *
   * Indispensable pour juger une concentration : 5 % de la supply entre les
   * mains d'un tiers est anecdotique sur une courbe à 90 %, et mortel sur une
   * courbe à 14 % où la réserve ne représente que quelques SOL.
   */
  curveProgressPct?: number;
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
  // Chaque règle pousse un indice de risque indépendant (0-100) plutôt que
  // d'additionner des points : voir combineRisks() pour la raison.
  const risks: number[] = [];
  const risk = (value: number) => {
    if (value > 0) risks.push(value);
  };
  const who = shortAddr(s.creator.address);

  // --- Créateur -------------------------------------------------------------
  const seen = s.creator.launches24h;
  const enriched = s.creator.enrichment;
  const serialFromStream = piecewise(seen, [[1, 0], [2, 20], [3, 40], [5, 65], [10, 90]]);
  const serialFromHistory = enriched
    ? piecewise(enriched.previousTokensCreated, [[0, 0], [1, 20], [3, 50], [5, 70], [10, 90]])
    : 0;
  risk(Math.max(serialFromStream, serialFromHistory));

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
      risk(15);
      findings.push({ severity: 'warning', message: `Wallet jetable (${enriched.signatureCount} transactions)` });
    }
    if (enriched.walletAgeDays !== undefined && enriched.walletAgeDays < 2) {
      risk(10);
      findings.push({ severity: 'warning', message: `Wallet créé il y a ${fmtNum(enriched.walletAgeDays * 24, 1)} h` });
    }
    if (n >= 10) floors.push({ floor: 60, reason: `Déployeur en série (${n} tokens)` });
  }
  if (seen >= 10) floors.push({ floor: 70, reason: `${seen} lancements en 24 h` });

  if (s.creator.devSellsSeen >= 1) {
    risk(s.creator.devSellsSeen >= 3 ? 45 : 25);
    findings.push({
      severity: s.creator.devSellsSeen >= 3 ? 'critical' : 'warning',
      message: `Ce créateur a déjà vendu rapidement ${s.creator.devSellsSeen} de ses tokens`,
    });
    if (s.creator.devSellsSeen >= 3) floors.push({ floor: 70, reason: 'Créateur récidiviste (ventes rapides)' });
  }

  // --- Achat du dev -----------------------------------------------------------
  //
  // Rampe continue plutôt que trois paliers : des paliers ne produisent qu'une
  // poignée de valeurs distinctes, et un dev à 4,9 % se retrouvait noté comme un
  // dev à 0 %.
  const devPct = Math.max(s.devBuyPct, s.bundle?.devPct ?? 0);
  risk(piecewise(devPct, [[0, 0], [2, 4], [5, 12], [10, 25], [20, 45], [35, 70]]));
  if (devPct > 20) {
    findings.push({ severity: 'critical', message: `Le dev s'est servi ${fmtPct(devPct)} de la supply au lancement` });
  } else if (devPct > 10) {
    findings.push({ severity: 'warning', message: `Achat initial du dev : ${fmtPct(devPct)} de la supply` });
  } else if (devPct > 5) {
    findings.push({ severity: 'info', message: `Achat initial du dev : ${fmtPct(devPct)} de la supply` });
  } else if (devPct > 0) {
    findings.push({ severity: 'ok', message: `Achat initial du dev modéré : ${fmtPct(devPct)}` });
  }
  if (devPct > 30) floors.push({ floor: 70, reason: `Dev à ${fmtPct(devPct)} dès le lancement` });

  // --- Bundle / snipers -----------------------------------------------------
  const b = s.bundle;
  if (b) {

    // Rampes partant de zéro : un lancement avec 2 snipers n'est pas identique
    // à un lancement sans aucun, et la note doit le refléter.
    risk(piecewise(b.sameSlotBuyers, [[0, 0], [2, 6], [3, 15], [6, 30], [10, 45]]));
    risk(piecewise(b.bundlePct, [[0, 0], [2, 4], [5, 10], [10, 18], [25, 32], [40, 48]]));
    const buyers = `${b.sameSlotBuyers} acheteur${b.sameSlotBuyers > 1 ? 's' : ''} dans le slot de création`;
    const wider = b.windowSlots > 1 ? `, ${b.windowBuyers} sur les ${b.windowSlots} premiers slots` : '';
    const message = `${buyers}${wider} → ${fmtPct(b.bundlePct)} de la supply`;
    if (b.bundlePct >= 25 || b.sameSlotBuyers >= 6) findings.push({ severity: 'critical', message: `Bundle au lancement : ${message}` });
    else if (b.bundlePct >= 10 || b.sameSlotBuyers >= 3) findings.push({ severity: 'warning', message: `Snipers : ${message}` });
    else findings.push({ severity: 'ok', message: `Lancement propre : ${message}` });

    if (b.cloneGroupSize >= 3) {
      risk(40);
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
  //
  // Le piège que cette section doit attraper : une concentration AGRÉGÉE qui
  // paraît saine alors que deux ou trois wallets tiers tiennent tout le
  // flottant. Un top 10 à 11 % semble excellent — sauf si la courbe n'est qu'à
  // 14 % de progression, auquel cas ces 11 % représentent la quasi-totalité des
  // jetons en circulation et n'importe lequel de ces wallets peut vider le
  // carnet d'un seul ordre.
  const conc = s.concentration;
  if (conc && conc.holders >= 5) {
    const top10 = `Top 10 holders : ${fmtPct(conc.top10Pct)} de la supply (${conc.holders} holders)`;
    risk(piecewise(conc.top10Pct, [[8, 0], [15, 5], [25, 13], [40, 28], [60, 50], [80, 70]]));
    if (conc.top10Pct >= 50) {
      findings.push({ severity: 'critical', message: top10 });
      if (conc.top10Pct >= 70) floors.push({ floor: 75, reason: `Supply monopolisée (top 10 = ${fmtPct(conc.top10Pct)})` });
    } else if (conc.top10Pct >= 30) {
      findings.push({ severity: 'warning', message: top10 });
    } else {
      findings.push({ severity: 'info', message: top10 });
    }


    // Baleines hors dev : l'achat du dev est déjà noté plus haut, ce sont les
    // wallets tiers au-dessus du seuil qui constituent le risque de dump.
    const whales = conc.whalePcts;
    const threshold = fmtPct(CONCENTRATION.WHALE_SUPPLY_PCT, 1);
    if (whales.length > 0) {
      const biggest = whales[0]!;
      const whaleSum = whales.reduce((acc, p) => acc + p, 0);
      risk(piecewise(biggest, [[CONCENTRATION.WHALE_SUPPLY_PCT, 0], [5, 20], [8, 40], [12, 60], [20, 80]]));
      risk(piecewise(whales.length, [[1, 0], [2, 20], [3, 40], [5, 60]]));

      const detail = whales.map((p) => fmtPct(p)).join(' + ');
      findings.push({
        severity: whales.length >= 2 || biggest >= 8 ? 'critical' : 'warning',
        message:
          whales.length === 1
            ? `Un wallet hors dev détient ${detail} de la supply (seuil ${threshold})`
            : `${whales.length} wallets hors dev au-dessus de ${threshold} : ${detail} = ${fmtPct(whaleSum)} cumulés`,
      });

      // Courbe jeune : la réserve SOL est trop mince pour absorber une sortie.
      const progress = s.curveProgressPct;
      if (progress !== undefined && progress < CONCENTRATION.EARLY_CURVE_PCT) {
        risk(20);
        findings.push({
          severity: 'critical',
          message: `Baleine(s) sur une courbe à ${fmtPct(progress, 1)} : la réserve ne peut pas absorber leur sortie`,
        });
        if (whales.length >= 2) {
          floors.push({
            floor: 70,
            reason: `${whales.length} baleines (${fmtPct(whaleSum)}) sur une courbe à ${fmtPct(progress, 1)}`,
          });
        }
      }

      // Part du flottant réellement en circulation. Calculée uniquement en
      // présence de baleines : tout token neuf a mécaniquement un flottant
      // concentré, ce n'est un signal que si des wallets assez gros le tiennent.
      if (progress !== undefined && progress > 0) {
        const floatSupplyPct = progress * PUMP_FUN_CIRCULATING_FACTOR;
        const floatCapturePct = Math.min(100, (conc.top10Pct / floatSupplyPct) * 100);
        if (floatCapturePct >= CONCENTRATION.FLOAT_CAPTURE_PCT) {
          findings.push({
            severity: 'critical',
            message: `Le top 10 détient ${fmtPct(floatCapturePct)} des jetons réellement en circulation`,
          });
          floors.push({ floor: 75, reason: `Top 10 = ${fmtPct(floatCapturePct)} du flottant` });
        }
      }
    } else if (conc.topNonDevPct > 0) {
      findings.push({
        severity: 'ok',
        message: `Aucun wallet hors dev au-dessus de ${threshold} (plus gros : ${fmtPct(conc.topNonDevPct)})`,
      });
    }
  }

  // --- Immaturité -----------------------------------------------------------
  //
  // Base de risque toujours présente, sans seuil : un token qui vient de naître
  // a peu de porteurs ET une réserve de quelques SOL, donc une sortie
  // structurellement incertaine même sans le moindre signe de manipulation.
  // C'est ce qui donne du relief au bas de l'échelle, où la quasi-totalité des
  // tokens tombait à zéro faute de déclencher une règle à seuil.
  //
  // MAXIMUM et non somme : « peu de porteurs » et « courbe mince » mesurent le
  // même fait sous-jacent — la jeunesse du lancement. Les combiner comme deux
  // indices indépendants pénaliserait deux fois la même chose et ferait virser
  // à l'orange tout lancement normal de quelques secondes.
  const immaturity = Math.max(
    conc ? piecewise(conc.holders, [[6, 24], [12, 15], [25, 8], [60, 3], [150, 0]]) : 0,
    s.curveProgressPct === undefined ? 0 : piecewise(s.curveProgressPct, [[2, 24], [10, 15], [25, 7], [50, 2], [80, 0]]),
  );
  risk(immaturity);

  // --- Événements de suivi ---------------------------------------------------
  if (s.devSold) {
    risk(40);
    findings.push({ severity: 'critical', message: 'Le dev a vendu ses tokens' });
    floors.push({ floor: 70, reason: 'Vente du dev' });
  }
  if (s.copycatOf) {
    risk(10);
    findings.push({ severity: 'warning', message: `Symbole déjà lancé récemment (${shortAddr(s.copycatOf)}) : possible copie` });
  }

  const maxFloor = floors.reduce((acc, f) => Math.max(acc, f.floor), 0);
  // Le plancher reste un maximum dur : il exprime une règle catégorique
  // (« ce profil est au moins aussi grave que X »), pas une pénalité de plus.
  const score = Math.round(clamp(Math.max(combineRisks(risks), maxFloor)));
  return { score, level: levelFor(score), findings, floors };
}
