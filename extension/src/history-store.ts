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
 *
 * Paper trading (DryFlip) : chaque achat et vente lus sur la page sont gardés
 * avec l'âge du token et l'analyse faite au moment de l'achat ; le token est
 * ensuite ré-analysé à intervalles pour savoir s'il a « run » ou « rug ».
 */
import { isClosed, isNewBuy, positionKey, tradeKey, type PaperAmount, type PaperPosition, type PaperWallet } from './paper.js';
import { alreadyRugged, coinOutcome, type MarketOutcome, type TradeResult } from './paper-analysis.js';

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
  marketType?: 'bonding-curve' | 'amm-pool' | 'none';
  reserveSol?: number;
  marketCapSol?: number;
  priceSol?: number;
  curveProgressPct?: number;
  creatorHoldingPct?: number;
  creatorPreviousTokens?: number;
  creatorSolBalance?: number;
  largestClusterSize?: number;
  /** Transactions sur le mint depuis sa création (activité passée). */
  mintTxCount?: number;
  /** Part de la supply détenue par des wallets frais (moins de 24 h), et leur nombre. */
  freshPct?: number;
  freshCount?: number;
}

/** Origine d'une analyse : ouverture de la page, bouton ↻, achat paper, ou suivi automatique après l'achat. */
export type ScanTrigger = 'ouverture' | 'actualisation' | 'entrée' | 'suivi';

/** Une analyse dans le temps (format compact, conservé pour chaque analyse). */
export interface ScanPoint {
  at: number;
  trigger?: ScanTrigger;
  /** Âge du token au moment où l'analyse a été demandée (s). */
  tokenAgeSec?: number;
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
  /** Création du token (ms) ; exact = false si ce n'est qu'une borne (historique trop long). */
  tokenAge?: { createdAt: number; exact: boolean };
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
  /** Hébergeur des métadonnées non autorisé : réseaux non lus (et non pas absents). */
  blocked?: string;
  at: number;
}

/** Achat ou vente vu dans DryFlip. Les montants sont les cumuls après l'opération. */
export interface PaperTrade {
  at: number;
  kind: 'achat' | 'vente';
  /**
   * true : opération vue en direct (heure exacte, à la seconde près). false : la
   * position était déjà ouverte à l'ouverture de la page ; l'heure est celle de
   * la première lecture.
   */
  observed: boolean;
  bought?: PaperAmount;
  sold?: PaperAmount;
  pnl?: PaperAmount;
  pnlPct?: number;
  tokenAgeSec?: number;
  /** Vente qui ferme la position (tout est revendu). */
  closes?: boolean;
  /** Sortie déduite de la disparition de la position dans le widget. */
  vanished?: boolean;
  /** Sortie déclarée à la main depuis le panneau. */
  manual?: boolean;
  /** Analyse lancée au moment de l'achat. */
  scan?: ScanPoint;
}

/** Position lue à un instant (courbe du PnL). */
export interface PaperPoint extends PaperPosition {
  at: number;
}

export interface CoinPaper {
  source: 'DryFlip';
  firstAt: number;
  lastAt: number;
  trades: PaperTrade[];
  /** Détail complet de l'analyse faite au premier achat. */
  entryDetail?: ScanDetail;
  latest: PaperPoint;
  points: PaperPoint[];
  /** Position entièrement revendue. */
  closedAt?: number;
}

export interface CoinHistory {
  mint: string;
  name?: string;
  symbol?: string;
  firstSeen: number;
  lastSeen: number;
  /** Création du token (ms), si connue ; `createdExact` = false : borne (le token est au moins aussi vieux). */
  createdAt?: number;
  createdExact?: boolean;
  scans: ScanPoint[];
  latest: ScanDetail;
  socials?: CoinSocials;
  paper?: CoinPaper;
  /** Déjà mort à la première ouverture de sa page (liquidité retirée, curve vidée) : exclu des statistiques. */
  deadAtOpen?: { at: number; reason: string };
}

