/**
 * Issue des trades paper, et comparaison des tokens : ceux qui ont « run »
 * contre ceux qui ont « rug », les trades gagnants contre les perdants, sur les
 * données relevées AU MOMENT DE L'ACHAT. Module pur (page d'historique, tests).
 *
 * Définitions (capitalisation en SOL, donc indépendante du cours du SOL) :
 *   run  — la capitalisation a au moins doublé après l'achat ;
 *   rug  — elle a perdu 70 % ou plus (ou la réserve s'est vidée à 90 %) sans doubler avant ;
 *   neutre — ni l'un ni l'autre à la ré-analyse de 4 h.
 * Les ré-analyses automatiques (5 min, 15 min, 1 h, 4 h, 24 h après l'achat)
 * fournissent ces mesures même si la page a été fermée.
 */
import { formatAge } from '../../src/utils/age.js';
import type { CoinHistory, CoinSummary, Level, PaperTrade, ScanPoint } from './history-store.js';
import type { PaperAmount } from './paper.js';

export type MarketOutcome = 'run' | 'rug' | 'neutre' | 'en cours' | 'inconnu';
export type TradeResult = 'gain' | 'perte' | 'nul';

export const RUN_X = 2;
export const RUG_X = 0.3;
const RESERVE_RUG = 0.1;
/** Un peu moins de 4 h : la ré-analyse « 4 h » tombe 4 h après l'achat, quelques secondes avant l'analyse d'entrée + 4 h. */
export const DECIDED_AFTER_MS = 3.5 * 3_600_000;

// ---------------------------------------------------------------------------
// Déjà rug à l'ouverture
// ---------------------------------------------------------------------------

/** Pool d'un token migré sous 1 SOL : liquidité retirée (une migration Pump.fun y verse ~85 SOL). */
const POOL_DEAD_SOL = 1;
/** Bonding curve revenue sous 0,5 SOL… */
const CURVE_DEAD_SOL = 0.5;
/** …après une vraie activité (achats puis ventes massives), ou passé un âge où un token vivant a des acheteurs. */
const CURVE_DEAD_TX = 40;
const CURVE_DEAD_AGE_SEC = 15 * 60;

const sol = (value: number) => `${value.toLocaleString('fr-FR', { maximumFractionDigits: value < 1 ? 3 : 2 })} SOL`;

/**
 * Token déjà mort quand la page a été ouverte : la raison, sinon undefined.
 * Ces tokens faussent les statistiques (on n'y entre pas, ils ne peuvent ni
 * run ni rug) : ils en sont exclus par défaut.
 */
export function alreadyRugged(point: ScanPoint): string | undefined {
  const m = point.metrics;
  if (m.reserveSol === undefined || !m.marketType) return undefined;
  if (m.marketType === 'amm-pool' && m.reserveSol < POOL_DEAD_SOL) return `liquidité retirée : ${sol(m.reserveSol)} dans la pool`;
  if (m.marketType === 'bonding-curve' && m.reserveSol < CURVE_DEAD_SOL) {
    if ((m.mintTxCount ?? 0) >= CURVE_DEAD_TX) return `bonding curve vidée : ${sol(m.reserveSol)} restants après ${m.mintTxCount} transactions`;
    if ((point.tokenAgeSec ?? 0) >= CURVE_DEAD_AGE_SEC) return `bonding curve vide (${sol(m.reserveSol)}) ${formatAge(point.tokenAgeSec!)} après le lancement`;
  }
  return undefined;
}

export interface CoinOutcome {
  /** Analyse de référence : celle faite à l'achat, sinon la dernière avant. */
  entry?: ScanPoint;
  /** true : l'analyse de référence a été lancée par l'achat lui-même. */
  entryExact: boolean;
  market: MarketOutcome;
  /** Capitalisation maximale après l'achat, en multiple de celle de l'achat. */
  peakX?: number;
  /** Dernière capitalisation mesurée, en multiple de celle de l'achat. */
  lastX?: number;
  /** A doublé, puis s'est effondré. */
  thenRug?: boolean;
  open: boolean;
  pnl?: PaperAmount;
  pnlPct?: number;
  result?: TradeResult;
  /** Âge du token au premier achat, à la fermeture de la position, et durée de détention (s). */
  entryAgeSec?: number;
  exitAgeSec?: number;
  holdSec?: number;
  firstBuy?: PaperTrade;
  exit?: PaperTrade;
}

