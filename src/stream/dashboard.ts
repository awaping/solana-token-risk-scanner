/**
 * Tableau de bord du mode stream : classement des tokens actifs (triés par
 * trades, volume, momentum ou capitalisation) avec leur niveau de risque.
 *
 * Le format des lignes est commun à toutes les blockchains ; chaque moteur
 * (Solana, EVM) fournit ses lignes. Les lancements sans activité ne sont
 * jamais affichés. Le nombre de holders est indicatif : il n'intervient ni
 * dans le seuil ni dans le tri (il se gonfle trop facilement avec des wallets
 * jetables).
 */
import type { RiskLevel } from '../types.js';
import { c, colorForScore, fmtNum, fmtPct, padEndVisible, padStartVisible } from '../utils/format.js';
import { evmPrice, evmTradesLastMinute, type EvmStreamEngine } from '../evm/engine.js';
import { marketMetrics, tradesLastMinute } from './activity.js';
import type { StreamEngine } from './engine.js';
import type { FastVerdict } from './fast-score.js';

export type SortKey = 'trades' | 'volume' | 'momentum' | 'mcap';
export const SORT_KEYS: readonly SortKey[] = ['trades', 'volume', 'momentum', 'mcap'];

export const SORT_LABELS: Record<SortKey, string> = {
  trades: 'nombre de trades',
  volume: 'volume',
  momentum: 'trades sur la dernière minute',
  mcap: 'capitalisation',
};

/** Ligne du classement, indépendante de la blockchain. */
export interface BoardRow {
  symbol: string;
  /** Mint (Solana) ou adresse du contrat (EVM). */
  address: string;
  ageMs: number;
  trades: number;
  buys: number;
  sells: number;
  momentum: number;
  /** Volume et capitalisation exprimés dans `unit` (SOL, WETH, WBNB, USDC…). */
  volume: number;
  mcap: number | null;
  unit: string;
  holders: number | null;
  /** Progression de la bonding curve (Solana uniquement). */
  progressPct: number | null;
  graduated: boolean;
  top10Pct: number | null;
  devPct: number | null;
  devSold: boolean;
  verdict: FastVerdict;
  /** Audit du contrat encore en cours (EVM). */
  pending: boolean;
  /** Libellé du marché (DEX) le cas échéant. */
  market?: string;
}

export interface BoardOptions {
  sort: SortKey;
  limit: number;
  only?: ReadonlySet<RiskLevel>;
  now: number;
}

type Rankable = Pick<BoardRow, 'trades' | 'volume' | 'momentum' | 'mcap'>;

const sortValue = (row: Rankable, key: SortKey): number => {
  switch (key) {
    case 'trades':
      return row.trades;
    case 'volume':
      return row.volume;
    case 'momentum':
      return row.momentum;
    case 'mcap':
      return row.mcap ?? 0;
  }
};

/**
 * Trie les candidats, puis ne calcule le risque (plus coûteux) que pour les
 * lignes réellement affichées. Avec un filtre de risque, les tokens dont
 * l'audit est en cours sont masqués (leur niveau n'est pas encore connu).
 */
function rank<C extends Rankable>(candidates: C[], opts: BoardOptions, finish: (candidate: C) => BoardRow): BoardRow[] {
  candidates.sort((x, y) => sortValue(y, opts.sort) - sortValue(x, opts.sort) || y.trades - x.trades || y.volume - x.volume);
  const rows: BoardRow[] = [];
  for (const candidate of candidates) {
    if (rows.length >= opts.limit) break;
    const row = finish(candidate);
    if (opts.only && (row.pending || !opts.only.has(row.verdict.level))) continue;
    rows.push(row);
  }
  return rows;
}

/** Classement des tokens Solana (Pump.fun) actifs. */
export function buildBoard(engine: StreamEngine, opts: BoardOptions): BoardRow[] {
  const candidates = engine
    .trackedTokens()
    .filter((t) => t.active)
    .map((token) => {
      const a = token.activity;
      const market = marketMetrics(a, token.supply);
      return {
        token,
        trades: a.trades,
        momentum: tradesLastMinute(a, opts.now),
        volume: market.volumeSol,
        mcap: market.marketCapSol,
        progressPct: token.graduated ? 100 : market.progressPct,
      };
    });
  return rank(candidates, opts, ({ token, trades, momentum, volume, mcap, progressPct }) => {
    const verdict = engine.rescore(token);
    const conc = engine.concentrationOf(token);
    return {
      symbol: token.symbol || '?',
      address: token.mint,
      ageMs: opts.now - token.detectedAtMs,
      trades,
      buys: token.activity.buys,
      sells: token.activity.sells,
      momentum,
      volume,
      mcap,
      unit: 'SOL',
      holders: token.activity.holders,
      progressPct,
      graduated: token.graduated,
      top10Pct: conc.top10Pct,
      devPct: conc.devPct,
      devSold: token.devSold,
      verdict,
      pending: false,
      market: 'Pump.fun',
    };
  });
}

