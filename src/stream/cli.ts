/**
 * Commande `stream` : détection temps réel des lancements Pump.fun.
 *
 *   npm run stream
 *   npm run stream -- --ws wss://... --ws wss://... --grpc https://... --only vert
 */
import { parseArgs } from 'node:util';
import { PublicKey } from '@solana/web3.js';
import { configFromEnv, maskRpcUrl, type ScannerConfig } from '../config.js';
import { PUMP_FUN_PROGRAM_ID } from '../constants.js';
import { extractInitializedMints, scanCreatorHistory } from '../analyzers/creator.js';
import { createLimiter, RpcClient } from '../rpc/client.js';
import { scanToken } from '../scanner.js';
import type { Finding, RiskLevel } from '../types.js';
import { c, colorForScore, fmtNum, fmtPct, padEndVisible, padStartVisible, setColorEnabled, shortAddr } from '../utils/format.js';
import { StreamEngine, type EngineStats, type Phase, type VerdictEvent } from './engine.js';
import { ReputationStore } from './reputation.js';
import { GrpcSource } from './sources/grpc.js';
import type { StatusHandler, TxSource } from './sources/types.js';
import { httpToWs, WebSocketLogsSource } from './sources/websocket.js';
import { warmUpHotPath } from './warmup.js';

const HELP = () => `
${c.bold('Mode stream')} — détection temps réel des lancements Pump.fun

${c.bold('Usage')}
  npm run stream -- [options]

${c.bold('Sources')} (toutes les sources configurées sont mises en course, la plus rapide gagne)
  --ws <url>            Endpoint WebSocket (répétable). Défaut : $SOLANA_WS_URL, sinon dérivé de $SOLANA_RPC_URL
  --grpc <url>          Endpoint Yellowstone gRPC (le plus rapide). Défaut : $YELLOWSTONE_GRPC_URL
  --grpc-token <jeton>  Jeton x-token du gRPC. Défaut : $YELLOWSTONE_GRPC_TOKEN
  --rpc <url>           RPC HTTP pour l'enrichissement (défaut : $SOLANA_RPC_URL)

${c.bold('Analyse')}
  --bundle-slots <n>    Slots observés avant le verdict T1 (défaut 2 : création + slot suivant)
  --track <s>           Durée de suivi des ventes du dev (défaut 300 s)
  --no-enrich           Pas d'enrichissement RPC de l'historique des créateurs
  --enrich-tx <n>       Transactions inspectées par créateur (défaut 25)
  --deep-scan <s>       Scan complet des tokens non ROUGE, N secondes après leur lancement
  --cache <fichier>     Cache de réputation (défaut .cache/creators.json)

${c.bold('Sortie')}
  --only <niveaux>      N'affiche que ces niveaux, ex. "vert" ou "vert,orange"
  --jsonl               Une ligne JSON par verdict sur stdout (pour un bot)
  --webhook <url>       POST JSON de chaque verdict affiché (Telegram, Discord, bot de trading…)
  --stats <s>           Statistiques de latence toutes les N secondes (défaut 30, 0 = jamais)
  --no-warmup           Saute le préchauffage JIT au démarrage (déconseillé)
  --no-color            Désactive les couleurs
`;

const PHASE_STYLE: Record<Phase, (t: string) => string> = {
  T0: (t) => c.bold(c.cyan(t)),
  T1: (t) => c.bold(c.blue(t)),
  T2: (t) => c.bold(c.magenta(t)),
  ALERTE: (t) => c.bold(c.red(t)),
};
const PHASE_ICON: Record<Phase, string> = { T0: '⚡', T1: '◆', T2: '◇', ALERTE: '⚠' };

const clock = () => {
  const d = new Date();
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
};

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

function intOption(value: string | undefined, name: string, fallback: number, min = 0): number {
  if (value === undefined) return fallback;
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || n < min) throw new Error(`--${name} invalide : "${value}" (entier >= ${min})`);
  return n;
}

