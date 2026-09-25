/**
 * Mode stream sur une blockchain EVM (`npm run stream base`, `npm run stream robinhood`…).
 *
 * Sources : WebSocket (option --ws, variable WS_URL_<CHAÎNE> ou WebSocket
 * public de la chaîne), sinon interrogation HTTP (RPC_URL_<CHAÎNE> ou RPC public).
 */
import { createPublicClient, http, webSocket, type PublicClient } from 'viem';
import type { EvmChain } from '../chains/registry.js';
import { maskRpcUrl } from '../config.js';
import { c, colorForScore, fmtNum, padEndVisible, padStartVisible, shortAddr } from '../utils/format.js';
import { jsonReplacer, PHASE_ICON, PHASE_STYLE, postWebhook, renderFindings, type CommonStreamOptions } from '../stream/cli-common.js';
import { buildEvmBoard, fmtAge } from '../stream/dashboard.js';
import { clock, LiveUi } from '../stream/live-ui.js';
import { ReputationStore } from '../stream/reputation.js';
import { ZERO_ADDRESS } from './events.js';
import { evmPrice, evmTradesLastMinute, EvmStreamEngine, type EvmEngineStats, type EvmTokenState, type EvmVerdictEvent } from './engine.js';
import { EvmHttpPollingSource, EvmWebSocketSource, type EvmSource } from './sources.js';

export interface EvmCliValues {
  rpc?: string;
  ws?: string[];
  quote?: string[];
  pollMs?: string;
  auditAll?: boolean;
  /** Intervalle de relecture du solde du dev et de la liquidité (s). */
  monitor?: string;
}

const isWs = (url: string) => /^wss?:\/\//i.test(url);

/** Symbole de la devise de cotation d'un token (connu avant même l'audit si possible). */
function quoteSymbol(chain: EvmChain, token: EvmTokenState): string {
  if (token.audit) return token.audit.quote.symbol;
  if (token.quote === ZERO_ADDRESS) return chain.nativeSymbol;
  if (token.quote === chain.wrappedNative?.address) return chain.wrappedNative.symbol;
  return shortAddr(token.quote);
}

function volumeUi(token: EvmTokenState): number | undefined {
  return token.audit ? Number(token.activity.volumeRaw) / 10 ** token.audit.quote.decimals : undefined;
}

function marketCap(token: EvmTokenState): number | undefined {
  const price = evmPrice(token);
  const a = token.audit;
  return a && price !== undefined ? price * (Number(a.totalSupply) / 10 ** a.decimals) : undefined;
}

/** Objet JSON d'un événement EVM (sortie --jsonl et webhook). */
export function evmVerdictToJson(chain: EvmChain, event: EvmVerdictEvent) {
  const { token, verdict } = event;
  const a = token.audit;
  const unit = quoteSymbol(chain, token);
  return {
    ts: new Date().toISOString(),
    chain: chain.key,
    chainId: chain.chainId,
    phase: event.phase,
    address: token.address,
    symbol: a?.symbol ?? null,
    name: a?.name ?? null,
    dex: token.dexName,
    pool: token.pool.poolKey,
    quote: { address: token.quote, symbol: unit },
    score: a ? verdict.score : null,
    level: a ? verdict.level : null,
    previousScore: event.previousScore ?? null,
    decisionMicros: event.decisionMicros ?? null,
    ageSeconds: Math.round((Date.now() - token.detectedAtMs) / 1000),
    block: token.creationBlock,
    creationTx: token.creationTx,
    source: token.source,
    activity: {
      trades: token.activity.trades,
      buys: token.activity.buys,
      sells: token.activity.sells,
      tradesLastMinute: evmTradesLastMinute(token.activity, Date.now()),
      volume: volumeUi(token) ?? null,
      marketCap: marketCap(token) ?? null,
      unit,
    },
    audit: a
      ? {
          owner: a.owner,
          ownerRenounced: a.ownerRenounced,
          proxy: a.proxy,
          capabilities: a.capabilities,
          creator: a.creator ?? null,
          devPct: a.devPct ?? null,
          liquidity: token.liquidity ?? a.liquidityQuote ?? null,
          lpBurnedPct: a.lpBurnedPct ?? null,
        }
      : null,
    alerts: { devSold: token.devSold, liquidityPulled: token.liquidityPulled },
    findings: verdict.findings.filter((f) => f.severity === 'critical' || f.severity === 'warning'),
  };
}