/** Classement des tokens EVM actifs. */
export function buildEvmBoard(engine: EvmStreamEngine, opts: BoardOptions): BoardRow[] {
  const candidates = engine
    .trackedTokens()
    .filter((t) => t.active)
    .map((token) => {
      const a = token.activity;
      const audit = token.audit;
      const price = evmPrice(token);
      const volume = audit ? Number(a.volumeRaw) / 10 ** audit.quote.decimals : 0;
      const mcap = audit && price !== undefined ? price * (Number(audit.totalSupply) / 10 ** audit.decimals) : null;
      return { token, trades: a.trades, momentum: evmTradesLastMinute(a, opts.now), volume, mcap };
    });
  return rank(candidates, opts, ({ token, trades, momentum, volume, mcap }) => {
    const verdict = engine.rescore(token);
    const audit = token.audit;
    const devPct =
      audit && token.currentDevBalance !== undefined && audit.totalSupply > 0n
        ? Number((token.currentDevBalance * 1_000_000n) / audit.totalSupply) / 10_000
        : null;
    return {
      symbol: audit?.symbol || '?',
      address: token.address,
      ageMs: opts.now - token.detectedAtMs,
      trades,
      buys: token.activity.buys,
      sells: token.activity.sells,
      momentum,
      volume,
      mcap,
      unit: audit?.quote.symbol ?? '',
      holders: null,
      progressPct: null,
      graduated: false,
      top10Pct: null,
      devPct,
      devSold: token.devSold || token.liquidityPulled,
      verdict,
      pending: !audit,
      market: token.dexName,
    };
  });
}

export function fmtAge(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(s % 60).padStart(2, '0')}`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}`;
}

const compact = (value: number) =>
  value >= 1_000_000
    ? `${fmtNum(value / 1_000_000, 1)} M`
    : value >= 1000
      ? `${fmtNum(value / 1000, 1)} k`
      : fmtNum(value, value >= 100 ? 0 : value >= 1 ? 1 : 3);

const dash = () => c.gray('–');
const withUnit = (value: number | null, unit: string) => (value === null ? dash() : `${compact(value)} ${unit}`.trim());

interface Column {
  title: string;
  width: number;
  align: 'left' | 'right';
  sort?: SortKey;
  /** Colonne masquée quand aucune ligne n'a de valeur (ex. holders et courbe sur EVM). */
  hasValue?: (row: BoardRow) => boolean;
  cell: (row: BoardRow, index: number) => string;
}

const COLUMNS: Column[] = [
  { title: '#', width: 2, align: 'right', cell: (_r, i) => String(i + 1) },
  { title: 'Symbole', width: 10, align: 'left', cell: (r) => c.bold(r.symbol.slice(0, 10)) },
  { title: 'Âge', width: 5, align: 'right', cell: (r) => fmtAge(r.ageMs) },
  { title: 'Trades', width: 6, align: 'right', sort: 'trades', cell: (r) => fmtNum(r.trades) },
  { title: 'A/V', width: 9, align: 'right', cell: (r) => `${c.green(fmtNum(r.buys))}/${c.red(fmtNum(r.sells))}` },
  { title: '1 min', width: 5, align: 'right', sort: 'momentum', cell: (r) => fmtNum(r.momentum) },
  { title: 'Volume', width: 12, align: 'right', sort: 'volume', cell: (r) => (r.pending ? dash() : withUnit(r.volume, r.unit)) },
  { title: 'MCap', width: 12, align: 'right', sort: 'mcap', cell: (r) => withUnit(r.mcap, r.unit) },
  {
    title: 'Courbe',
    width: 6,
    align: 'right',
    hasValue: (r) => r.graduated || r.progressPct !== null,
    cell: (r) => (r.graduated ? c.cyan('migré') : r.progressPct === null ? dash() : `${fmtNum(r.progressPct, 0)} %`),
  },
  { title: 'Holders', width: 7, align: 'right', hasValue: (r) => r.holders !== null, cell: (r) => (r.holders === null ? dash() : c.gray(fmtNum(r.holders))) },
  { title: 'Top10', width: 5, align: 'right', hasValue: (r) => r.top10Pct !== null, cell: (r) => (r.top10Pct === null ? dash() : `${fmtNum(r.top10Pct, 0)} %`) },
  {
    title: 'Dev',
    width: 6,
    align: 'right',
    cell: (r) => (r.devSold ? c.red('vendu') : r.devPct === null ? dash() : fmtPct(r.devPct, 1)),
  },
  {
    title: 'Risque',
    width: 10,
    align: 'left',
    cell: (r) => {
      if (r.pending) return c.gray('audit…');
      const color = colorForScore(r.verdict.score);
      return color(`${padEndVisible(r.verdict.level, 6)} ${padStartVisible(String(r.verdict.score), 3)}`);
    },
  },
  { title: 'Adresse', width: 44, align: 'left', cell: (r) => c.gray(r.address) },
];

const pad = (text: string, col: Column) => (col.align === 'right' ? padStartVisible(text, col.width) : padEndVisible(text, col.width));

/** Lignes du tableau (en-tête + une ligne par token). */
export function renderBoard(rows: BoardRow[], sort: SortKey): string[] {
  const columns = COLUMNS.filter((col) => !col.hasValue || rows.some(col.hasValue));
  const header = columns.map((col) => {
    const title = pad(col.title, col);
    return col.sort === sort ? c.bold(c.cyan(title)) : c.gray(title);
  }).join('  ');
  const lines = [header];
  rows.forEach((row, i) => lines.push(columns.map((col) => pad(col.cell(row, i), col)).join('  ')));
  return lines;
}
