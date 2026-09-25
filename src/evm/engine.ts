/**
 * Moteur temps réel EVM : détecte les tokens qui obtiennent une pool sur un
 * DEX, suit leur activité à partir des swaps et évalue leur risque.
 *
 *   T0      nouvelle pool détectée (aucune requête réseau)
 *   ACTIF   seuil de trades franchi → le token entre au classement, audit lancé
 *   T1      audit du contrat terminé (propriétaire, fonctions dangereuses, créateur, liquidité)
 *   ALERTE  le dev vend, ou la liquidité est retirée
 *
 * La devise de cotation d'une pool (WETH, WBNB, USDC…) est reconnue grâce au
 * wrapped natif de la chaîne, puis apprise : un token présent dans plusieurs
 * pools récentes est considéré comme une devise, l'autre côté comme le token lancé.
 */
import { EventEmitter } from 'node:events';
import type { PublicClient } from 'viem';
import { dexLabel, type EvmChain } from '../chains/registry.js';
import { createLimiter } from '../rpc/client.js';
import { SignatureRace, type Phase } from '../stream/engine.js';
import type { FastVerdict } from '../stream/fast-score.js';
import type { ReputationStore } from '../stream/reputation.js';
import { auditToken, refreshToken, type EvmTokenAudit } from './audit.js';
import { decodeEvmLog, ZERO_ADDRESS, type EvmLog, type PoolCreated } from './events.js';
import { computeEvmScore } from './score.js';

const MINUTE_MS = 60_000;
/** Nombre de pools dans lesquelles un token doit apparaître pour être considéré comme devise de cotation. */
const QUOTE_LEARN_THRESHOLD = 3;
const LATENCY_SAMPLES = 4096;

export interface EvmActivity {
  trades: number;
  buys: number;
  sells: number;
  /** Volume échangé en devise de cotation (unités brutes). */
  volumeRaw: bigint;
  recent: number[];
  lastTradeAt: number;
  /** Derniers montants absolus échangés (pour le prix spot). */
  lastQuoteRaw: bigint;
  lastTokenRaw: bigint;
}

export interface EvmTokenState {
  address: string;
  pool: PoolCreated;
  dexName: string;
  quote: string;
  tokenIs0: boolean;
  creationTx: string;
  creationBlock: number;
  source: string;
  receivedAt: bigint;
  detectedAtMs: number;
  activity: EvmActivity;
  audit?: EvmTokenAudit;
  auditPending: boolean;
  auditError?: string;
  currentDevBalance?: bigint;
  maxDevBalance?: bigint;
  liquidity?: number;
  maxLiquidity?: number;
  devSold: boolean;
  liquidityPulled: boolean;
  active: boolean;
  verdict?: FastVerdict;
}

export interface EvmVerdictEvent {
  phase: Phase;
  token: EvmTokenState;
  verdict: FastVerdict;
  previousScore?: number;
  decisionMicros?: number;
}

export interface EvmEngineOptions {
  chain: EvmChain;
  /** Client RPC pour les audits ; absent → pas d'audit (activité seule). */
  client?: PublicClient;
  reputation: ReputationStore;
  minTrades: number;
  trackSeconds: number;
  inactiveTtlSeconds?: number;
  /** Auditer chaque nouvelle pool dès sa création (sinon : seulement les tokens ACTIFS). */
  auditAll?: boolean;
  auditConcurrency?: number;
  /** Relecture du solde du dev et de la liquidité des tokens actifs (s). */
  refreshSeconds?: number;
  /** Devises de cotation supplémentaires (adresses). */
  quotes?: string[];
  now?: () => number;
}

export interface EvmEngineStats {
  logsReceived: number;
  duplicates: number;
  pools: number;
  tracked: number;
  active: number;
  swaps: number;
  audits: number;
  auditsPending: number;
  tipBlock: number;
  latency: { p50: number; p99: number };
  wins: Record<string, number>;
  lagMs: Record<string, number>;
}

const absBig = (v: bigint) => (v < 0n ? -v : v);

/** Prix spot (devise par token, unités UI) du dernier trade. */
export function evmPrice(token: EvmTokenState): number | undefined {
  const a = token.audit;
  const { lastQuoteRaw, lastTokenRaw } = token.activity;
  if (!a || lastTokenRaw === 0n) return undefined;
  return Number(lastQuoteRaw) / 10 ** a.quote.decimals / (Number(lastTokenRaw) / 10 ** a.decimals);
}

