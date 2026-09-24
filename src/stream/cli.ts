/**
 * Commande `stream` : détection temps réel des lancements Pump.fun.
 *
 *   npm run stream                                   tableau de bord trié par activité
 *   npm run stream -- --sort trades --only vert
 *   npm run stream -- --all                          journal de chaque lancement (T0/T1/T2)
 *   npm run stream -- --jsonl --phases actif,alerte  flux JSON pour un bot
 */
import { parseArgs } from 'node:util';
import { PublicKey } from '@solana/web3.js';
import { configFromEnv, maskRpcUrl, type ScannerConfig } from '../config.js';
import { PUMP_FUN_PROGRAM_ID } from '../constants.js';
import { extractInitializedMints, scanCreatorHistory } from '../analyzers/creator.js';
import { createLimiter, RpcClient } from '../rpc/client.js';
import { scanToken } from '../scanner.js';
import type { Finding, RiskLevel } from '../types.js';
import {
  c,
  colorForScore,
  fmtNum,
  fmtPct,
  padEndVisible,
  padStartVisible,
  setColorEnabled,
  shortAddr,
  truncateVisible,
} from '../utils/format.js';
import { marketMetrics, tradesLastMinute } from './activity.js';
import { buildBoard, fmtAge, renderBoard, SORT_KEYS, SORT_LABELS, type SortKey } from './dashboard.js';
import { StreamEngine, type EngineStats, type Phase, type TokenState, type VerdictEvent } from './engine.js';
import { ReputationStore } from './reputation.js';
import { GrpcSource } from './sources/grpc.js';
import type { StatusHandler, TxSource } from './sources/types.js';
import { httpToWs, WebSocketLogsSource } from './sources/websocket.js';
import { warmUpHotPath } from './warmup.js';

const HELP = () => `
${c.bold('Mode stream')} — détection temps réel des lancements Pump.fun

${c.bold('Usage')}
  npm run stream -- [options]

Par défaut, un tableau de bord live classe les tokens ${c.bold('actifs')} (seuil de holders et de trades
franchi) par activité, avec leur niveau de risque. Les lancements sans activité sont masqués.

${c.bold('Classement')}
  --sort <clé>          holders (défaut), trades, volume, momentum (trades/min), mcap
  --min-holders <n>     Holders requis pour qu'un token soit ACTIF (défaut 10)
  --min-trades <n>      Trades requis pour qu'un token soit ACTIF (défaut 15)
  --top <n>             Lignes du classement (défaut 15)
  --only <niveaux>      Ne garde que ces niveaux de risque, ex. "vert" ou "vert,orange"
  --refresh <s>         Rafraîchissement du tableau (défaut 2 s ; 30 s si la sortie n'est pas un terminal)

${c.bold('Sources')} (toutes les sources configurées sont mises en course, la plus rapide gagne)
  --ws <url>            Endpoint WebSocket (répétable). Défaut : $SOLANA_WS_URL, sinon dérivé de $SOLANA_RPC_URL
  --grpc <url>          Endpoint Yellowstone gRPC (le plus rapide). Défaut : $YELLOWSTONE_GRPC_URL
  --grpc-token <jeton>  Jeton x-token du gRPC. Défaut : $YELLOWSTONE_GRPC_TOKEN
  --rpc <url>           RPC HTTP pour l'enrichissement (défaut : $SOLANA_RPC_URL)

${c.bold('Analyse')}
  --bundle-slots <n>    Slots observés avant le verdict T1 (défaut 2 : création + slot suivant)
  --track <s>           Durée maximale de suivi d'un token (défaut 1800 s)
  --no-enrich           Pas d'enrichissement RPC de l'historique des créateurs
  --enrich-tx <n>       Transactions inspectées par créateur (défaut 25)
  --deep-scan           Scan complet (holders, réserve, créateur…) de chaque token qui devient ACTIF
  --cache <fichier>     Cache de réputation (défaut .cache/creators.json)

${c.bold('Autres sorties')}
  --all                 Journal de chaque lancement (T0, T1, T2, ACTIF, ALERTE) au lieu du tableau
  --jsonl               Une ligne JSON par événement sur stdout (pour un bot)
  --phases <liste>      Événements émis en --all / --jsonl / webhook : t0,t1,t2,actif,alerte (défaut : tous)
  --webhook <url>       POST JSON des événements (tableau de bord : ACTIF et ALERTE)
  --stats <s>           Statistiques de latence en --all / --jsonl (défaut 30, 0 = jamais)
  --no-warmup           Saute le préchauffage JIT au démarrage (déconseillé)
  --no-color            Désactive les couleurs
`;