export function entryPoint(coin: CoinHistory): { point?: ScanPoint; exact: boolean } {
  const paper = coin.paper;
  if (!paper) return { exact: false };
  const firstBuy = paper.trades.find((t) => t.kind === 'achat');
  if (firstBuy?.scan) return { point: firstBuy.scan, exact: true };
  const at = firstBuy?.at ?? paper.firstAt;
  const before = coin.scans.filter((s) => s.at <= at);
  return { point: before[before.length - 1] ?? coin.scans[0], exact: false };
}

function market(coin: CoinHistory, entry: ScanPoint | undefined, now: number): Pick<CoinOutcome, 'market' | 'peakX' | 'lastX' | 'thenRug'> {
  const base = entry?.metrics.marketCapSol;
  if (!entry || !base || base <= 0) return { market: 'inconnu' };
  const later = coin.scans.filter((s) => s.at > entry.at && s.metrics.marketCapSol !== undefined);
  if (later.length === 0) return { market: now - entry.at > 2 * DECIDED_AFTER_MS ? 'inconnu' : 'en cours' };
  const peakX = Math.max(...later.map((s) => s.metrics.marketCapSol!)) / base;
  const last = later[later.length - 1]!;
  const lastX = last.metrics.marketCapSol! / base;
  const reserve = entry.metrics.reserveSol;
  const drained = reserve !== undefined && reserve > 0 && last.metrics.reserveSol !== undefined && last.metrics.reserveSol <= reserve * RESERVE_RUG;
  const collapsed = lastX <= RUG_X || drained;
  if (peakX >= RUN_X) return { market: 'run', peakX, lastX, ...(collapsed ? { thenRug: true } : {}) };
  if (collapsed) return { market: 'rug', peakX, lastX };
  return { market: last.at - entry.at >= DECIDED_AFTER_MS ? 'neutre' : 'en cours', peakX, lastX };
}

/** Issue d'un token tradé en paper ; undefined s'il n'a jamais été tradé. */
export function coinOutcome(coin: CoinHistory, now = Date.now()): CoinOutcome | undefined {
  const paper = coin.paper;
  if (!paper) return undefined;
  const { point: entry, exact } = entryPoint(coin);
  const latest = paper.latest;
  const open = paper.closedAt === undefined;
  // PnL non affiché mais position soldée : ventes moins achats.
  const pnl =
    latest.pnl ??
    (!open && latest.bought && latest.sold && latest.bought.unit === latest.sold.unit
      ? { value: latest.sold.value - latest.bought.value, unit: latest.bought.unit }
      : undefined);
  const sign = pnl ? Math.sign(pnl.value) : latest.pnlPct !== undefined ? Math.sign(latest.pnlPct) : undefined;
  const firstBuy = paper.trades.find((t) => t.kind === 'achat');
  const exit = open ? undefined : [...paper.trades].reverse().find((t) => t.kind === 'vente');
  return {
    ...(entry ? { entry } : {}),
    entryExact: exact,
    ...market(coin, entry, now),
    open,
    ...(pnl ? { pnl } : {}),
    ...(latest.pnlPct !== undefined ? { pnlPct: latest.pnlPct } : {}),
    ...(sign !== undefined ? { result: sign > 0 ? 'gain' : sign < 0 ? 'perte' : 'nul' } : {}),
    ...(firstBuy?.tokenAgeSec !== undefined ? { entryAgeSec: firstBuy.tokenAgeSec } : {}),
    ...(exit?.tokenAgeSec !== undefined ? { exitAgeSec: exit.tokenAgeSec } : {}),
    ...(firstBuy && exit ? { holdSec: Math.max(0, (exit.at - firstBuy.at) / 1000) } : {}),
    ...(firstBuy ? { firstBuy } : {}),
    ...(exit ? { exit } : {}),
  };
}

// ---------------------------------------------------------------------------
// Comparaison des groupes
// ---------------------------------------------------------------------------

export interface EntryMetric {
  key: string;
  label: string;
  digits: number;
  get(entry: ScanPoint, outcome: CoinOutcome): number | undefined;
}

