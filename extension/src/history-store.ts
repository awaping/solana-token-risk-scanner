/**
 * Historique des analyses, conservé dans le navigateur (chrome.storage.local).
 *
 * Chaque token garde la suite de ses analyses : la première (à l'ouverture du
 * token) puis chaque actualisation, pour suivre l'évolution de la note et des
 * métriques. Seule la dernière analyse conserve le détail complet (holders,
 * constats de tous les modules) ; les précédentes gardent les chiffres clés.
 *
 * Module pur (aucune API chrome, aucune dépendance Solana) : le stockage est
 * injecté, ce qui le rend testable et utilisable par la page d'historique.
 */

export type Level = 'VERT' | 'ORANGE' | 'ROUGE';
export type Severity = 'critical' | 'warning' | 'info' | 'ok';

/** Chiffres clés d'une analyse : ce qui permet de tracer une évolution. */
export interface ScanMetrics {
  top10Pct?: number;
  top20Pct?: number;
  maxWalletPct?: number;
  /** Wallets hors créateur au-dessus du seuil de baleine. */
  whales?: number;
  holders?: number;
  dustRatio?: number;
  venue?: string;
  reserveSol?: number;
  marketCapSol?: number;
  priceSol?: number;
  curveProgressPct?: number;
  creatorHoldingPct?: number;
  creatorPreviousTokens?: number;
  creatorSolBalance?: number;
  largestClusterSize?: number;
}

/** Une analyse dans le temps (format compact, conservé pour chaque analyse). */
export interface ScanPoint {
  at: number;
  score: number;
  level: Level;
  /** Part du poids des modules effectivement analysée (0-1). */
  coverage: number;
  /** Sous-score de chaque module (null = non analysé). */
  modules: Record<string, number | null>;
  metrics: ScanMetrics;
  /** Constats critiques et alertes, tels qu'affichés dans le panneau. */
  alerts: Array<{ severity: 'critical' | 'warning'; message: string }>;
}

/** Détail complet de la dernière analyse. */
export interface ScanDetail {
  at: number;
  token: {
    mint: string;
    name?: string;
    symbol?: string;
    program: string;
    decimals: number;
    /** Supply en unités brutes (texte : trop grande pour un nombre JSON). */
    supply: string;
    /** Lien du fichier de métadonnées (réseaux sociaux, image). */
    uri?: string;
    mintAuthority: string | null;
    freezeAuthority: string | null;
    dangerousExtensions: Array<{ name: string; detail: string; severity: Severity }>;
  };
  modules: Array<{ id: string; label: string; weight: number; score: number | null; findings: Array<{ severity: Severity; message: string }>; unavailableReason?: string }>;
  floors: Array<{ floor: number; reason: string }>;
  holders?: Array<{ owner: string; pct: number; kind: string; label?: string }>;
  reserve?: { venue: string; marketType: string; reserveSol: number; marketCapSol: number; priceSol: number; curveProgressPct?: number };
  creator?: {
    address: string;
    holdingPct: number;
    previousTokensCreated: number;
    solBalance: number;
    signatureCount: number;
    fullHistory: boolean;
    walletAgeDays?: number;
  };
  dusting?: { totalHolders: number; dustHolders: number; dustRatio: number };
  /** Adresse de la page quand ce n'était pas le mint (bonding curve, pool). */
  resolvedFrom?: { address: string; kind: string };
  durationMs: number;
  rpcRequests: number;
}

export interface ScanSnapshot {
  mint: string;
  name?: string;
  symbol?: string;
  point: ScanPoint;
  detail: ScanDetail;
}

/** Réseaux sociaux et dev, lus après l'analyse (n'entrent pas dans la note). */
export interface CoinSocials {
  twitter?: { handle?: string; url: string; kind: string };
  telegram?: string;
  website?: string;
  description?: string;
  dev?: { address: string; username?: string };
  at: number;
}

export interface CoinHistory {
  mint: string;
  name?: string;
  symbol?: string;
  firstSeen: number;
  lastSeen: number;
  scans: ScanPoint[];
  latest: ScanDetail;
  socials?: CoinSocials;
}

/** Ligne de l'index : de quoi lister les tokens sans charger tout l'historique. */
export interface CoinSummary {
  mint: string;
  name?: string;
  symbol?: string;
  firstSeen: number;
  lastSeen: number;
  count: number;
  firstScore: number;
  lastScore: number;
  lastLevel: Level;
  minScore: number;
  maxScore: number;
  /** Notes successives (bornées) pour la mini-courbe de la liste. */
  trend: number[];
}

/** Résumé renvoyé au panneau après une analyse. */
export interface HistoryBrief {
  count: number;
  first: { at: number; score: number };
  previous?: { at: number; score: number };
}

/** Sous-ensemble de chrome.storage.local dont l'historique a besoin. */
export interface KeyValueStore {
  get(keys: string[]): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string[]): Promise<void>;
}

export const MAX_COINS = 1_000;
export const MAX_SCANS_PER_COIN = 200;
const TREND_POINTS = 30;
const INDEX_KEY = 'history:index';
const coinKey = (mint: string) => `history:coin:${mint}`;

