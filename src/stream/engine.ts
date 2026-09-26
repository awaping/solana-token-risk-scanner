/**
 * Moteur temps réel du mode stream.
 *
 * Reçoit les transactions Pump.fun de une ou plusieurs sources (première
 * arrivée gagnante), décode les événements depuis les logs et maintient
 * l'état de chaque token récemment lancé :
 *
 *   T0      verdict immédiat à la création (aucune requête réseau)
 *   T1      verdict après la fenêtre de bundle (N premiers slots)
 *   T2      verdict après enrichissement RPC de l'historique du créateur
 *   ACTIF   le token franchit le seuil d'activité (nombre de trades)
 *   ALERTE  vente du dev pendant la période de suivi

 * L'activité (holders exacts, trades, volume, capitalisation) est reconstruite
 * en continu à partir des TradeEvent : aucun appel RPC n'est nécessaire.
 *
 * Tout le chemin critique (réception → verdict T0) est synchrone et en mémoire.
 */
import { EventEmitter } from 'node:events';
import bs58 from 'bs58';
import { PUMP_FUN } from '../constants.js';
import { bondingCurvePda } from '../analyzers/pumpfun.js';
import { PublicKey } from '@solana/web3.js';
import { parsePumpLogs, type CreateEvent, type PumpEvent, type TradeEvent } from './events.js';
import {
  computeBundleStats,
  computeFastScore,
  type BundleStats,
  type CreatorSnapshot,
  type FastVerdict,
  type TradeRecord,
} from './fast-score.js';
import { applyTrade, concentration, newActivity, type ActivityState, type Concentration } from './activity.js';
import type { ReputationStore } from './reputation.js';
import type { StreamTx } from './sources/types.js';
import { sanitizeLabel } from '../utils/format.js';

export type Phase = 'T0' | 'T1' | 'T2' | 'ACTIF' | 'ALERTE';

export interface TokenState {
  mint: string;
  mintKey: string;
  name: string;
  symbol: string;
  uri: string;
  creator: string;
  bondingCurve: string;
  createSignature: string;
  createSlot: number;
  source: string;
  /** Réception brute de la transaction de création (hrtime, ns). */
  receivedAt: bigint;
  detectedAtMs: number;
  /** Retard de réception en slots par rapport au slot le plus récent vu. */
  lagSlots: number;
  devWallets: Set<string>;
  /** Clés brutes (base64) des wallets du dev, calculées à la demande. */
  devKeys?: Set<string>;
  /** Achats/ventes de la fenêtre de bundle. */
  trades: TradeRecord[];
  /** Activité reconstruite depuis tous les trades observés. */
  activity: ActivityState;
  /** Le seuil d'activité a été franchi (phase ACTIF émise). */
  active: boolean;
  devBuyTokens: bigint;
  devSold: boolean;
  copycatOf?: string;
  supply: bigint;
  bundle?: BundleStats;
  verdict?: FastVerdict;
  t1Done: boolean;
  graduated: boolean;
  /** Création retrouvée via RPC (logs tronqués). */
  viaRpcFallback: boolean;
}

export interface VerdictEvent {
  phase: Phase;
  token: TokenState;
  verdict: FastVerdict;
  previousScore?: number;
  /** Réception brute → verdict, en microsecondes (T0 et T1 déclenchés par un événement). */
  decisionMicros?: number;
}

export interface EngineOptions {
  /** Nombre de slots de la fenêtre de bundle (slot de création inclus). */
  bundleSlots: number;
  /** Durée de suivi d'un token après sa création (s). */
  trackSeconds: number;
  reputation: ReputationStore;
  /** Enrichissement RPC asynchrone de l'historique d'un créateur. */
  enrich?: (creator: string, mint: string) => Promise<NonNullable<CreatorSnapshot['enrichment']>>;
  /** Retrouve une création dont l'événement manque (logs tronqués). */
  resolveMissingCreate?: (signature: string) => Promise<{ mint: string; creator: string } | null>;
  /** Seuil de la phase ACTIF, en nombre de trades (défaut 15). */
  activity?: { minTrades: number };
  /** Un token jamais devenu actif est oublié après ce délai sans trade (s, défaut 300). */
  inactiveTtlSeconds?: number;
  now?: () => number;
}