const PHASE_STYLE: Record<Phase, (t: string) => string> = {
  T0: (t) => c.bold(c.cyan(t)),
  T1: (t) => c.bold(c.blue(t)),
  T2: (t) => c.bold(c.magenta(t)),
  ACTIF: (t) => c.bold(c.green(t)),
  ALERTE: (t) => c.bold(c.red(t)),
};
const PHASE_ICON: Record<Phase, string> = { T0: '⚡', T1: '◆', T2: '◇', ACTIF: '★', ALERTE: '⚠' };
const ALL_PHASES: readonly Phase[] = ['T0', 'T1', 'T2', 'ACTIF', 'ALERTE'];

const clock = (withMs = true) => {
  const d = new Date();
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  const base = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  return withMs ? `${base}.${pad(d.getMilliseconds(), 3)}` : base;
};

const jsonReplacer = (_key: string, value: unknown) => (typeof value === 'bigint' ? value.toString() : value);

function parseLevels(value: string | undefined): Set<RiskLevel> | undefined {
  if (!value) return undefined;
  const map: Record<string, RiskLevel> = { vert: 'VERT', green: 'VERT', orange: 'ORANGE', rouge: 'ROUGE', red: 'ROUGE' };
  const levels = new Set<RiskLevel>();
  for (const part of value.split(',')) {
    const level = map[part.trim().toLowerCase()];
    if (!level) throw new Error(`--only invalide : "${part}" (vert, orange, rouge)`);
    levels.add(level);
  }
  return levels;
}

function parsePhases(value: string | undefined): Set<Phase> | undefined {
  if (!value) return undefined;
  const phases = new Set<Phase>();
  for (const part of value.split(',')) {
    const phase = part.trim().toUpperCase() as Phase;
    if (!ALL_PHASES.includes(phase)) throw new Error(`--phases invalide : "${part}" (t0, t1, t2, actif, alerte)`);
    phases.add(phase);
  }
  return phases;
}

function intOption(value: string | undefined, name: string, fallback: number, min = 0): number {
  if (value === undefined) return fallback;
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || n < min) throw new Error(`--${name} invalide : "${value}" (entier >= ${min})`);
  return n;
}

/** Résumé d'activité d'un token (holders, trades, volume, capitalisation). */
function activitySummary(token: TokenState, engine?: StreamEngine) {
  const a = token.activity;
  const market = marketMetrics(a, token.supply);
  const conc = engine && a.holders > 0 ? engine.concentrationOf(token) : undefined;
  return {
    holders: a.holders,
    trades: a.trades,
    buys: a.buys,
    sells: a.sells,
    tradesLastMinute: tradesLastMinute(a, Date.now()),
    volumeSol: market.volumeSol,
    marketCapSol: market.marketCapSol,
    progressPct: token.graduated ? 100 : market.progressPct,
    top10Pct: conc?.top10Pct ?? null,
    devHoldingPct: conc?.devPct ?? null,
    devSold: token.devSold,
    graduated: token.graduated,
  };
}