export function briefOf(coin: CoinHistory): HistoryBrief {
  const first = coin.scans[0]!;
  const previous = coin.scans.length >= 2 ? coin.scans[coin.scans.length - 2] : undefined;
  return {
    count: coin.scans.length,
    first: { at: first.at, score: first.score },
    ...(previous ? { previous: { at: previous.at, score: previous.score } } : {}),
  };
}

function summarize(coin: CoinHistory): CoinSummary {
  const scores = coin.scans.map((s) => s.score);
  const last = coin.scans[coin.scans.length - 1]!;
  return {
    mint: coin.mint,
    ...(coin.name ? { name: coin.name } : {}),
    ...(coin.symbol ? { symbol: coin.symbol } : {}),
    firstSeen: coin.firstSeen,
    lastSeen: coin.lastSeen,
    count: coin.scans.length,
    firstScore: scores[0]!,
    lastScore: last.score,
    lastLevel: last.level,
    minScore: Math.min(...scores),
    maxScore: Math.max(...scores),
    trend: scores.slice(-TREND_POINTS),
  };
}

export class HistoryStore {
  /** Écritures sérialisées : deux analyses simultanées ne s'écrasent pas l'index. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly store: KeyValueStore) {}

  private exclusive<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async index(): Promise<CoinSummary[]> {
    const data = await this.store.get([INDEX_KEY]);
    return Array.isArray(data[INDEX_KEY]) ? (data[INDEX_KEY] as CoinSummary[]) : [];
  }

  /** Enregistre une analyse ; renvoie le résumé (nombre d'analyses, première, précédente). */
  record(snapshot: ScanSnapshot): Promise<HistoryBrief> {
    return this.exclusive(async () => {
      const key = coinKey(snapshot.mint);
      const data = await this.store.get([key, INDEX_KEY]);
      const existing = data[key] as CoinHistory | undefined;
      const coin: CoinHistory = existing
        ? {
            ...existing,
            name: snapshot.name ?? existing.name,
            symbol: snapshot.symbol ?? existing.symbol,
            lastSeen: snapshot.point.at,
            // La première analyse est toujours gardée : c'est la référence de l'évolution.
            scans: [...existing.scans, snapshot.point].filter((_, i, all) => i === 0 || i > all.length - MAX_SCANS_PER_COIN),
            latest: snapshot.detail,
          }
        : {
            mint: snapshot.mint,
            ...(snapshot.name ? { name: snapshot.name } : {}),
            ...(snapshot.symbol ? { symbol: snapshot.symbol } : {}),
            firstSeen: snapshot.point.at,
            lastSeen: snapshot.point.at,
            scans: [snapshot.point],
            latest: snapshot.detail,
          };

      const index = (Array.isArray(data[INDEX_KEY]) ? (data[INDEX_KEY] as CoinSummary[]) : []).filter((c) => c.mint !== coin.mint);
      index.unshift(summarize(coin));
      // Au-delà du plafond, les tokens consultés le moins récemment sont oubliés.
      const dropped = index.splice(MAX_COINS);
      await this.store.set({ [key]: coin, [INDEX_KEY]: index });
      if (dropped.length > 0) await this.store.remove(dropped.map((c) => coinKey(c.mint)));
      return briefOf(coin);
    });
  }

  /** Tokens analysés, du plus récemment consulté au plus ancien. */
  async list(): Promise<CoinSummary[]> {
    return [...(await this.index())].sort((a, b) => b.lastSeen - a.lastSeen);
  }

  async get(mint: string): Promise<CoinHistory | null> {
    const key = coinKey(mint);
    const data = await this.store.get([key]);
    return (data[key] as CoinHistory | undefined) ?? null;
  }

  /** Ajoute les réseaux sociaux et le dev à un token déjà enregistré. */
  attachSocials(mint: string, socials: CoinSocials): Promise<void> {
    return this.exclusive(async () => {
      const key = coinKey(mint);
      const coin = (await this.store.get([key]))[key] as CoinHistory | undefined;
      if (coin) await this.store.set({ [key]: { ...coin, socials } });
    });
  }

  remove(mint: string): Promise<void> {
    return this.exclusive(async () => {
      const index = (await this.index()).filter((c) => c.mint !== mint);
      await this.store.set({ [INDEX_KEY]: index });
      await this.store.remove([coinKey(mint)]);
    });
  }

  clear(): Promise<void> {
    return this.exclusive(async () => {
      const index = await this.index();
      await this.store.remove([INDEX_KEY, ...index.map((c) => coinKey(c.mint))]);
    });
  }

  /** Export complet (sauvegarde ou analyse externe), en JSON simple. */
  async exportAll(): Promise<CoinHistory[]> {
    const index = await this.index();
    if (index.length === 0) return [];
    const data = await this.store.get(index.map((c) => coinKey(c.mint)));
    return index.map((c) => data[coinKey(c.mint)] as CoinHistory | undefined).filter((c): c is CoinHistory => Boolean(c));
  }
}