function renderEvmVerdict(chain: EvmChain, event: EvmVerdictEvent): string {
  const { token, verdict, phase } = event;
  const a = token.audit;
  let risk: string;
  if (!a) {
    risk = c.gray(padEndVisible('audit…', 10));
  } else {
    const color = colorForScore(verdict.score);
    risk = `${color(c.bold(padEndVisible(verdict.level, 6)))} ${color(padStartVisible(String(verdict.score), 3))}`;
  }
  const delta =
    a && event.previousScore !== undefined && event.previousScore !== verdict.score && phase !== 'T1'
      ? c.gray(` (${verdict.score > event.previousScore ? '+' : ''}${verdict.score - event.previousScore})`)
      : '';
  const symbol = padEndVisible(c.bold((a?.symbol ?? '?').slice(0, 12)), 12);
  const head = `${c.gray(clock())} ${PHASE_STYLE[phase](padEndVisible(`${PHASE_ICON[phase]} ${phase}`, 8))} ${risk}${delta}  ${symbol}`;
  const unit = quoteSymbol(chain, token);

  let detail: string;
  if (phase === 'T0') {
    const speed = event.decisionMicros !== undefined ? ` · décision ${c.green(`${fmtNum(event.decisionMicros, 0)} µs`)}` : '';
    detail = `${token.address} · nouvelle pool ${token.dexName} cotée en ${unit} · bloc ${token.creationBlock}${speed} ${c.gray(token.source)}`;
  } else if (phase === 'T1') {
    const name = a?.name ? `${a.name.length > 24 ? `${a.name.slice(0, 23)}…` : a.name} · ` : '';
    const liquidity = token.liquidity ?? a?.liquidityQuote;
    detail = `${name}${token.address} · audit du contrat${liquidity !== undefined ? ` · liquidité ${fmtNum(liquidity, liquidity < 10 ? 3 : 1)} ${unit}` : ''}`;
  } else if (phase === 'ACTIF') {
    const volume = volumeUi(token);
    const mcap = marketCap(token);
    detail =
      `${token.address} · ${c.bold(`${fmtNum(token.activity.trades)} trades`)}` +
      (volume !== undefined ? ` · vol ${fmtNum(volume, 2)} ${unit}` : '') +
      (mcap !== undefined ? ` · mcap ${fmtNum(mcap, 1)} ${unit}` : '') +
      ` · ${fmtAge(Date.now() - token.detectedAtMs)} après la création de la pool · ${token.dexName}`;
  } else if (phase === 'ALERTE') {
    detail = `${token.address} · ${c.red(token.liquidityPulled ? 'liquidité retirée (rug) !' : 'le dev vend !')}`;
  } else {
    detail = token.address;
  }
  return `${head} ${detail}`;
}

function sourcesSummary(s: EvmEngineStats): string {
  return Object.entries(s.wins)
    .sort((x, y) => y[1] - x[1])
    .map(([src, n]) => `${src} ${fmtNum(n)}${s.lagMs[src] ? ` (+${fmtNum(s.lagMs[src]!, 1)} ms)` : ''}`)
    .join(' · ');
}