const SLOT_MS = 400;
const ORPHAN_TTL_MS = 3_000;
const COPYCAT_WINDOW_MS = 30 * 60_000;
const RACE_CAPACITY = 50_000;
/** Pause de l'enrichissement quand le RPC renvoie 429 (protège le flux, qui passe par la même IP). */
const ENRICH_PAUSE_MS = 60_000;
/** Enrichissements en cours au maximum : au-delà, les nouveaux créateurs sont ignorés. */
const ENRICH_MAX_PENDING = 8;
const RATE_LIMITED = /\b429\b|too many requests|rate.?limit/i;
const LATENCY_SAMPLES = 4096;

/** Déduplication multi-sources : la première source à livrer une signature gagne. */
export class SignatureRace {
  private readonly firstSeen = new Map<string, { source: string; at: bigint }>();
  readonly wins = new Map<string, number>();
  readonly lag = new Map<string, { totalNs: bigint; count: number }>();

  constructor(private readonly capacity = RACE_CAPACITY) {}

  /** Vrai si c'est la première arrivée de cette signature (ou clé d'événement). */
  observe(tx: Pick<StreamTx, 'signature' | 'source' | 'receivedAt'>): boolean {
    const previous = this.firstSeen.get(tx.signature);
    if (previous) {
      if (previous.source !== tx.source) {
        const stat = this.lag.get(tx.source) ?? { totalNs: 0n, count: 0 };
        stat.totalNs += tx.receivedAt - previous.at;
        stat.count++;
        this.lag.set(tx.source, stat);
      }
      return false;
    }
    this.firstSeen.set(tx.signature, { source: tx.source, at: tx.receivedAt });
    this.wins.set(tx.source, (this.wins.get(tx.source) ?? 0) + 1);
    if (this.firstSeen.size > this.capacity) {
      const oldest = this.firstSeen.keys().next().value;
      if (oldest !== undefined) this.firstSeen.delete(oldest);
    }
    return true;
  }
}

export interface EngineStats {
  txReceived: number;
  txDuplicates: number;
  txFailed: number;
  creates: number;
  trackedTrades: number;
  truncatedCreates: number;
  tracked: number;
  /** Tokens suivis ayant franchi le seuil d'activité. */
  active: number;
  tipSlot: number;
  latency: { p50: number; p99: number; max: number; samples: number };
  wins: Record<string, number>;
  lagMs: Record<string, number>;
}

export class StreamEngine extends EventEmitter<{ verdict: [VerdictEvent]; status: [string, 'info' | 'warn'] }> {
  readonly race = new SignatureRace();
  private readonly tokens = new Map<string, TokenState>();
  /** Index par clé brute du mint (base64) : recherche sans encodage base58. */
  private readonly tokensByKey = new Map<string, TokenState>();
  private readonly pendingT1 = new Set<TokenState>();
  private readonly t1Timers = new Map<string, NodeJS.Timeout>();
  /** Trades reçus avant la création de leur token, indexés par clé brute du mint. */
  private readonly orphans = new Map<string, { at: number; items: Array<{ event: TradeEvent; tx: StreamTx }> }>();
  private readonly recentSymbols = new Map<string, { mint: string; at: number }>();
  private readonly enriching = new Set<string>();
  private enrichPausedUntil = 0;
  private enrichErrors = 0;
  private enrichErrorReportedAt = Number.NEGATIVE_INFINITY;
  private readonly latencies = new Float64Array(LATENCY_SAMPLES);
  private latencyCount = 0;
  private cleanupTimer?: NodeJS.Timeout;
  private readonly now: () => number;
  private tipSlot = 0;
  private counters = { txReceived: 0, txDuplicates: 0, txFailed: 0, creates: 0, trackedTrades: 0, truncatedCreates: 0 };
  private readonly minTrades: number;

  constructor(private readonly opts: EngineOptions) {
    super();
    this.now = opts.now ?? Date.now;
    this.minTrades = opts.activity?.minTrades ?? 15;
  }

  start(): void {
    this.cleanupTimer = setInterval(() => this.cleanup(), 1_000);
    this.cleanupTimer.unref();
  }

  stop(): void {
    clearInterval(this.cleanupTimer);
    for (const timer of this.t1Timers.values()) clearTimeout(timer);
    this.t1Timers.clear();
  }

  getToken(mint: string): TokenState | undefined {
    return this.tokens.get(mint);
  }