export function evmTradesLastMinute(activity: EvmActivity, now: number): number {
  let i = 0;
  while (i < activity.recent.length && activity.recent[i]! < now - MINUTE_MS) i++;
  if (i > 0) activity.recent.splice(0, i);
  return activity.recent.length;
}

export class EvmStreamEngine extends EventEmitter<{ verdict: [EvmVerdictEvent]; status: [string, 'info' | 'warn'] }> {
  readonly race = new SignatureRace();
  private readonly tokens = new Map<string, EvmTokenState>();
  private readonly pools = new Map<string, EvmTokenState>();
  private readonly quoteScores = new Map<string, number>();
  private readonly limitAudit: ReturnType<typeof createLimiter>;
  private readonly latencies = new Float64Array(LATENCY_SAMPLES);
  private latencyCount = 0;
  private cleanupTimer?: NodeJS.Timeout;
  private refreshTimer?: NodeJS.Timeout;
  private readonly now: () => number;
  private tipBlock = 0;
  private counters = { logsReceived: 0, duplicates: 0, pools: 0, swaps: 0, audits: 0 };

  constructor(private readonly opts: EvmEngineOptions) {
    super();
    this.now = opts.now ?? Date.now;
    this.limitAudit = createLimiter(opts.auditConcurrency ?? 4);
    // Devises connues d'office : natif (pools v4 en ETH natif), wrapped natif, devises fournies.
    const seeds = [ZERO_ADDRESS, opts.chain.wrappedNative?.address, ...(opts.quotes ?? [])];
    for (const q of seeds) if (q) this.quoteScores.set(q.toLowerCase(), Number.POSITIVE_INFINITY);
  }

  start(): void {
    this.cleanupTimer = setInterval(() => this.cleanup(), 1_000);
    this.cleanupTimer.unref();
    const refreshMs = (this.opts.refreshSeconds ?? 15) * 1_000;
    this.refreshTimer = setInterval(() => void this.refreshActive(), refreshMs);
    this.refreshTimer.unref();
  }

  stop(): void {
    clearInterval(this.cleanupTimer);
    clearInterval(this.refreshTimer);
  }

  trackedTokens(): EvmTokenState[] {
    return [...this.tokens.values()];
  }

  getToken(address: string): EvmTokenState | undefined {
    return this.tokens.get(address.toLowerCase());
  }

  /** Devises de cotation reconnues (connues ou apprises). */
  isQuote(address: string): boolean {
    return (this.quoteScores.get(address) ?? 0) >= QUOTE_LEARN_THRESHOLD;
  }

  // -------------------------------------------------------------------------
  // Chemin critique
  // -------------------------------------------------------------------------

  handleLog(log: EvmLog): void {
    if (log.removed) return;
    if (!this.race.observe({ signature: `${log.transactionHash}:${log.logIndex}`, source: log.source, receivedAt: log.receivedAt })) {
      this.counters.duplicates++;
      return;
    }
    this.counters.logsReceived++;
    if (log.blockNumber > this.tipBlock) this.tipBlock = log.blockNumber;

    const event = decodeEvmLog(log);
    if (!event) return;
    if (event.kind === 'pool') this.onPool(event, log);
    else this.onSwap(event.poolKey, event.delta0, event.delta1, log);
  }

  /** Identifie le token lancé et sa devise de cotation dans une nouvelle pool. */
  private split(pool: PoolCreated): { token: string; quote: string; tokenIs0: boolean } | null {
    const q0 = this.isQuote(pool.token0);
    const q1 = this.isQuote(pool.token1);
    // Apprentissage : chaque apparition dans une pool renforce le statut de devise.
    for (const t of [pool.token0, pool.token1]) {
      const current = this.quoteScores.get(t) ?? 0;
      if (Number.isFinite(current)) this.quoteScores.set(t, current + 1);
    }
    if (q0 && !q1) return { token: pool.token1, quote: pool.token0, tokenIs0: false };
    if (q1 && !q0) return { token: pool.token0, quote: pool.token1, tokenIs0: true };
    return null; // deux devises (WETH/USDC) ou aucune reconnue pour l'instant
  }