function renderEvmStats(s: EvmEngineStats, elapsedS: number): string {
  const wins = sourcesSummary(s);
  return c.gray(
    `⏱  ${fmtNum(s.logsReceived)} logs (${fmtNum(s.logsReceived / Math.max(1, elapsedS), 0)}/s) · ${fmtNum(s.pools)} nouvelles pools · ` +
      `${fmtNum(s.swaps)} swaps suivis · ${fmtNum(s.tracked)} suivis (${fmtNum(s.active)} actifs) · ${fmtNum(s.audits)} audits · bloc ${s.tipBlock}` +
      (wins ? ` · sources : ${wins}` : ''),
  );
}

export async function runEvmStream(chain: EvmChain, values: EvmCliValues, common: CommonStreamOptions): Promise<number> {
  const envKey = chain.key.toUpperCase();
  const rpcArg = values.rpc ?? process.env[`RPC_URL_${envKey}`];
  const httpUrl = rpcArg && !isWs(rpcArg) ? rpcArg : chain.viem.rpcUrls.default.http[0]!;
  const envWs = process.env[`WS_URL_${envKey}`]?.split(',').map((u) => u.trim()).filter(Boolean);
  // Priorité aux endpoints fournis par l'utilisateur : un RPC HTTP dédié n'est jamais
  // remplacé par le WebSocket public de la chaîne (ajoutez --ws pour la poussée temps réel).
  let wsUrls: string[];
  if (values.ws?.length) wsUrls = values.ws;
  else if (envWs?.length) wsUrls = envWs;
  else if (rpcArg) wsUrls = isWs(rpcArg) ? [rpcArg] : [];
  else wsUrls = (chain.viem.rpcUrls.default.webSocket ?? []).slice(0, 1);

  const pollMs = values.pollMs !== undefined ? Number.parseInt(values.pollMs, 10) : Math.min(2_000, Math.max(250, chain.blockTimeMs));
  if (!Number.isFinite(pollMs) || pollMs < 50) throw new Error(`--poll-ms invalide : "${values.pollMs}"`);
  const sources: EvmSource[] =
    wsUrls.length > 0 ? wsUrls.map((url) => new EvmWebSocketSource(url)) : [new EvmHttpPollingSource({ url: httpUrl, pollMs })];

  const client = createPublicClient({
    chain: chain.viem,
    transport: rpcArg && isWs(rpcArg) ? webSocket(rpcArg) : http(httpUrl, { timeout: 10_000, retryCount: 2 }),
  }) as PublicClient;

  const reputation = new ReputationStore(common.cache ?? `.cache/creators-${chain.key}.json`);
  const loaded = reputation.load();
  const engine = new EvmStreamEngine({
    chain,
    client,
    reputation,
    minTrades: common.minTrades,
    trackSeconds: common.trackSeconds,
    auditAll: values.auditAll,
    quotes: values.quote?.map((q) => q.toLowerCase()),
    refreshSeconds: values.monitor !== undefined ? Math.max(1, Number.parseInt(values.monitor, 10) || 15) : 15,
  });

  let started = Date.now();
  let lastLogs = 0;
  let lastTick = Date.now();
  const ui = new LiveUi({
    ...common,
    title: `Token Risk Scanner — stream ${chain.name}`,
    statsLine: () => {
      const now = Date.now();
      const st = engine.stats();
      const rate = (st.logsReceived - lastLogs) / Math.max(0.001, (now - lastTick) / 1000);
      lastLogs = st.logsReceived;
      lastTick = now;
      const sourcesText = sourcesSummary(st);
      return (
        c.gray(`${fmtNum(rate, 0)} logs/s · ${fmtNum(st.pools)} nouvelles pools · `) +
        c.bold(`${fmtNum(st.active)} actifs`) +
        c.gray(
          ` · ${fmtNum(st.audits)} audits${st.auditsPending ? ` (${st.auditsPending} en cours)` : ''} · détection p50 ${fmtNum(st.latency.p50, 0)} µs · bloc ${st.tipBlock}${sourcesText ? ` · ${sourcesText}` : ''}`,
        )
      );
    },
    summaryLine: () => renderEvmStats(engine.stats(), (Date.now() - started) / 1000),
    board: (limit) => buildEvmBoard(engine, { sort: common.sort, limit, only: common.only, now: Date.now() }),
  });

  /**
   * Sélection des événements. Sur EVM, le niveau de risque n'est connu qu'après
   * l'audit (lancé au passage ACTIF) : en tableau de bord, un token ACTIF est
   * annoncé immédiatement (sans filtre de risque), puis le résultat de son audit
   * s'affiche ; avec --only, seul le résultat d'audit conforme est annoncé.
   */
  const selectEvm = (event: EvmVerdictEvent): boolean => {
    const audited = event.token.audit !== undefined;
    const passesOnly = !common.only || (audited && common.only.has(event.verdict.level));
    if (common.mode === 'dashboard') {
      if (event.phase === 'ALERTE') return true;
      if (event.phase === 'ACTIF') return !common.only;
      if (event.phase === 'T1') return event.token.active && passesOnly;
      return false;
    }
    if (common.phases && !common.phases.has(event.phase)) return false;
    return event.phase === 'ALERTE' || passesOnly;
  };

  const shownFindings = new Map<string, Set<string>>();
  engine.on('verdict', (event) => {
    if (!selectEvm(event)) return;
    const json = evmVerdictToJson(chain, event);
    if (common.mode === 'jsonl') {
      process.stdout.write(`${JSON.stringify(json, jsonReplacer)}\n`);
    } else if (common.mode === 'journal') {
      const shown = shownFindings.get(event.token.address) ?? new Set<string>();
      shownFindings.set(event.token.address, shown);
      const findings = event.token.audit ? renderFindings(event.verdict.findings, shown) : [];
      console.log([renderEvmVerdict(chain, event), ...findings].join('\n'));
    } else {
      ui.pushEvent(renderEvmVerdict(chain, event));
    }
    postWebhook(common.webhook, json);
  });
  engine.on('status', (message, level) => ui.status('moteur', message, level));

  process.stderr.write(
    `${c.bold(`Token Risk Scanner — mode stream · ${chain.name} (chain ID ${chain.chainId})`)}\n` +
      c.gray(
        `  sources : ${sources.map((s) => s.name).join(', ')}${wsUrls.length === 0 ? ` (aucun WebSocket : interrogation toutes les ${pollMs} ms)` : ''}\n` +
          `  RPC audits : ${maskRpcUrl(rpcArg && isWs(rpcArg) ? rpcArg : httpUrl)} · seuil ACTIF ${common.minTrades} trades · ` +
          `audit ${values.auditAll ? 'de chaque nouvelle pool' : 'des tokens actifs'} · devise ${chain.wrappedNative?.symbol ?? 'apprise sur les premières pools'} · ${loaded} créateurs en cache\n`,
      ),
  );

  engine.start();
  started = Date.now();
  let running = 0;
  for (const source of sources) {
    try {
      await source.start((log) => engine.handleLog(log), ui.status);
      running++;
    } catch (error) {
      ui.status(source.name, error instanceof Error ? error.message : String(error), 'warn');
    }
  }
  if (running === 0) {
    throw new Error(
      `aucune source n'a pu démarrer sur ${chain.name}. Fournissez un RPC avec --rpc <url> ou RPC_URL_${envKey} / WS_URL_${envKey}.`,
    );
  }
  ui.start();

  const saveTimer = setInterval(() => {
    try {
      reputation.save();
    } catch (error) {
      ui.status('cache', `sauvegarde impossible : ${error instanceof Error ? error.message : String(error)}`, 'warn');
    }
  }, 30_000);

  return new Promise<number>((resolve) => {
    const shutdown = async () => {
      clearInterval(saveTimer);
      engine.stop();
      await Promise.all(sources.map((s) => s.stop().catch(() => undefined)));
      try {
        reputation.save();
      } catch {
        // ignoré à l'arrêt
      }
      ui.finish();
      resolve(0);
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  });
}