/** Résumé paper d'un token, pour la liste et les totaux. */
export interface PaperSummary {
  bought?: PaperAmount;
  pnl?: PaperAmount;
  pnlPct?: number;
  open: boolean;
  firstAt: number;
  entryScore?: number;
  entryLevel?: Level;
  entryAgeSec?: number;
  market: MarketOutcome;
  peakX?: number;
  result?: TradeResult;
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
  paper?: PaperSummary;
  /** Raison, si le token était déjà rug à la première ouverture. */
  deadAtOpen?: string;
}

/** Résumé renvoyé au panneau après une analyse. */
export interface HistoryBrief {
  /** Token déjà rug à la première ouverture : la raison (ignoré dans les statistiques). */
  deadAtOpen?: string;
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

/** Solde du portefeuille DryFlip (carte flottante), dans le temps. */
export interface WalletHistory {
  latest: PaperWallet & { at: number };
  points: Array<{ at: number; balance: PaperAmount }>;
}

/** Ré-analyse programmée après un achat, pour connaître l'issue du token. */
export interface FollowUp {
  mint: string;
  due: number;
  step: number;
  attempts: number;
}

export const MAX_COINS = 1_000;
export const MAX_SCANS_PER_COIN = 200;
export const MAX_PAPER_POINTS = 500;
/** Un point de PnL au plus toutes les 30 s (chaque achat ou vente est toujours gardé). */
export const PAPER_POINT_MS = 30_000;
/** Ré-analyses après le premier achat : 5 min, 15 min, 1 h, 4 h, 24 h. */
export const FOLLOW_UP_DELAYS_MS = [5 * 60_000, 15 * 60_000, 60 * 60_000, 4 * 3_600_000, 24 * 3_600_000];
const FOLLOW_UP_RETRY_MS = 5 * 60_000;
const FOLLOW_UP_MAX_ATTEMPTS = 3;
const TREND_POINTS = 30;
const INDEX_KEY = 'history:index';
const WALLET_KEY = 'paper:wallet';
const FOLLOW_UPS_KEY = 'paper:followups';
const coinKey = (mint: string) => `history:coin:${mint}`;
const keepFirst = <T>(items: T[], max: number) => items.filter((_, i, all) => i === 0 || i > all.length - max);

export function briefOf(coin: CoinHistory): HistoryBrief {
  const first = coin.scans[0]!;
  const previous = coin.scans.length >= 2 ? coin.scans[coin.scans.length - 2] : undefined;
  return {
    ...(coin.deadAtOpen ? { deadAtOpen: coin.deadAtOpen.reason } : {}),
    count: coin.scans.length,
    first: { at: first.at, score: first.score },
    ...(previous ? { previous: { at: previous.at, score: previous.score } } : {}),
  };
}

function paperSummary(coin: CoinHistory): PaperSummary | undefined {
  const paper = coin.paper;
  const outcome = coinOutcome(coin);
  if (!paper || !outcome) return undefined;
  return {
    ...(paper.latest.bought ? { bought: paper.latest.bought } : {}),
    ...(outcome.pnl ? { pnl: outcome.pnl } : {}),
    ...(outcome.pnlPct !== undefined ? { pnlPct: outcome.pnlPct } : {}),
    open: outcome.open,
    firstAt: paper.firstAt,
    ...(outcome.entry ? { entryScore: outcome.entry.score, entryLevel: outcome.entry.level } : {}),
    ...(outcome.entryAgeSec !== undefined ? { entryAgeSec: outcome.entryAgeSec } : {}),
    market: outcome.market,
    ...(outcome.peakX !== undefined ? { peakX: outcome.peakX } : {}),
    ...(outcome.result ? { result: outcome.result } : {}),
  };
}

function summarize(coin: CoinHistory): CoinSummary {
  const scores = coin.scans.map((s) => s.score);
  const last = coin.scans[coin.scans.length - 1]!;
  const paper = paperSummary(coin);
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
    ...(paper ? { paper } : {}),
    ...(coin.deadAtOpen ? { deadAtOpen: coin.deadAtOpen.reason } : {}),
  };
}