  private onPool(pool: PoolCreated, log: EvmLog): void {
    const side = this.split(pool);
    if (!side) return;
    this.counters.pools++;
    const existing = this.tokens.get(side.token);
    if (existing) {
      // Pool supplémentaire du même token : suivie si elle est cotée dans la même devise.
      if (existing.quote === side.quote) this.pools.set(pool.poolKey, existing);
      return;
    }
    const token: EvmTokenState = {
      address: side.token,
      pool,
      dexName: dexLabel(this.opts.chain, pool.emitter, pool.dex),
      quote: side.quote,
      tokenIs0: side.tokenIs0,
      creationTx: log.transactionHash,
      creationBlock: log.blockNumber,
      source: log.source,
      receivedAt: log.receivedAt,
      detectedAtMs: this.now(),
      activity: { trades: 0, buys: 0, sells: 0, volumeRaw: 0n, recent: [], lastTradeAt: 0, lastQuoteRaw: 0n, lastTokenRaw: 0n },
      auditPending: false,
      devSold: false,
      liquidityPulled: false,
      active: false,
    };
    this.tokens.set(token.address, token);
    this.pools.set(pool.poolKey, token);
    this.emitVerdict('T0', token, log.receivedAt);
    if (this.opts.auditAll) this.scheduleAudit(token);
  }

  private onSwap(poolKey: string, delta0: bigint, delta1: bigint, log: EvmLog): void {
    const token = this.pools.get(poolKey);
    if (!token) return;
    const tokenDelta = token.tokenIs0 ? delta0 : delta1;
    const quoteDelta = token.tokenIs0 ? delta1 : delta0;
    if (tokenDelta === 0n) return;
    this.counters.swaps++;

    const now = this.now();
    const a = token.activity;
    a.trades++;
    // La pool cède des tokens → l'utilisateur achète.
    if (tokenDelta < 0n) a.buys++;
    else a.sells++;
    a.volumeRaw += absBig(quoteDelta);
    a.lastQuoteRaw = absBig(quoteDelta);
    a.lastTokenRaw = absBig(tokenDelta);
    a.lastTradeAt = now;
    a.recent.push(now);
    if (a.recent.length > 5_000 || a.recent[0]! < now - MINUTE_MS) evmTradesLastMinute(a, now);

    if (!token.active && a.trades >= this.opts.minTrades) {
      token.active = true;
      this.emitVerdict('ACTIF', token, log.receivedAt);
      this.scheduleAudit(token);
    }
  }

  // -------------------------------------------------------------------------
  // Score
  // -------------------------------------------------------------------------

  private score(token: EvmTokenState): FastVerdict {
    const a = token.audit;
    const creator = a?.creator;
    const rep = creator ? this.opts.reputation.snapshot(creator, this.now()) : undefined;
    const currentDevPct =
      a && token.currentDevBalance !== undefined && a.totalSupply > 0n
        ? Number((token.currentDevBalance * 1_000_000n) / a.totalSupply) / 10_000
        : undefined;
    return computeEvmScore({
      audit: a,
      creatorLaunches24h: rep?.launches24h ?? 0,
      creatorDevSells: rep?.devSellsSeen ?? 0,
      currentDevPct,
      devSold: token.devSold,
      liquidityPulled: token.liquidityPulled,
      liquidityQuote: token.liquidity,
    });
  }

  rescore(token: EvmTokenState): FastVerdict {
    token.verdict = this.score(token);
    return token.verdict;
  }

  private emitVerdict(phase: Phase, token: EvmTokenState, decisionFrom?: bigint): void {
    const previousScore = token.verdict?.score;
    const verdict = this.rescore(token);
    let decisionMicros: number | undefined;
    if (decisionFrom !== undefined) {
      decisionMicros = Number(process.hrtime.bigint() - decisionFrom) / 1_000;
      this.latencies[this.latencyCount % LATENCY_SAMPLES] = decisionMicros;
      this.latencyCount++;
    }
    this.emit('verdict', { phase, token, verdict, previousScore, decisionMicros });
  }

  // -------------------------------------------------------------------------
  // Audit et surveillance (asynchrones)
  // -------------------------------------------------------------------------