  /** Tokens actuellement suivis (pour le classement). */
  trackedTokens(): TokenState[] {
    return [...this.tokens.values()];
  }

  /** Recalcule le verdict d'un token sans émettre d'événement (tableau de bord). */
  rescore(token: TokenState): FastVerdict {
    token.verdict = this.score(token);
    return token.verdict;
  }

  /** Concentration réelle d'un token (top 1 / top 10 / part du dev). */
  concentrationOf(token: TokenState): Concentration {
    return concentration(token.activity, token.supply, this.devKeys(token));
  }

  /** Clés brutes des wallets du dev (même format que les clés de soldes). */
  private devKeys(token: TokenState): Set<string> {
    return (token.devKeys ??= new Set([...token.devWallets].map((w) => Buffer.from(bs58.decode(w)).toString('base64'))));
  }

  // -------------------------------------------------------------------------
  // Chemin critique
  // -------------------------------------------------------------------------

  /** Point d'entrée de toutes les sources. Synchrone : aucune attente réseau. */
  handleTx(tx: StreamTx): void {
    if (!this.race.observe(tx)) {
      this.counters.txDuplicates++;
      return;
    }
    this.counters.txReceived++;
    const newSlot = tx.slot > this.tipSlot;
    if (newSlot) this.tipSlot = tx.slot;
    if (tx.failed) {
      this.counters.txFailed++;
      if (newSlot && this.pendingT1.size > 0) this.checkBundleWindows();
      return;
    }

    const parsed = parsePumpLogs(tx.logs);
    let sawCreateEvent = false;
    for (const event of parsed.events) {
      if (event.kind === 'create') {
        sawCreateEvent = true;
        this.onCreate(event, tx, parsed.events, false);
      }
    }
    for (const event of parsed.events) {
      if (event.kind === 'trade') this.onTrade(event, tx);
      else if (event.kind === 'complete') {
        const token = this.tokens.get(event.mint);
        if (token) token.graduated = true;
      }
    }
    if (parsed.sawCreate && !sawCreateEvent) this.onMissingCreate(tx);
    // Les fenêtres de bundle des tokens précédents sont clôturées APRÈS le
    // traitement de ce message : une création n'attend jamais un calcul T1.
    if (newSlot && this.pendingT1.size > 0) this.checkBundleWindows();
  }

  private score(token: TokenState): FastVerdict {
    const supply = token.supply;
    const devBuyPct = supply === 0n ? 0 : Number((token.devBuyTokens * 1_000_000n) / supply) / 10_000;
    return computeFastScore({
      creator: this.opts.reputation.snapshot(token.creator, this.now()),
      devBuyPct,
      bundle: token.bundle,
      devSold: token.devSold,
      copycatOf: token.copycatOf,
      concentration: token.activity.holders >= 5 ? concentration(token.activity, supply, this.devKeys(token)) : undefined,
    });
  }

  private emitVerdict(phase: Phase, token: TokenState, decisionFrom?: bigint): void {
    const previousScore = token.verdict?.score;
    const verdict = this.score(token);
    token.verdict = verdict;
    let decisionMicros: number | undefined;
    if (decisionFrom !== undefined) {
      decisionMicros = Number(process.hrtime.bigint() - decisionFrom) / 1_000;
      this.latencies[this.latencyCount % LATENCY_SAMPLES] = decisionMicros;
      this.latencyCount++;
    }
    this.emit('verdict', { phase, token, verdict, previousScore, decisionMicros });
  }

