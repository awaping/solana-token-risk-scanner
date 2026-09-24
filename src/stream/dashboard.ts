/**
 * Tableau de bord du mode stream : classement des tokens actifs (triés par
 * holders, trades, volume, momentum ou capitalisation) avec leur niveau de
 * risque. Les lancements sans activité ne sont jamais affichés.
 */
import type { RiskLevel } from '../types.js';
import { c, colorForScore, fmtNum, fmtPct, padEndVisible, padStartVisible } from '../utils/format.js';
import { marketMetrics, tradesLastMinute } from './activity.js';
import type { StreamEngine, TokenState } from './engine.js';
import type { FastVerdict } from './fast-score.js';

export type SortKey = 'holders' | 'trades' | 'volume' | 'momentum' | 'mcap';
export const SORT_KEYS: readonly SortKey[] = ['holders', 'trades', 'volume', 'momentum', 'mcap'];

export const SORT_LABELS: Record<SortKey, string> = {
  holders: 'holders',
  trades: 'nombre de trades',
  volume: 'volume',
  momentum: 'trades sur la dernière minute',
  mcap: 'capitalisation',
};

export interface BoardRow {
  token: TokenState;
  verdict: FastVerdict;
  holders: number;
  trades: number;
  buys: number;
  sells: number;
  momentum: number;
  volumeSol: number;
  mcapSol: number;
  progressPct: number;
  top10Pct: number;
  devPct: number;
  ageMs: number;
}

export interface BoardOptions {
  sort: SortKey;
  limit: number;
  only?: ReadonlySet<RiskLevel>;
  now: number;
}

const sortValue = (row: BoardRow, key: SortKey): number => {
  switch (key) {
    case 'holders':
      return row.holders;
    case 'trades':
      return row.trades;
    case 'volume':
      return row.volumeSol;
    case 'momentum':
      return row.momentum;
    case 'mcap':
      return row.mcapSol;
  }
};

/**
 * Construit le classement des tokens actifs (seuil ACTIF franchi). Les
 * métriques d'activité sont lues en O(1) ; le risque (plus coûteux : tri des
 * soldes) n'est recalculé que pour les lignes effectivement affichées.
 */
export function buildBoard(engine: StreamEngine, opts: BoardOptions): BoardRow[] {
  const candidates: Array<Omit<BoardRow, 'verdict' | 'top10Pct' | 'devPct'>> = [];
  for (const token of engine.trackedTokens()) {
    if (!token.active) continue;
    const a = token.activity;
    const market = marketMetrics(a, token.supply);
    candidates.push({
      token,
      holders: a.holders,
      trades: a.trades,
      buys: a.buys,
      sells: a.sells,
      momentum: tradesLastMinute(a, opts.now),
      volumeSol: market.volumeSol,
      mcapSol: market.marketCapSol,
      progressPct: token.graduated ? 100 : market.progressPct,
      ageMs: opts.now - token.detectedAtMs,
    });
  }
  // Tri principal demandé, puis holders et trades pour départager.
  const key = opts.sort;
  candidates.sort(
    (x, y) => sortValue(y as BoardRow, key) - sortValue(x as BoardRow, key) || y.holders - x.holders || y.trades - x.trades,
  );

  const rows: BoardRow[] = [];
  for (const candidate of candidates) {
    if (rows.length >= opts.limit) break;
    const verdict = engine.rescore(candidate.token);
    if (opts.only && !opts.only.has(verdict.level)) continue;
    const conc = engine.concentrationOf(candidate.token);
    rows.push({ ...candidate, verdict, top10Pct: conc.top10Pct, devPct: conc.devPct });
  }
  return rows;
}

export function fmtAge(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(s % 60).padStart(2, '0')}`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}`;
}

const compactSol = (sol: number) => (sol >= 1000 ? `${fmtNum(sol / 1000, 1)} k` : fmtNum(sol, sol >= 100 ? 0 : 1));

interface Column {
  title: string;
  width: number;
  align: 'left' | 'right';
  sort?: SortKey;
  cell: (row: BoardRow, index: number) => string;
}

const COLUMNS: Column[] = [
  { title: '#', width: 2, align: 'right', cell: (_r, i) => String(i + 1) },
  { title: 'Symbole', width: 10, align: 'left', cell: (r) => c.bold((r.token.symbol || '?').slice(0, 10)) },
  { title: 'Âge', width: 5, align: 'right', cell: (r) => fmtAge(r.ageMs) },
  { title: 'Holders', width: 7, align: 'right', sort: 'holders', cell: (r) => fmtNum(r.holders) },
  { title: 'Trades', width: 6, align: 'right', sort: 'trades', cell: (r) => fmtNum(r.trades) },
  { title: 'A/V', width: 9, align: 'right', cell: (r) => `${c.green(fmtNum(r.buys))}/${c.red(fmtNum(r.sells))}` },
  { title: '1 min', width: 5, align: 'right', sort: 'momentum', cell: (r) => fmtNum(r.momentum) },
  { title: 'Vol SOL', width: 7, align: 'right', sort: 'volume', cell: (r) => compactSol(r.volumeSol) },
  { title: 'MCap SOL', width: 8, align: 'right', sort: 'mcap', cell: (r) => compactSol(r.mcapSol) },
  {
    title: 'Courbe',
    width: 6,
    align: 'right',
    cell: (r) => (r.token.graduated ? c.cyan('migré') : `${fmtNum(r.progressPct, 0)} %`),
  },
  { title: 'Top10', width: 5, align: 'right', cell: (r) => `${fmtNum(r.top10Pct, 0)} %` },
  {
    title: 'Dev',
    width: 6,
    align: 'right',
    cell: (r) => (r.token.devSold ? c.red('vendu') : fmtPct(r.devPct, 1)),
  },
  {
    title: 'Risque',
    width: 10,
    align: 'left',
    cell: (r) => {
      const color = colorForScore(r.verdict.score);
      return color(`${padEndVisible(r.verdict.level, 6)} ${padStartVisible(String(r.verdict.score), 3)}`);
    },
  },
  { title: 'Mint', width: 44, align: 'left', cell: (r) => c.gray(r.token.mint) },
];

const pad = (text: string, col: Column) => (col.align === 'right' ? padStartVisible(text, col.width) : padEndVisible(text, col.width));

/** Lignes du tableau (en-tête + une ligne par token). */
export function renderBoard(rows: BoardRow[], sort: SortKey): string[] {
  const header = COLUMNS.map((col) => {
    const title = pad(col.title, col);
    return col.sort === sort ? c.bold(c.cyan(title)) : c.gray(title);
  }).join('  ');
  const lines = [header];
  rows.forEach((row, i) => lines.push(COLUMNS.map((col) => pad(col.cell(row, i), col)).join('  ')));
  return lines;
}