/** Données relevées à l'achat, comparées entre les groupes. */
export const ENTRY_METRICS: EntryMetric[] = [
  { key: 'score', label: 'Note de risque', digits: 0, get: (e) => e.score },
  { key: 'age', label: 'Âge du token à l’achat (s)', digits: 0, get: (_e, o) => o.entryAgeSec },
  { key: 'mcap', label: 'Capitalisation (SOL)', digits: 1, get: (e) => e.metrics.marketCapSol },
  { key: 'reserve', label: 'Réserve réelle (SOL)', digits: 2, get: (e) => e.metrics.reserveSol },
  { key: 'curve', label: 'Bonding curve (%)', digits: 1, get: (e) => e.metrics.curveProgressPct },
  { key: 'top10', label: 'Top 10 holders (%)', digits: 1, get: (e) => e.metrics.top10Pct },
  { key: 'maxWallet', label: 'Plus gros wallet (%)', digits: 1, get: (e) => e.metrics.maxWalletPct },
  { key: 'whales', label: 'Baleines', digits: 0, get: (e) => e.metrics.whales },
  { key: 'holders', label: 'Holders recensés', digits: 0, get: (e) => e.metrics.holders },
  { key: 'dust', label: 'Poussière (%)', digits: 1, get: (e) => (e.metrics.dustRatio === undefined ? undefined : e.metrics.dustRatio * 100) },
  { key: 'creatorPct', label: 'Part du créateur (%)', digits: 1, get: (e) => e.metrics.creatorHoldingPct },
  { key: 'creatorTokens', label: 'Tokens déjà créés par le dev', digits: 0, get: (e) => e.metrics.creatorPreviousTokens },
  { key: 'creatorSol', label: 'Solde du dev (SOL)', digits: 2, get: (e) => e.metrics.creatorSolBalance },
  { key: 'cluster', label: 'Plus gros cluster (wallets)', digits: 0, get: (e) => e.metrics.largestClusterSize },
  { key: 'coverage', label: 'Couverture de l’analyse (%)', digits: 0, get: (e) => e.coverage * 100 },
];

export type Comparison = 'market' | 'result';

export const GROUPS: Record<Comparison, { a: string; b: string; aLabel: string; bLabel: string; aShort: string; bShort: string }> = {
  market: { a: 'run', b: 'rug', aLabel: 'Run (×2 ou plus)', bLabel: 'Rug (−70 % ou plus)', aShort: 'Run', bShort: 'Rug' },
  result: { a: 'gain', b: 'perte', aLabel: 'Trades gagnants', bLabel: 'Trades perdants', aShort: 'Gagnants', bShort: 'Perdants' },
};

export interface MetricRow {
  key: string;
  label: string;
  digits: number;
  /** Médianes de chaque groupe, et nombre de tokens où la donnée existe. */
  a?: number;
  b?: number;
  na: number;
  nb: number;
}

export interface AlertRow {
  label: string;
  /** Part des tokens du groupe (0-1) qui avaient cette alerte à l'achat. */
  a: number;
  b: number;
}

export interface ComparisonResult {
  by: Comparison;
  a: number;
  b: number;
  rows: MetricRow[];
  alerts: AlertRow[];
}