  private onCreate(event: CreateEvent, tx: StreamTx, sameTxEvents: readonly PumpEvent[], viaRpcFallback: boolean): void {
    if (this.tokens.has(event.mint)) return;
    const now = this.now();
    this.counters.creates++;
    const devWallets = new Set([event.user, event.creator]);
    this.opts.reputation.recordLaunch(event.creator, event.mint, now);

    let devBuyTokens = 0n;
    for (const e of sameTxEvents) {
      if (e.kind === 'trade' && e.mint === event.mint && e.isBuy && devWallets.has(e.user)) devBuyTokens += e.tokenAmount;
    }

    // Nom et symbole choisis par le créateur : nettoyés avant tout affichage.
    const name = sanitizeLabel(event.name);
    const symbol = sanitizeLabel(event.symbol);
    const symbolKey = symbol.toUpperCase();
    const previous = symbolKey ? this.recentSymbols.get(symbolKey) : undefined;
    const copycatOf = previous && previous.mint !== event.mint && now - previous.at < COPYCAT_WINDOW_MS ? previous.mint : undefined;
    if (symbolKey) this.recentSymbols.set(symbolKey, { mint: event.mint, at: now });

    const token: TokenState = {
      mint: event.mint,
      mintKey: event.mintKey,
      name,
      symbol,
      uri: event.uri,
      creator: event.creator,
      bondingCurve: event.bondingCurve,
      createSignature: tx.signature,
      createSlot: tx.slot,
      source: tx.source,
      receivedAt: tx.receivedAt,
      detectedAtMs: now,
      lagSlots: Math.max(0, this.tipSlot - tx.slot),
      devWallets,
      trades: [],
      activity: newActivity(),
      active: false,
      devBuyTokens,
      devSold: false,
      copycatOf,
      supply: event.tokenTotalSupply && event.tokenTotalSupply > 0n ? event.tokenTotalSupply : PUMP_FUN.TOKEN_TOTAL_SUPPLY,
      t1Done: false,
      graduated: false,
      viaRpcFallback,
    };
    this.tokens.set(token.mint, token);
    this.tokensByKey.set(token.mintKey, token);

    this.emitVerdict('T0', token, tx.receivedAt);

    // Trades reçus avant la création (autre source plus rapide, ou logs tronqués).
    const orphans = this.orphans.get(token.mintKey);
    if (orphans) {
      this.orphans.delete(token.mintKey);
      for (const { event: orphan, tx: orphanTx } of orphans.items) this.onTrade(orphan, orphanTx);
    }

    this.pendingT1.add(token);
    const fallbackMs = (this.opts.bundleSlots + 1) * SLOT_MS + SLOT_MS;
    const timer = setTimeout(() => this.finalizeT1(token), fallbackMs);
    timer.unref();
    this.t1Timers.set(token.mint, timer);
    this.maybeEnrich(token.creator, token.mint);
  }

  private onTrade(event: TradeEvent, tx: StreamTx): void {
    const token = this.tokensByKey.get(event.mintKey);
    if (!token) {
      // Token non suivi (cas le plus fréquent) : mis de côté quelques secondes au
      // cas où sa création arriverait par une autre source, puis oublié.
      this.bufferOrphan(event.mintKey, event, tx);
      return;
    }
    this.counters.trackedTrades++;
    applyTrade(token.activity, event, this.now());

    if (tx.slot < token.createSlot + this.opts.bundleSlots) {
      token.trades.push({
        signature: tx.signature,
        slot: tx.slot,
        user: event.user,
        isBuy: event.isBuy,
        solAmount: event.solAmount,
        tokenAmount: event.tokenAmount,
      });
    }

    if (!event.isBuy && !token.devSold && this.devKeys(token).has(event.userKey)) {
      token.devSold = true;
      this.emitVerdict('ALERTE', token, tx.receivedAt);
      // Enregistré après le verdict : cette vente pèsera sur les PROCHAINS tokens du créateur.
      this.opts.reputation.recordDevSell(token.creator);
    }

    const a = token.activity;
    // Seul le nombre de trades compte : le nombre de holders se gonfle trop facilement
    // (achats répartis sur des wallets jetables) pour servir de critère.
    if (!token.active && a.trades >= this.minTrades) {
      token.active = true;
      this.emitVerdict('ACTIF', token, tx.receivedAt);
    }
  }

  private bufferOrphan(mintKey: string, event: TradeEvent, tx: StreamTx): void {
    const entry = this.orphans.get(mintKey);
    if (entry) {
      if (entry.items.length < 200) entry.items.push({ event, tx });
    } else {
      this.orphans.set(mintKey, { at: this.now(), items: [{ event, tx }] });
    }
  }

  private checkBundleWindows(): void {
    for (const token of this.pendingT1) {
      if (this.tipSlot >= token.createSlot + this.opts.bundleSlots) this.finalizeT1(token);
    }
  }

  private finalizeT1(token: TokenState): void {
    if (token.t1Done) return;
    token.t1Done = true;
    this.pendingT1.delete(token);
    clearTimeout(this.t1Timers.get(token.mint));
    this.t1Timers.delete(token.mint);
    token.bundle = computeBundleStats(token.trades, token.createSlot, this.opts.bundleSlots, token.devWallets, token.supply);
    this.emitVerdict('T1', token);
  }