/** Objet JSON d'un événement (sortie --jsonl et webhook). */
export function verdictToJson(event: VerdictEvent, engine?: StreamEngine) {
  const { token, verdict } = event;
  return {
    ts: new Date().toISOString(),
    phase: event.phase,
    mint: token.mint,
    name: token.name,
    symbol: token.symbol,
    creator: token.creator,
    score: verdict.score,
    level: verdict.level,
    previousScore: event.previousScore ?? null,
    decisionMicros: event.decisionMicros ?? null,
    ageSeconds: Math.round((Date.now() - token.detectedAtMs) / 1000),
    slot: token.createSlot,
    lagSlots: token.lagSlots,
    source: token.source,
    signature: token.createSignature,
    devBuyPct: token.supply === 0n ? 0 : Number((token.devBuyTokens * 1_000_000n) / token.supply) / 10_000,
    bundle: token.bundle ?? null,
    activity: activitySummary(token, engine),
    findings: verdict.findings.filter((f) => f.severity === 'critical' || f.severity === 'warning'),
  };
}

function renderVerdict(event: VerdictEvent): string {
  const { token, verdict, phase } = event;
  const color = colorForScore(verdict.score);
  const level = color(c.bold(padEndVisible(verdict.level, 6)));
  const score = color(padStartVisible(String(verdict.score), 3));
  const delta =
    event.previousScore !== undefined && event.previousScore !== verdict.score
      ? c.gray(` (${verdict.score > event.previousScore ? '+' : ''}${verdict.score - event.previousScore})`)
      : '';
  const symbol = padEndVisible(c.bold((token.symbol || '?').slice(0, 12)), 12);
  const head = `${c.gray(clock())} ${PHASE_STYLE[phase](padEndVisible(`${PHASE_ICON[phase]} ${phase}`, 8))} ${level} ${score}${delta}  ${symbol}`;

  let detail: string;
  if (phase === 'T0') {
    const speed = event.decisionMicros !== undefined ? c.green(`${fmtNum(event.decisionMicros, 0)} µs`) : '';
    const lag = token.lagSlots === 0 ? c.green('+0 slot') : c.yellow(`+${token.lagSlots} slot`);
    const name = token.name.length > 24 ? `${token.name.slice(0, 23)}…` : token.name;
    detail = `${name} · ${token.mint} · dev ${shortAddr(token.creator)} · slot ${token.createSlot} ${lag} · décision ${speed}${token.viaRpcFallback ? c.yellow(' (via RPC, logs tronqués)') : ''} ${c.gray(token.source)}`;
  } else if (phase === 'T1' && token.bundle) {
    const b = token.bundle;
    detail = `bundle ${b.windowSlots} slot(s) : ${b.windowBuyers} acheteur${b.windowBuyers > 1 ? 's' : ''} · ${fmtPct(b.bundlePct)} supply · dev ${fmtPct(b.devPct)}${b.cloneGroupSize >= 3 ? c.red(` · ${b.cloneGroupSize} clones`) : ''}`;
  } else if (phase === 'T2') {
    detail = 'historique du créateur analysé';
  } else if (phase === 'ACTIF') {
    const a = token.activity;
    const market = marketMetrics(a, token.supply);
    detail = `${token.mint} · ${c.bold(`${fmtNum(a.holders)} holders`)} · ${fmtNum(a.trades)} trades · vol ${fmtNum(market.volumeSol, 1)} SOL · mcap ${fmtNum(market.marketCapSol, 0)} SOL · ${fmtAge(Date.now() - token.detectedAtMs)} après le lancement`;
  } else {
    detail = `${token.mint} · ${c.red('le dev vend !')} · ${fmtNum(token.activity.holders)} holders`;
  }
  return `${head} ${detail}`;
}

function renderFindings(findings: Finding[], alreadyShown: Set<string>): string[] {
  const lines: string[] = [];
  for (const f of findings) {
    if ((f.severity !== 'critical' && f.severity !== 'warning') || alreadyShown.has(f.message)) continue;
    alreadyShown.add(f.message);
    const icon = f.severity === 'critical' ? c.red('✖') : c.yellow('▲');
    lines.push(`${' '.repeat(22)}${icon} ${f.message}`);
  }
  return lines;
}