export function median(values: number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((x, y) => x - y);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

const NUMBER = /([+\-−]?\d(?:[\d.,]|\s(?=\d))*)/;

/** Alerte sans ses chiffres : « Top 10 détient 45 % » et « … 61 % » sont la même alerte. */
export function alertKey(message: string): string {
  return message.split(NUMBER).map((part, i) => (i % 2 ? '#' : part)).join('').replace(/\s+/g, ' ').trim();
}

/** Libellé commun à plusieurs variantes d'une alerte : les chiffres qui varient deviennent « … ». */
export function alertLabel(messages: string[]): string {
  const split = messages.map((m) => m.replace(/\s+/g, ' ').trim().split(NUMBER));
  const first = split[0] ?? [];
  return first.map((part, i) => (i % 2 && split.some((s) => s[i] !== part) ? '…' : part)).join('');
}

/** Compare les données d'achat entre run et rug (ou gagnants et perdants). */
export function compareGroups(coins: CoinHistory[], by: Comparison, now = Date.now(), options: { includeDead?: boolean } = {}): ComparisonResult {
  const groups = GROUPS[by];
  const a: Array<{ entry: ScanPoint; outcome: CoinOutcome }> = [];
  const b: typeof a = [];
  for (const coin of coins) {
    if (coin.deadAtOpen && !options.includeDead) continue;
    const outcome = coinOutcome(coin, now);
    if (!outcome?.entry) continue;
    const tag = by === 'market' ? outcome.market : outcome.result;
    if (tag === groups.a) a.push({ entry: outcome.entry, outcome });
    else if (tag === groups.b) b.push({ entry: outcome.entry, outcome });
  }
  const values = (group: typeof a, metric: EntryMetric) =>
    group.map((g) => metric.get(g.entry, g.outcome)).filter((v): v is number => v !== undefined && Number.isFinite(v));
  const rows = ENTRY_METRICS.map((metric) => {
    const va = values(a, metric);
    const vb = values(b, metric);
    const ma = median(va);
    const mb = median(vb);
    return { key: metric.key, label: metric.label, digits: metric.digits, ...(ma !== undefined ? { a: ma } : {}), ...(mb !== undefined ? { b: mb } : {}), na: va.length, nb: vb.length };
  });

  const labels = new Map<string, Set<string>>();
  const share = (group: typeof a) => {
    const counts = new Map<string, number>();
    for (const { entry } of group) {
      const keys = new Set(entry.alerts.map((alert) => {
        const key = alertKey(alert.message);
        const variants = labels.get(key) ?? new Set<string>();
        if (variants.size < 50) variants.add(alert.message);
        labels.set(key, variants);
        return key;
      }));
      for (const key of keys) counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return counts;
  };
  const sa = share(a);
  const sb = share(b);
  const alerts = [...labels.keys()]
    .map((key) => ({ label: alertLabel([...labels.get(key)!]), a: a.length ? (sa.get(key) ?? 0) / a.length : 0, b: b.length ? (sb.get(key) ?? 0) / b.length : 0 }))
    .sort((x, y) => Math.abs(y.a - y.b) - Math.abs(x.a - x.b))
    .slice(0, 15);
  return { by, a: a.length, b: b.length, rows, alerts };
}

// ---------------------------------------------------------------------------
// Totaux
// ---------------------------------------------------------------------------

export interface PaperTotals {
  /** Niveau de risque à l'achat (ou « tous »). */
  level: Level | 'tous';
  coins: number;
  open: number;
  gains: number;
  pertes: number;
  /** Sommes par unité (SOL, USD…) : les montants d'unités différentes ne s'additionnent pas. */
  bought: Record<string, number>;
  pnl: Record<string, number>;
  markets: Record<MarketOutcome, number>;
}

/** Totaux par niveau de risque à l'achat ; les tokens déjà rug à l'ouverture sont exclus par défaut. */
export function paperTotals(summaries: CoinSummary[], options: { includeDead?: boolean } = {}): PaperTotals[] {
  const empty = (level: PaperTotals['level']): PaperTotals => ({
    level,
    coins: 0,
    open: 0,
    gains: 0,
    pertes: 0,
    bought: {},
    pnl: {},
    markets: { run: 0, rug: 0, neutre: 0, 'en cours': 0, inconnu: 0 },
  });
  const rows = new Map<PaperTotals['level'], PaperTotals>((['tous', 'VERT', 'ORANGE', 'ROUGE'] as const).map((l) => [l, empty(l)]));
  for (const summary of summaries) {
    const paper = summary.paper;
    if (!paper || (summary.deadAtOpen && !options.includeDead)) continue;
    for (const row of [rows.get('tous')!, paper.entryLevel ? rows.get(paper.entryLevel) : undefined]) {
      if (!row) continue;
      row.coins++;
      if (paper.open) row.open++;
      if (paper.result === 'gain') row.gains++;
      if (paper.result === 'perte') row.pertes++;
      if (paper.bought) row.bought[paper.bought.unit] = (row.bought[paper.bought.unit] ?? 0) + paper.bought.value;
      if (paper.pnl) row.pnl[paper.pnl.unit] = (row.pnl[paper.pnl.unit] ?? 0) + paper.pnl.value;
      row.markets[paper.market]++;
    }
  }
  return [...rows.values()];
}