  // -------------------------------------------------------------------------
  // Hors chemin critique (asynchrone)
  // -------------------------------------------------------------------------

  private maybeEnrich(creator: string, mint: string): void {
    const { enrich, reputation } = this.opts;
    if (!enrich || this.enriching.has(creator) || this.enriching.size >= ENRICH_MAX_PENDING) return;
    if (this.now() < this.enrichPausedUntil || !reputation.needsEnrichment(creator, this.now())) return;
    this.enriching.add(creator);
    enrich(creator, mint)
      .then((data) => {
        reputation.setEnrichment(creator, data, this.now());
        for (const token of this.tokens.values()) {
          if (token.creator === creator) this.emitVerdict('T2', token);
        }
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        const now = this.now();
        if (RATE_LIMITED.test(message)) {
          if (now >= this.enrichPausedUntil) {
            this.emit('status', `RPC saturé (429) : enrichissement des créateurs suspendu ${ENRICH_PAUSE_MS / 1000} s pour préserver le flux`, 'warn');
          }
          this.enrichPausedUntil = now + ENRICH_PAUSE_MS;
          return;
        }
        // Autres erreurs : regroupées, au plus un message par minute.
        this.enrichErrors++;
        if (now - this.enrichErrorReportedAt >= 60_000) {
          this.emit('status', `enrichissement impossible (${this.enrichErrors} échec${this.enrichErrors > 1 ? 's' : ''}) : ${message.slice(0, 120)}`, 'warn');
          this.enrichErrors = 0;
          this.enrichErrorReportedAt = now;
        }
      })
      .finally(() => this.enriching.delete(creator));
  }

  private onMissingCreate(tx: StreamTx): void {
    this.counters.truncatedCreates++;
    const resolve = this.opts.resolveMissingCreate;
    if (!resolve) return;
    resolve(tx.signature)
      .then((found) => {
        if (!found) return;
        const mintKey = new PublicKey(found.mint).toBuffer().toString('base64');
        const event: CreateEvent = {
          kind: 'create',
          mintKey,
          name: '?',
          symbol: '',
          uri: '',
          mint: found.mint,
          bondingCurve: bondingCurvePda(new PublicKey(found.mint)).toBase58(),
          user: found.creator,
          creator: found.creator,
        };
        this.onCreate(event, tx, [], true);
      })
      .catch(() => undefined);
  }

  private cleanup(): void {
    const now = this.now();
    const maxAge = this.opts.trackSeconds * 1_000;
    const inactiveTtl = (this.opts.inactiveTtlSeconds ?? 300) * 1_000;
    for (const [mint, token] of this.tokens) {
      const lastActivity = Math.max(token.detectedAtMs, token.activity.lastTradeAt);
      if (now - token.detectedAtMs > maxAge || (!token.active && now - lastActivity > inactiveTtl)) {
        this.tokens.delete(mint);
        this.tokensByKey.delete(token.mintKey);
        this.pendingT1.delete(token);
      }
    }
    for (const [mint, entry] of this.orphans) if (now - entry.at > ORPHAN_TTL_MS) this.orphans.delete(mint);
    for (const [symbol, entry] of this.recentSymbols) if (now - entry.at > COPYCAT_WINDOW_MS) this.recentSymbols.delete(symbol);
  }

  stats(): EngineStats {
    const n = Math.min(this.latencyCount, LATENCY_SAMPLES);
    const sorted = Array.from(this.latencies.subarray(0, n)).sort((a, b) => a - b);
    const pick = (q: number) => (n === 0 ? 0 : sorted[Math.min(n - 1, Math.floor(q * n))]!);
    const lagMs: Record<string, number> = {};
    for (const [source, stat] of this.race.lag) lagMs[source] = stat.count ? Number(stat.totalNs / BigInt(stat.count)) / 1e6 : 0;
    return {
      ...this.counters,
      tracked: this.tokens.size,
      active: [...this.tokens.values()].filter((t) => t.active).length,
      tipSlot: this.tipSlot,
      latency: { p50: pick(0.5), p99: pick(0.99), max: n ? sorted[n - 1]! : 0, samples: this.latencyCount },
      wins: Object.fromEntries(this.race.wins),
      lagMs,
    };
  }
}