function sourcesSummary(s: EngineStats): string {
  return Object.entries(s.wins)
    .sort((a, b) => b[1] - a[1])
    .map(([src, n]) => `${src} ${fmtNum(n)}${s.lagMs[src] ? ` (+${fmtNum(s.lagMs[src]!, 1)} ms)` : ''}`)
    .join(' · ');
}

function renderStats(s: EngineStats, elapsedS: number, reputationSize: number): string {
  const wins = sourcesSummary(s);
  return c.gray(
    `⏱  ${fmtNum(s.txReceived)} tx (${fmtNum(s.txReceived / Math.max(1, elapsedS), 0)}/s) · ${fmtNum(s.creates)} lancements · ` +
      `décision T0 p50 ${fmtNum(s.latency.p50, 0)} µs / p99 ${fmtNum(s.latency.p99, 0)} µs · slot ${s.tipSlot} · ` +
      `${fmtNum(s.tracked)} suivis (${fmtNum(s.active)} actifs) · ${fmtNum(reputationSize)} créateurs en cache` +
      (wins ? ` · sources : ${wins}` : ''),
  );
}

export async function runStream(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      ws: { type: 'string', multiple: true },
      grpc: { type: 'string' },
      'grpc-token': { type: 'string' },
      rpc: { type: 'string' },
      sort: { type: 'string' },
      'min-holders': { type: 'string' },
      'min-trades': { type: 'string' },
      top: { type: 'string' },
      refresh: { type: 'string' },
      'bundle-slots': { type: 'string' },
      track: { type: 'string' },
      'no-enrich': { type: 'boolean', default: false },
      'enrich-tx': { type: 'string' },
      'deep-scan': { type: 'boolean', default: false },
      cache: { type: 'string' },
      only: { type: 'string' },
      all: { type: 'boolean', default: false },
      jsonl: { type: 'boolean', default: false },
      phases: { type: 'string' },
      webhook: { type: 'string' },
      stats: { type: 'string' },
      'no-warmup': { type: 'boolean', default: false },
      'no-color': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  if (values['no-color'] || values.jsonl) setColorEnabled(false);
  if (values.help) {
    console.log(HELP());
    return 0;
  }
  if (positionals.length > 0) {
    throw new Error(
      `le mode stream ne prend pas d'adresse : il surveille en direct TOUS les nouveaux lancements Pump.fun.\n` +
        `  → Pour analyser le token ${positionals[0]} : npm run scan -- ${positionals[0]}\n` +
        `  → Pour surveiller les lancements           : npm run stream`,
    );
  }

  const config: ScannerConfig = configFromEnv();
  if (values.rpc) config.rpcUrl = values.rpc;
  const sort = (values.sort ?? 'holders').toLowerCase() as SortKey;
  if (!SORT_KEYS.includes(sort)) throw new Error(`--sort invalide : "${values.sort}" (${SORT_KEYS.join(', ')})`);
  const minHolders = intOption(values['min-holders'], 'min-holders', 10, 1);
  const minTrades = intOption(values['min-trades'], 'min-trades', 15, 1);
  const top = intOption(values.top, 'top', 15, 1);
  const bundleSlots = intOption(values['bundle-slots'], 'bundle-slots', 2, 1);
  const trackSeconds = intOption(values.track, 'track', 1_800, 10);
  const enrichTx = intOption(values['enrich-tx'], 'enrich-tx', 25);
  const statsS = intOption(values.stats, 'stats', 30);
  const only = parseLevels(values.only);
  const phases = parsePhases(values.phases);
  const mode: 'dashboard' | 'journal' | 'jsonl' = values.jsonl ? 'jsonl' : values.all ? 'journal' : 'dashboard';
  const live = mode === 'dashboard' && Boolean(process.stdout.isTTY);
  const refreshS = intOption(values.refresh, 'refresh', live ? 2 : 30, 1);

  // --- Sources ---------------------------------------------------------------
  const programId = PUMP_FUN_PROGRAM_ID.toBase58();
  const wsUrls = values.ws?.length
    ? values.ws
    : process.env.SOLANA_WS_URL
      ? process.env.SOLANA_WS_URL.split(',').map((u) => u.trim()).filter(Boolean)
      : [httpToWs(config.rpcUrl)];
  const sources: TxSource[] = wsUrls.map(
    (url, i) => new WebSocketLogsSource({ url, programId, name: wsUrls.length > 1 ? `ws${i + 1}:${new URL(url).host}` : undefined }),
  );
  const grpcUrl = values.grpc ?? process.env.YELLOWSTONE_GRPC_URL;
  if (grpcUrl) {
    sources.unshift(new GrpcSource({ endpoint: grpcUrl, token: values['grpc-token'] ?? process.env.YELLOWSTONE_GRPC_TOKEN, programId }));
  }

  // --- RPC (hors chemin critique) -------------------------------------------
  const rpc = new RpcClient({ url: config.rpcUrl, concurrency: config.concurrency, maxRetries: 2 });
  const reputation = new ReputationStore(values.cache ?? '.cache/creators.json');
  const loaded = reputation.load();

  const engine = new StreamEngine({
    bundleSlots,
    trackSeconds,
    reputation,
    activity: { minHolders, minTrades },
    enrich: values['no-enrich']
      ? undefined
      : async (creator, mint) => {
          const history = await scanCreatorHistory(rpc, new PublicKey(creator), enrichTx);
          return {
            previousTokensCreated: history.createdMints.filter((m) => m !== mint).length,
            signatureCount: history.signatureCount,
            fullHistory: history.fullHistory,
            walletAgeDays: history.walletAgeDays,
            solBalance: history.solBalance,
            txScanned: history.txScanned,
          };
        },
    resolveMissingCreate: async (signature) => {
      // Logs tronqués : on relit la transaction dès qu'elle est confirmée.
      for (let attempt = 0; attempt < 8; attempt++) {
        const tx = await rpc
          .call((conn) => conn.getParsedTransaction(signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 }))
          .catch(() => null);
        if (tx) {
          const mint = extractInitializedMints(tx)[0];
          const payer = tx.transaction.message.accountKeys.find((k) => k.signer)?.pubkey.toBase58();
          return mint && payer ? { mint, creator: payer } : null;
        }
        await new Promise((r) => setTimeout(r, 500));
      }
      return null;
    },
  });

  // --- Journal d'événements ---------------------------------------------------
  const recentEvents: string[] = [];
  const pushEvent = (line: string) => {
    if (mode === 'dashboard' && !live) console.log(line);
    recentEvents.unshift(line);
    if (recentEvents.length > 30) recentEvents.pop();
  };
  const log = (line: string) => {
    if (mode === 'dashboard') pushEvent(line);
    else if (mode === 'jsonl') process.stderr.write(`${line}\n`);
    else console.log(line);
  };

  // --- Événements du moteur ---------------------------------------------------
  const shownFindings = new Map<string, Set<string>>();
  const deepLimit = createLimiter(2);

  /** L'événement est-il retenu pour la sortie courante ? */
  const selected = (event: VerdictEvent): boolean => {
    // Une vente du dev sur un token qui a des holders s'affiche quel que soit le filtre de risque.
    const alertOnLiveToken = event.phase === 'ALERTE' && (event.token.active || event.token.activity.holders >= 3);
    if (mode === 'dashboard') {
      if (event.phase === 'ACTIF') return !only || only.has(event.verdict.level);
      return alertOnLiveToken;
    }
    if (phases && !phases.has(event.phase)) return false;
    return !only || only.has(event.verdict.level) || alertOnLiveToken;
  };

  engine.on('verdict', (event) => {
    if (!selected(event)) return;
    const json = verdictToJson(event, engine);

    if (mode === 'jsonl') {
      process.stdout.write(`${JSON.stringify(json, jsonReplacer)}\n`);
    } else if (mode === 'journal') {
      const shown = shownFindings.get(event.token.mint) ?? new Set<string>();
      shownFindings.set(event.token.mint, shown);
      console.log([renderVerdict(event), ...renderFindings(event.verdict.findings, shown)].join('\n'));
    } else {
      pushEvent(renderVerdict(event));
    }

    if (values.webhook) {
      fetch(values.webhook, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(json, jsonReplacer),
        signal: AbortSignal.timeout(2_000),
      }).catch(() => undefined);
    }

    if (values['deep-scan'] && event.phase === 'ACTIF' && event.verdict.level !== 'ROUGE') {
      const { mint, creator, symbol } = event.token;
      void deepLimit(() =>
        scanToken(mint, { ...config, creatorOverride: creator, creatorTxScanLimit: enrichTx }, { rpc })
          .then((result) => {
            const color = colorForScore(result.risk.score);
            const alerts = result.risk.modules
              .flatMap((m) => m.findings)
              .filter((f) => f.severity === 'critical')
              .map((f) => f.message)
              .slice(0, 3);
            log(
              `${c.gray(clock())} ${c.bold(padEndVisible('◎ SCAN', 8))} ${color(c.bold(padEndVisible(result.risk.level, 6)))} ${color(padStartVisible(String(result.risk.score), 3))}  ${padEndVisible(c.bold(symbol.slice(0, 12)), 12)} scan complet${alerts.length ? ` — ${alerts.join(' · ')}` : ' — aucun indicateur critique'}`,
            );
          })
          .catch((error: unknown) =>
            log(c.yellow(`scan complet de ${shortAddr(mint)} impossible : ${error instanceof Error ? error.message : String(error)}`)),
          ),
      );
    }
  });

  let dashboardStarted = false;
  const onStatus: StatusHandler = (source, message, level) => {
    const line = `${c.gray(clock())} ${level === 'warn' ? c.yellow('!') : c.green('●')} ${c.gray(`[${source}]`)} ${message}`;
    if (live && dashboardStarted) pushEvent(line);
    else process.stderr.write(`${line}\n`);
  };
  engine.on('status', (message, level) => onStatus('moteur', message, level));

  // --- Démarrage -------------------------------------------------------------
  process.stderr.write(
    `${c.bold('Solana Token Risk Scanner — mode stream')}\n` +
      c.gray(
        `  sources : ${sources.map((s) => s.name).join(', ')}\n` +
          `  RPC enrichissement : ${values['no-enrich'] ? 'désactivé' : maskRpcUrl(config.rpcUrl)} · seuil ACTIF ${minHolders} holders / ${minTrades} trades · fenêtre bundle ${bundleSlots} slot(s) · ${loaded} créateurs en cache\n`,
      ),
  );

  if (!values['no-warmup']) {
    // Le rendu est préchauffé aussi (dans le vide) : il s'exécute juste après chaque verdict.
    const warm = warmUpHotPath(20_000, (event) => {
      renderVerdict(event);
      renderFindings(event.verdict.findings, new Set());
      JSON.stringify(verdictToJson(event), jsonReplacer);
    });
    process.stderr.write(c.gray(`  préchauffage JIT : ${fmtNum(warm.iterations)} tx synthétiques en ${fmtNum(warm.ms, 0)} ms\n`));
  }

  engine.start();
  const started = Date.now();
  let running = 0;
  for (const source of sources) {
    try {
      await source.start((tx) => engine.handleTx(tx), onStatus);
      running++;
    } catch (error) {
      onStatus(source.name, error instanceof Error ? error.message : String(error), 'warn');
    }
  }
  if (running === 0) throw new Error('aucune source de données n’a pu démarrer');

  // --- Tableau de bord ---------------------------------------------------------
  const boardBlock = (maxRows: number): string[] => {
    const rows = buildBoard(engine, { sort, limit: maxRows, only, now: Date.now() });
    const title =
      c.bold(`CLASSEMENT PAR ${SORT_LABELS[sort].toUpperCase()}`) +
      c.gray(
        ` — tokens actifs (≥ ${minHolders} holders et ≥ ${minTrades} trades)${only ? ` · risque : ${[...only].join(', ')}` : ''} · lancements sans activité masqués`,
      );
    return [
      title,
      ...(rows.length > 0
        ? renderBoard(rows, sort)
        : [c.gray('  Aucun token actif pour le moment : un lancement apparaît ici dès qu’il franchit le seuil.')]),
    ];
  };

  let lastTx = 0;
  let lastTick = Date.now();
  const renderFrame = (): string[] => {
    const now = Date.now();
    const st = engine.stats();
    const txRate = (st.txReceived - lastTx) / Math.max(0.001, (now - lastTick) / 1000);
    lastTx = st.txReceived;
    lastTick = now;
    const height = process.stdout.rows ?? 40;
    const eventsShown = Math.min(8, Math.max(3, Math.floor(height / 5)));
    const boardRows = Math.max(3, Math.min(top, height - eventsShown - 9));
    const sourcesText = sourcesSummary(st);
    return [
      `${c.bold('Solana Token Risk Scanner — stream')}  ${c.gray(`${clock(false)} · en ligne depuis ${fmtAge(now - started)} · Ctrl+C pour quitter`)}`,
      c.gray(`${fmtNum(txRate, 0)} tx/s · ${fmtNum(st.creates)} lancements · `) +
        c.bold(`${fmtNum(st.active)} actifs`) +
        c.gray(
          ` · décision T0 p50 ${fmtNum(st.latency.p50, 0)} µs / p99 ${fmtNum(st.latency.p99, 0)} µs · slot ${st.tipSlot}${sourcesText ? ` · ${sourcesText}` : ''}`,
        ),
      '',
      ...boardBlock(boardRows),
      '',
      c.bold('DERNIERS ÉVÉNEMENTS'),
      ...(recentEvents.length > 0 ? recentEvents.slice(0, eventsShown) : [c.gray('  (aucun pour le moment)')]),
    ];
  };

  const draw = () => {
    const width = Math.max(40, (process.stdout.columns ?? 200) - 1);
    const frame = renderFrame().map((line) => `${truncateVisible(line, width)}\x1b[K`);
    process.stdout.write(`\x1b[H${frame.join('\n')}\x1b[J`);
  };

  let refreshTimer: NodeJS.Timeout | undefined;
  if (live) {
    process.stdout.write('\x1b[?25l\x1b[2J');
    dashboardStarted = true;
    draw();
    refreshTimer = setInterval(draw, refreshS * 1_000);
  } else if (mode === 'dashboard') {
    refreshTimer = setInterval(() => console.log(['', ...boardBlock(top), ''].join('\n')), refreshS * 1_000);
  }

  const statsTimer =
    mode !== 'dashboard' && statsS > 0
      ? setInterval(() => log(renderStats(engine.stats(), (Date.now() - started) / 1000, reputation.size)), statsS * 1_000)
      : undefined;
  const saveTimer = setInterval(() => {
    try {
      reputation.save();
    } catch (error) {
      onStatus('cache', `sauvegarde impossible : ${error instanceof Error ? error.message : String(error)}`, 'warn');
    }
  }, 30_000);

  return new Promise<number>((resolve) => {
    const shutdown = async () => {
      clearInterval(refreshTimer);
      clearInterval(statsTimer);
      clearInterval(saveTimer);
      engine.stop();
      await Promise.all(sources.map((s) => s.stop().catch(() => undefined)));
      try {
        reputation.save();
      } catch {
        // ignoré à l'arrêt
      }
      if (live) process.stdout.write('\x1b[?25h\x1b[2J\x1b[H');
      if (mode === 'dashboard') console.log(['', ...boardBlock(top), ''].join('\n'));
      const summary = renderStats(engine.stats(), (Date.now() - started) / 1000, reputation.size);
      if (mode === 'jsonl') process.stderr.write(`${summary}\n`);
      else console.log(summary);
      resolve(0);
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  });
}