/** Objet JSON d'un verdict (sortie --jsonl et webhook). */
export function verdictToJson(event: VerdictEvent) {
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
    slot: token.createSlot,
    lagSlots: token.lagSlots,
    source: token.source,
    signature: token.createSignature,
    devBuyPct: token.supply === 0n ? 0 : Number((token.devBuyTokens * 1_000_000n) / token.supply) / 10_000,
    bundle: token.bundle ?? null,
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
  } else {
    detail = c.red('le dev vend !');
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

function renderStats(s: EngineStats, elapsedS: number, reputationSize: number): string {
  const wins = Object.entries(s.wins)
    .sort((a, b) => b[1] - a[1])
    .map(([src, n]) => `${src} ${fmtNum(n)}${s.lagMs[src] ? c.gray(` (+${fmtNum(s.lagMs[src]!, 1)} ms)`) : ''}`)
    .join(' · ');
  return c.gray(
    `⏱  ${fmtNum(s.txReceived)} tx (${fmtNum(s.txReceived / Math.max(1, elapsedS), 0)}/s) · ${fmtNum(s.creates)} lancements · ` +
      `décision T0 p50 ${fmtNum(s.latency.p50, 0)} µs / p99 ${fmtNum(s.latency.p99, 0)} µs · slot ${s.tipSlot} · ` +
      `${fmtNum(s.tracked)} suivis · ${fmtNum(reputationSize)} créateurs en cache` +
      (wins ? ` · sources : ${wins}` : ''),
  );
}

export async function runStream(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    allowPositionals: false,
    options: {
      ws: { type: 'string', multiple: true },
      grpc: { type: 'string' },
      'grpc-token': { type: 'string' },
      rpc: { type: 'string' },
      'bundle-slots': { type: 'string' },
      track: { type: 'string' },
      'no-enrich': { type: 'boolean', default: false },
      'enrich-tx': { type: 'string' },
      'deep-scan': { type: 'string' },
      cache: { type: 'string' },
      only: { type: 'string' },
      jsonl: { type: 'boolean', default: false },
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

  const config: ScannerConfig = configFromEnv();
  if (values.rpc) config.rpcUrl = values.rpc;
  const bundleSlots = intOption(values['bundle-slots'], 'bundle-slots', 2, 1);
  const trackSeconds = intOption(values.track, 'track', 300, 10);
  const enrichTx = intOption(values['enrich-tx'], 'enrich-tx', 25);
  const deepScanS = intOption(values['deep-scan'], 'deep-scan', 0);
  const statsS = intOption(values.stats, 'stats', 30);
  const only = parseLevels(values.only);
  const log = (line: string) => (values.jsonl ? process.stderr.write(`${line}\n`) : console.log(line));

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

  // --- Sorties ---------------------------------------------------------------
  const shownFindings = new Map<string, Set<string>>();
  const deepLimit = createLimiter(2);
  const scheduled = new Set<string>();

  engine.on('verdict', (event) => {
    if (only && !only.has(event.verdict.level)) return;
    const json = verdictToJson(event);
    if (values.jsonl) {
      process.stdout.write(`${JSON.stringify(json, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))}\n`);
    } else {
      const shown = shownFindings.get(event.token.mint) ?? new Set<string>();
      shownFindings.set(event.token.mint, shown);
      console.log([renderVerdict(event), ...renderFindings(event.verdict.findings, shown)].join('\n'));
    }
    if (values.webhook) {
      fetch(values.webhook, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(json, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)),
        signal: AbortSignal.timeout(2_000),
      }).catch(() => undefined);
    }

    if (deepScanS > 0 && event.phase === 'T0' && !scheduled.has(event.token.mint)) {
      scheduled.add(event.token.mint);
      const { mint, creator } = event.token;
      setTimeout(() => {
        const current = engine.getToken(mint)?.verdict;
        if (current?.level === 'ROUGE') return;
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
                `${c.gray(clock())} ${c.bold('🔎 SCAN')}   ${color(c.bold(padEndVisible(result.risk.level, 6)))} ${color(padStartVisible(String(result.risk.score), 3))}  ${padEndVisible(c.bold(event.token.symbol), 12)} scan complet à +${deepScanS} s${alerts.length ? ` — ${alerts.join(' · ')}` : ''}`,
              );
            })
            .catch((error: unknown) => log(c.yellow(`scan complet de ${shortAddr(mint)} impossible : ${error instanceof Error ? error.message : String(error)}`))),
        );
      }, deepScanS * 1_000).unref();
    }
  });

  const onStatus: StatusHandler = (source, message, level) => {
    const line = `${c.gray(clock())} ${level === 'warn' ? c.yellow('!') : c.green('●')} ${c.gray(`[${source}]`)} ${message}`;
    process.stderr.write(`${line}\n`);
  };
  engine.on('status', (message, level) => onStatus('moteur', message, level));

  // --- Démarrage -------------------------------------------------------------
  process.stderr.write(
    `${c.bold('Solana Token Risk Scanner — mode stream')}\n` +
      c.gray(
        `  sources : ${sources.map((s) => s.name).join(', ')}\n` +
          `  RPC enrichissement : ${values['no-enrich'] ? 'désactivé' : maskRpcUrl(config.rpcUrl)} · fenêtre bundle ${bundleSlots} slot(s) · suivi ${trackSeconds} s · ${loaded} créateurs en cache\n`,
      ),
  );

  if (!values['no-warmup']) {
    // Le rendu est préchauffé aussi (dans le vide) : il s'exécute juste après chaque verdict.
    const warm = warmUpHotPath(20_000, (event) => {
      renderVerdict(event);
      renderFindings(event.verdict.findings, new Set());
      JSON.stringify(verdictToJson(event), (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
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

  const statsTimer = statsS > 0 ? setInterval(() => log(renderStats(engine.stats(), (Date.now() - started) / 1000, reputation.size)), statsS * 1_000) : undefined;
  const saveTimer = setInterval(() => {
    try {
      reputation.save();
    } catch (error) {
      onStatus('cache', `sauvegarde impossible : ${error instanceof Error ? error.message : String(error)}`, 'warn');
    }
  }, 30_000);

  return new Promise<number>((resolve) => {
    const shutdown = async () => {
      clearInterval(statsTimer);
      clearInterval(saveTimer);
      engine.stop();
      await Promise.all(sources.map((s) => s.stop().catch(() => undefined)));
      try {
        reputation.save();
      } catch {
        // ignoré à l'arrêt
      }
      log(renderStats(engine.stats(), (Date.now() - started) / 1000, reputation.size));
      resolve(0);
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  });
}