/** Date de création à retenir : une date exacte l'emporte sur une borne. */
function creation(coin: Pick<CoinHistory, 'createdAt' | 'createdExact'>, seen?: { createdAt: number; exact: boolean }) {
  if (!seen) return coin.createdAt === undefined ? {} : { createdAt: coin.createdAt, createdExact: coin.createdExact ?? false };
  if (coin.createdAt === undefined || (seen.exact && !coin.createdExact)) return { createdAt: seen.createdAt, createdExact: seen.exact };
  if (!seen.exact && !coin.createdExact) return { createdAt: Math.min(coin.createdAt, seen.createdAt), createdExact: false };
  return { createdAt: coin.createdAt, createdExact: coin.createdExact ?? false };
}

const ageOf = (coin: Pick<CoinHistory, 'createdAt'>, at: number) => (coin.createdAt === undefined ? undefined : Math.max(0, (at - coin.createdAt) / 1000));

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
      let coin: CoinHistory = existing
        ? {
            ...existing,
            name: snapshot.name ?? existing.name,
            symbol: snapshot.symbol ?? existing.symbol,
            lastSeen: snapshot.point.at,
            ...creation(existing, snapshot.detail.tokenAge),
            // La première analyse est toujours gardée : c'est la référence de l'évolution.
            scans: keepFirst([...existing.scans, snapshot.point], MAX_SCANS_PER_COIN),
            latest: snapshot.detail,
          }
        : {
            mint: snapshot.mint,
            ...(snapshot.name ? { name: snapshot.name } : {}),
            ...(snapshot.symbol ? { symbol: snapshot.symbol } : {}),
            firstSeen: snapshot.point.at,
            lastSeen: snapshot.point.at,
            ...creation({}, snapshot.detail.tokenAge),
            scans: [snapshot.point],
            latest: snapshot.detail,
          };
      // Première ouverture d'un token déjà mort : marqué, pour l'exclure des statistiques.
      const dead = existing ? undefined : alreadyRugged(snapshot.point);
      if (dead) coin = { ...coin, deadAtOpen: { at: snapshot.point.at, reason: dead } };
      // Analyse lancée par un achat paper : rattachée à cet achat (données exactes du moment du IN).
      if (snapshot.point.trigger === 'entrée' && coin.paper) {
        const trades = [...coin.paper.trades];
        const index = trades.map((t) => t.kind === 'achat' && !t.scan).lastIndexOf(true);
        if (index >= 0) {
          trades[index] = { ...trades[index]!, scan: snapshot.point };
          coin = { ...coin, paper: { ...coin.paper, trades, ...(coin.paper.entryDetail ? {} : { entryDetail: snapshot.detail }) } };
        }
      }

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

  /**
   * Position DryFlip lue sur la page. Renvoie ce qui s'est passé : premier achat
   * ou renfort (`buy`, qui déclenche une analyse d'entrée), vente, fermeture.
   * Sans effet si le token n'a pas encore été analysé (`known` = false).
   * `vanished` : la position a disparu du widget, ce qui vaut vente totale.
   */
  attachPaper(
    mint: string,
    reading: PaperPosition,
    options: { at?: number; observed?: boolean; vanished?: boolean; manual?: boolean } = {},
  ): Promise<{ known: boolean; buy: boolean; firstBuy: boolean; sell: boolean; closed: boolean }> {
    const at = options.at ?? Date.now();
    return this.exclusive(async () => {
      const none = { known: false, buy: false, firstBuy: false, sell: false, closed: false };
      const key = coinKey(mint);
      const data = await this.store.get([key, INDEX_KEY]);
      const coin = data[key] as CoinHistory | undefined;
      if (!coin) return none;
      const prev = coin.paper;
      const before = prev?.latest;
      let position = reading;
      if (options.vanished) {
        if (!prev || !before || prev.closedAt !== undefined) return { ...none, known: true };
        // Dernières valeurs affichées (celles du widget, plus fraîches que la dernière écriture), position soldée.
        const { at: _seen, ...last } = before;
        const shown = reading.bought || reading.sold ? reading : last;
        position = { ...shown, remainingPct: 0, remaining: { value: 0, unit: shown.remaining?.unit ?? shown.bought?.unit ?? '' } };
      }
      if (prev && !options.vanished && positionKey(before) === positionKey(position) && at - prev.lastAt < PAPER_POINT_MS) return { ...none, known: true };

      // Position « disparue » qui revient telle quelle peu après : le widget s'était seulement redessiné.
      const lastTrade = prev?.trades[prev.trades.length - 1];
      if (prev && lastTrade?.vanished && !lastTrade.manual && !options.vanished && at - lastTrade.at < 60_000 && tradeKey(position) === tradeKey({ bought: lastTrade.bought, sold: lastTrade.sold })) {
        const { closedAt: _closed, ...open } = prev;
        const restored: CoinHistory = { ...coin, paper: { ...open, trades: prev.trades.slice(0, -1), latest: { at, ...position }, lastAt: at } };
        const index = (Array.isArray(data[INDEX_KEY]) ? (data[INDEX_KEY] as CoinSummary[]) : []).map((c) => (c.mint === mint ? summarize(restored) : c));
        await this.store.set({ [key]: restored, [INDEX_KEY]: index });
        return { ...none, known: true };
      }

      // Nouvelle position sur un token déjà soldé : c'est un nouvel achat, même pour un montant plus petit.
      const reopened = prev?.closedAt !== undefined && !options.vanished && !isClosed(position) && tradeKey(before) !== tradeKey(position);
      const buy = !options.vanished && (isNewBuy(before, position) || reopened);
      const sell = options.vanished === true || ((position.sold?.value ?? 0) > (before?.sold?.value ?? 0) + 1e-9 && tradeKey(before) !== tradeKey(position));
      const closes = options.vanished === true || isClosed(position);
      const trade = (kind: PaperTrade['kind']): PaperTrade => {
        const age = ageOf(coin, at);
        return {
          at,
          kind,
          observed: options.observed ?? false,
          ...(position.bought ? { bought: position.bought } : {}),
          ...(position.sold ? { sold: position.sold } : {}),
          ...(position.pnl ? { pnl: position.pnl } : {}),
          ...(position.pnlPct !== undefined ? { pnlPct: position.pnlPct } : {}),
          ...(age !== undefined ? { tokenAgeSec: age } : {}),
          ...(kind === 'vente' && closes ? { closes: true } : {}),
          ...(kind === 'vente' && options.vanished ? { vanished: true } : {}),
          ...(kind === 'vente' && options.manual ? { manual: true } : {}),
        };
      };
      const trades = [...(prev?.trades ?? [])];
      if (buy) trades.push(trade('achat'));
      if (sell) trades.push(trade('vente'));

      const point: PaperPoint = { at, ...position };
      const points = [...(prev?.points ?? [])];
      const lastPoint = points[points.length - 1];
      if (buy || sell || !lastPoint || at - lastPoint.at >= PAPER_POINT_MS) points.push(point);
      // Une position soldée le reste tant qu'aucun nouvel achat n'a lieu (le widget peut encore l'afficher).
      const closedAt = closes ? (prev?.closedAt !== undefined && !reopened ? prev.closedAt : at) : reopened || buy ? undefined : prev?.closedAt;
      const paper: CoinPaper = {
        source: 'DryFlip',
        firstAt: prev?.firstAt ?? at,
        lastAt: at,
        trades,
        ...(prev?.entryDetail ? { entryDetail: prev.entryDetail } : {}),
        latest: point,
        points: keepFirst(points, MAX_PAPER_POINTS),
        ...(closedAt !== undefined ? { closedAt } : {}),
      };
      const updated: CoinHistory = { ...coin, paper };
      const index = (Array.isArray(data[INDEX_KEY]) ? (data[INDEX_KEY] as CoinSummary[]) : []).map((c) => (c.mint === mint ? summarize(updated) : c));
      await this.store.set({ [key]: updated, [INDEX_KEY]: index });
      return { known: true, buy, firstBuy: buy && !(prev?.trades.some((t) => t.kind === 'achat' && t.bought && t.bought.value > 0) ?? false), sell, closed: closes && prev?.closedAt === undefined };
    });
  }

  /** Solde du portefeuille DryFlip (un point par minute au plus, ou à chaque variation après une minute). */
  setWallet(wallet: PaperWallet, at = Date.now()): Promise<void> {
    return this.exclusive(async () => {
      const current = (await this.store.get([WALLET_KEY]))[WALLET_KEY] as WalletHistory | undefined;
      const points = [...(current?.points ?? [])];
      const last = points[points.length - 1];
      if (wallet.balance && (!last || (at - last.at >= 60_000 && last.balance.value !== wallet.balance.value))) points.push({ at, balance: wallet.balance });
      await this.store.set({ [WALLET_KEY]: { latest: { ...wallet, at }, points: keepFirst(points, 2_000) } satisfies WalletHistory });
    });
  }

  async wallet(): Promise<WalletHistory | null> {
    return ((await this.store.get([WALLET_KEY]))[WALLET_KEY] as WalletHistory | undefined) ?? null;
  }

  /** Programme les ré-analyses qui diront si le token a « run » ou « rug » après l'achat. */
  scheduleFollowUps(mint: string, from: number): Promise<void> {
    return this.exclusive(async () => {
      const list = ((await this.store.get([FOLLOW_UPS_KEY]))[FOLLOW_UPS_KEY] as FollowUp[] | undefined) ?? [];
      const others = list.filter((f) => f.mint !== mint);
      const next = FOLLOW_UP_DELAYS_MS.map((delay, step) => ({ mint, due: from + delay, step, attempts: 0 }));
      await this.store.set({ [FOLLOW_UPS_KEY]: [...others, ...next] });
    });
  }

  async followUps(): Promise<FollowUp[]> {
    return ((await this.store.get([FOLLOW_UPS_KEY]))[FOLLOW_UPS_KEY] as FollowUp[] | undefined) ?? [];
  }

  /** Ré-analyse faite (retirée) ou échouée (reprogrammée, abandonnée au bout de 3 essais). */
  settleFollowUp(item: FollowUp, ok: boolean, now = Date.now()): Promise<void> {
    return this.exclusive(async () => {
      const list = ((await this.store.get([FOLLOW_UPS_KEY]))[FOLLOW_UPS_KEY] as FollowUp[] | undefined) ?? [];
      const rest = list.filter((f) => !(f.mint === item.mint && f.step === item.step));
      if (!ok && item.attempts + 1 < FOLLOW_UP_MAX_ATTEMPTS) rest.push({ ...item, attempts: item.attempts + 1, due: now + FOLLOW_UP_RETRY_MS });
      await this.store.set({ [FOLLOW_UPS_KEY]: rest });
    });
  }

  /** Plusieurs tokens d'un coup (page d'analyse). */
  async getMany(mints: string[]): Promise<CoinHistory[]> {
    if (mints.length === 0) return [];
    const data = await this.store.get(mints.map(coinKey));
    return mints.map((m) => data[coinKey(m)] as CoinHistory | undefined).filter((c): c is CoinHistory => Boolean(c));
  }

  remove(mint: string): Promise<void> {
    return this.exclusive(async () => {
      const index = (await this.index()).filter((c) => c.mint !== mint);
      await this.store.set({ [INDEX_KEY]: index });
      await this.store.remove([coinKey(mint)]);
      const followUps = ((await this.store.get([FOLLOW_UPS_KEY]))[FOLLOW_UPS_KEY] as FollowUp[] | undefined) ?? [];
      if (followUps.some((f) => f.mint === mint)) await this.store.set({ [FOLLOW_UPS_KEY]: followUps.filter((f) => f.mint !== mint) });
    });
  }

  clear(): Promise<void> {
    return this.exclusive(async () => {
      const index = await this.index();
      await this.store.remove([INDEX_KEY, WALLET_KEY, FOLLOW_UPS_KEY, ...index.map((c) => coinKey(c.mint))]);
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