  private scheduleAudit(token: EvmTokenState): void {
    const client = this.opts.client;
    if (!client || token.audit || token.auditPending) return;
    token.auditPending = true;
    void this.limitAudit(() =>
      auditToken(client, this.opts.chain, { token: token.address, quote: token.quote, pool: token.pool, creationTx: token.creationTx }),
    )
      .then((audit) => {
        token.audit = audit;
        token.currentDevBalance = audit.creatorBalance;
        token.maxDevBalance = audit.creatorBalance;
        token.liquidity = audit.liquidityQuote;
        token.maxLiquidity = audit.liquidityQuote;
        this.counters.audits++;
        if (audit.creator) this.opts.reputation.recordLaunch(audit.creator, token.address, this.now());
        this.emitVerdict('T1', token);
      })
      .catch((error: unknown) => {
        token.auditError = error instanceof Error ? error.message : String(error);
        this.emit('status', `audit de ${token.address.slice(0, 10)}… impossible : ${token.auditError}`, 'warn');
      })
      .finally(() => {
        token.auditPending = false;
      });
  }

  /** Relit le solde du dev et la liquidité des tokens actifs audités. */
  async refreshActive(): Promise<void> {
    const client = this.opts.client;
    if (!client) return;
    const targets = [...this.tokens.values()].filter((t) => t.active && t.audit);
    await Promise.all(
      targets.map((token) =>
        this.limitAudit(() => refreshToken(client, this.opts.chain, { token: token.address, pool: token.pool, audit: token.audit! }))
          .then(({ creatorBalance, liquidityQuote }) => this.applyRefresh(token, creatorBalance, liquidityQuote))
          .catch(() => undefined),
      ),
    );
  }

  /** Applique une relecture ; émet une ALERTE en cas de vente du dev ou de retrait de liquidité. */
  applyRefresh(token: EvmTokenState, creatorBalance?: bigint, liquidity?: number): void {
    if (creatorBalance !== undefined) {
      token.currentDevBalance = creatorBalance;
      if (token.maxDevBalance === undefined || creatorBalance > token.maxDevBalance) token.maxDevBalance = creatorBalance;
      const max = token.maxDevBalance ?? 0n;
      if (!token.devSold && max > 0n && creatorBalance * 2n < max) {
        token.devSold = true;
        this.emitVerdict('ALERTE', token);
        if (token.audit?.creator) this.opts.reputation.recordDevSell(token.audit.creator);
      }
    }
    if (liquidity !== undefined) {
      token.liquidity = liquidity;
      if (token.maxLiquidity === undefined || liquidity > token.maxLiquidity) token.maxLiquidity = liquidity;
      const max = token.maxLiquidity ?? 0;
      if (!token.liquidityPulled && max > 0 && liquidity < max * 0.2) {
        token.liquidityPulled = true;
        this.emitVerdict('ALERTE', token);
      }
    }
  }

  private cleanup(): void {
    const now = this.now();
    const maxAge = this.opts.trackSeconds * 1_000;
    const inactiveTtl = (this.opts.inactiveTtlSeconds ?? 300) * 1_000;
    for (const [address, token] of this.tokens) {
      const last = Math.max(token.detectedAtMs, token.activity.lastTradeAt);
      if (now - token.detectedAtMs > maxAge || (!token.active && now - last > inactiveTtl)) {
        this.tokens.delete(address);
        for (const [key, t] of this.pools) if (t === token) this.pools.delete(key);
      }
    }
  }

  stats(): EvmEngineStats {
    const n = Math.min(this.latencyCount, LATENCY_SAMPLES);
    const sorted = Array.from(this.latencies.subarray(0, n)).sort((a, b) => a - b);
    const pick = (q: number) => (n === 0 ? 0 : sorted[Math.min(n - 1, Math.floor(q * n))]!);
    const lagMs: Record<string, number> = {};
    for (const [source, stat] of this.race.lag) lagMs[source] = stat.count ? Number(stat.totalNs / BigInt(stat.count)) / 1e6 : 0;
    const tokens = [...this.tokens.values()];
    return {
      ...this.counters,
      tracked: tokens.length,
      active: tokens.filter((t) => t.active).length,
      auditsPending: tokens.filter((t) => t.auditPending).length,
      tipBlock: this.tipBlock,
      latency: { p50: pick(0.5), p99: pick(0.99) },
      wins: Object.fromEntries(this.race.wins),
      lagMs,
    };
  }
}
