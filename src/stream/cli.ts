/**
 * Commande `stream` : détection temps réel des lancements de tokens.
 *
 *   npm run stream                          Solana (Pump.fun), tableau de bord trié par activité
 *   npm run stream robinhood                Robinhood Chain (et toute chaîne active sur Based Bot)
 *   npm run stream -- base --sort volume --only vert
 *   npm run stream -- --chains              liste des blockchains prises en charge
 */
import { parseArgs } from 'node:util';
import { PublicKey } from '@solana/web3.js';
import { CHAINS, chainKeys, findChain, type ChainDef } from '../chains/registry.js';
import { configFromEnv, maskRpcUrl, type ScannerConfig } from '../config.js';
import { PUMP_FUN_PROGRAM_ID } from '../constants.js';
import { extractInitializedMints, scanCreatorHistory } from '../analyzers/creator.js';
import { runEvmStream, type EvmCliValues } from '../evm/cli.js';
import { createLimiter, RpcClient } from '../rpc/client.js';
import { scanToken } from '../scanner.js';
import { c, colorForScore, fmtNum, fmtPct, padEndVisible, padStartVisible, setColorEnabled, shortAddr } from '../utils/format.js';
import { marketMetrics, tradesLastMinute } from './activity.js';
import {
  intOption,
  isSelected,
  jsonReplacer,
  parseLevels,
  parsePhases,
  PHASE_ICON,
  PHASE_STYLE,
  postWebhook,
  renderFindings,
  type CommonStreamOptions,
} from './cli-common.js';
import { buildBoard, fmtAge, SORT_KEYS, type SortKey } from './dashboard.js';
import { StreamEngine, type EngineStats, type TokenState, type VerdictEvent } from './engine.js';
import { clock, LiveUi } from './live-ui.js';
import { ReputationStore } from './reputation.js';
import { GrpcSource } from './sources/grpc.js';
import type { TxSource } from './sources/types.js';
import { httpToWs, WebSocketLogsSource } from './sources/websocket.js';
import { warmUpHotPath } from './warmup.js';

const HELP = () => `
${c.bold('Mode stream')} — détection temps réel des lancements de tokens

${c.bold('Usage')}
  npm run stream -- [blockchain] [options]

  blockchain            ${chainKeys().join(', ')}
                        (défaut : solana ; alias acceptés : eth, bnb, avax, arb, hood… ; --chains pour le détail)

Par défaut, un tableau de bord live classe les tokens ${c.bold('actifs')} (seuil de trades franchi) par
activité, avec leur niveau de risque. Les lancements sans activité sont masqués.

${c.bold('Classement')}
  --sort <clé>          trades (défaut), volume, momentum (trades/min), mcap
  --min-trades <n>      Trades requis pour qu'un token soit ACTIF (défaut 15)
  --top <n>             Lignes du classement (défaut 15)
  --only <niveaux>      Ne garde que ces niveaux de risque, ex. "vert" ou "vert,orange"
  --refresh <s>         Rafraîchissement du tableau (défaut 2 s ; 30 s si la sortie n'est pas un terminal)
  --track <s>           Durée maximale de suivi d'un token (défaut 1800 s)

${c.bold('Sources')} (toutes les sources configurées sont mises en course, la plus rapide gagne)
  --ws <url>            Endpoint WebSocket (répétable)
                          Solana : $SOLANA_WS_URL, sinon dérivé de $SOLANA_RPC_URL
                          EVM    : $WS_URL_<CHAÎNE> (ex. WS_URL_BASE), sinon WebSocket public de la chaîne
  --rpc <url>           RPC HTTP (ou WebSocket) : Solana $SOLANA_RPC_URL ; EVM $RPC_URL_<CHAÎNE>, sinon RPC public
  --grpc <url>          Solana : endpoint Yellowstone gRPC ($YELLOWSTONE_GRPC_URL)
  --grpc-token <jeton>  Solana : jeton x-token du gRPC ($YELLOWSTONE_GRPC_TOKEN)
  --poll-ms <ms>        EVM sans WebSocket : intervalle d'interrogation eth_getLogs (défaut : temps de bloc)

${c.bold('Analyse')}
  --bundle-slots <n>    Solana : slots observés avant le verdict T1 (défaut 2)
  --no-enrich           Solana : pas d'enrichissement RPC de l'historique des créateurs
  --enrich-tx <n>       Solana : transactions inspectées par créateur (défaut 25)
  --deep-scan           Solana : scan complet de chaque token qui devient ACTIF
  --audit-all           EVM : auditer chaque nouvelle pool (défaut : seulement les tokens ACTIFS)
  --quote <adresse>     EVM : devise de cotation supplémentaire (répétable)
  --monitor <s>         EVM : relecture du solde du dev et de la liquidité des tokens actifs (défaut 15)
  --cache <fichier>     Cache de réputation des créateurs (défaut .cache/creators[-chaîne].json)

${c.bold('Autres sorties')}
  --all                 Journal de chaque événement (T0, T1, T2, ACTIF, ALERTE) au lieu du tableau
  --jsonl               Une ligne JSON par événement sur stdout (pour un bot)
  --phases <liste>      Événements émis en --all / --jsonl / webhook : t0,t1,t2,actif,alerte
  --webhook <url>       POST JSON des événements (tableau de bord : ACTIF et ALERTE)
  --stats <s>           Statistiques en --all / --jsonl (défaut 30, 0 = jamais)
  --no-warmup           Solana : saute le préchauffage JIT au démarrage (déconseillé)
  --no-color            Désactive les couleurs
`;

function printChains(): void {
  console.log(`\n${c.bold('Blockchains prises en charge par le mode stream')} (réseaux actifs sur Based Bot)\n`);
  console.log(c.gray('  Clé         Réseau              Chain ID  Devise  Détection'));
  for (const chain of CHAINS) {
    if (chain.kind === 'solana') {
      console.log(`  ${padEndVisible(c.bold(chain.key), 10)}  ${padEndVisible(chain.name, 18)}  ${padStartVisible('—', 8)}  ${padEndVisible('SOL', 6)}  Pump.fun (bonding curve)`);
      continue;
    }
    const dexes = chain.dexes.length > 0 ? [...new Set(chain.dexes.map((d) => d.name.replace(/ v\d$/, '')))].join(', ') : 'forks Uniswap / Solidly';
    const ws = chain.viem.rpcUrls.default.webSocket?.length ? '' : c.gray(' (HTTP)');
    console.log(
      `  ${padEndVisible(c.bold(chain.key), 10)}  ${padEndVisible(chain.name.slice(0, 18), 18)}  ${padStartVisible(String(chain.chainId), 8)}  ${padEndVisible(chain.nativeSymbol, 6)}  nouvelles pools : ${dexes}${ws}`,
    );
  }
  console.log(
    c.gray(
      '\n  EVM : détection des pools Uniswap v2/v3/v4 et forks, Solidly/Aerodrome. (HTTP) = pas de WebSocket public :\n' +
        '  interrogation eth_getLogs, plus lente ; fournissez un WebSocket dédié avec --ws ou WS_URL_<CHAÎNE>.\n',
    ),
  );
}

const looksLikeAddress = (value: string) => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value) || /^0x[0-9a-fA-F]{40}$/.test(value);

/** Résout la blockchain demandée (premier argument), Solana par défaut. */
export function resolveStreamChain(positionals: string[]): ChainDef {
  if (positionals.length > 1) throw new Error(`arguments inattendus : ${positionals.slice(1).join(' ')}`);
  const arg = positionals[0];
  if (!arg) return findChain(process.env.STREAM_CHAIN ?? 'solana') ?? findChain('solana')!;
  const chain = findChain(arg);
  if (chain) return chain;
  if (looksLikeAddress(arg)) {
    const scanHint = arg.startsWith('0x')
      ? `  → L'analyse ponctuelle (scan) ne couvre que Solana pour l'instant.\n`
      : `  → Pour analyser le token ${arg} : npm run scan -- ${arg}\n`;
    throw new Error(
      `le mode stream ne prend pas d'adresse : il surveille en direct TOUS les nouveaux lancements.\n` +
        scanHint +
        `  → Pour surveiller les lancements : npm run stream [blockchain]  (npm run stream -- --chains)`,
    );
  }
  throw new Error(`blockchain inconnue : "${arg}". Disponibles : ${chainKeys().join(', ')} (npm run stream -- --chains)`);
}

// ---------------------------------------------------------------------------
// Solana : rendu des événements
// ---------------------------------------------------------------------------

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

/** Objet JSON d'un événement Solana (sortie --jsonl et webhook). */
export function verdictToJson(event: VerdictEvent, engine?: StreamEngine) {
  const { token, verdict } = event;
  return {
    ts: new Date().toISOString(),
    chain: 'solana',
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
    detail = `${token.mint} · ${c.bold(`${fmtNum(a.trades)} trades`)} · vol ${fmtNum(market.volumeSol, 1)} SOL · mcap ${fmtNum(market.marketCapSol, 0)} SOL · ${fmtAge(Date.now() - token.detectedAtMs)} après le lancement`;
  } else {
    detail = `${token.mint} · ${c.red('le dev vend !')} · ${fmtNum(token.activity.trades)} trades`;
  }
  return `${head} ${detail}`;
}

function sourcesSummary(s: { wins: Record<string, number>; lagMs: Record<string, number> }): string {
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

// ---------------------------------------------------------------------------
// Point d'entrée
// ---------------------------------------------------------------------------

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
      'min-trades': { type: 'string' },
      top: { type: 'string' },
      refresh: { type: 'string' },
      'bundle-slots': { type: 'string' },
      track: { type: 'string' },
      'no-enrich': { type: 'boolean', default: false },
      'enrich-tx': { type: 'string' },
      'deep-scan': { type: 'boolean', default: false },
      'audit-all': { type: 'boolean', default: false },
      quote: { type: 'string', multiple: true },
      'poll-ms': { type: 'string' },
      monitor: { type: 'string' },
      cache: { type: 'string' },
      only: { type: 'string' },
      all: { type: 'boolean', default: false },
      jsonl: { type: 'boolean', default: false },
      phases: { type: 'string' },
      webhook: { type: 'string' },
      stats: { type: 'string' },
      chains: { type: 'boolean', default: false },
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
  if (values.chains) {
    printChains();
    return 0;
  }

  const chain = resolveStreamChain(positionals);
  const sort = (values.sort ?? 'trades').toLowerCase() as SortKey;
  if (!SORT_KEYS.includes(sort)) throw new Error(`--sort invalide : "${values.sort}" (${SORT_KEYS.join(', ')})`);
  const mode: CommonStreamOptions['mode'] = values.jsonl ? 'jsonl' : values.all ? 'journal' : 'dashboard';
  const live = mode === 'dashboard' && Boolean(process.stdout.isTTY);
  const common: CommonStreamOptions = {
    sort,
    minTrades: intOption(values['min-trades'], 'min-trades', 15, 1),
    top: intOption(values.top, 'top', 15, 1),
    trackSeconds: intOption(values.track, 'track', 1_800, 10),
    statsS: intOption(values.stats, 'stats', 30),
    refreshS: intOption(values.refresh, 'refresh', live ? 2 : 30, 1),
    only: parseLevels(values.only),
    phases: parsePhases(values.phases),
    mode,
    live,
    webhook: values.webhook,
    cache: values.cache,
  };

  if (chain.kind === 'evm') {
    const evmValues: EvmCliValues = {
      rpc: values.rpc,
      ws: values.ws,
      quote: values.quote,
      pollMs: values['poll-ms'],
      auditAll: values['audit-all'],
      monitor: values.monitor,
    };
    return runEvmStream(chain, evmValues, common);
  }
  return runSolanaStream(values, common);
}

interface SolanaCliValues {
  ws?: string[];
  grpc?: string;
  'grpc-token'?: string;
  rpc?: string;
  'bundle-slots'?: string;
  'no-enrich'?: boolean;
  'enrich-tx'?: string;
  'deep-scan'?: boolean;
  'no-warmup'?: boolean;
}

async function runSolanaStream(values: SolanaCliValues, common: CommonStreamOptions): Promise<number> {
  const config: ScannerConfig = configFromEnv();
  if (values.rpc) config.rpcUrl = values.rpc;
  const bundleSlots = intOption(values['bundle-slots'], 'bundle-slots', 2, 1);
  const enrichTx = intOption(values['enrich-tx'], 'enrich-tx', 25);
  const { mode, minTrades } = common;

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
  const reputation = new ReputationStore(common.cache ?? '.cache/creators.json');
  const loaded = reputation.load();

  const engine = new StreamEngine({
    bundleSlots,
    trackSeconds: common.trackSeconds,
    reputation,
    activity: { minTrades },
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

  // --- Affichage ---------------------------------------------------------------
  let started = Date.now();
  let lastTx = 0;
  let lastTick = Date.now();
  const ui = new LiveUi({
    ...common,
    title: 'Token Risk Scanner — stream Solana (Pump.fun)',
    statsLine: () => {
      const now = Date.now();
      const st = engine.stats();
      const txRate = (st.txReceived - lastTx) / Math.max(0.001, (now - lastTick) / 1000);
      lastTx = st.txReceived;
      lastTick = now;
      const sourcesText = sourcesSummary(st);
      return (
        c.gray(`${fmtNum(txRate, 0)} tx/s · ${fmtNum(st.creates)} lancements · `) +
        c.bold(`${fmtNum(st.active)} actifs`) +
        c.gray(` · décision T0 p50 ${fmtNum(st.latency.p50, 0)} µs / p99 ${fmtNum(st.latency.p99, 0)} µs · slot ${st.tipSlot}${sourcesText ? ` · ${sourcesText}` : ''}`)
      );
    },
    summaryLine: () => renderStats(engine.stats(), (Date.now() - started) / 1000, reputation.size),
    board: (limit) => buildBoard(engine, { sort: common.sort, limit, only: common.only, now: Date.now() }),
  });

  const shownFindings = new Map<string, Set<string>>();
  const deepLimit = createLimiter(2);

  engine.on('verdict', (event) => {
    const tokenIsLive = event.token.active || event.token.activity.trades >= 3;
    if (!isSelected(common, { phase: event.phase, level: event.verdict.level, tokenIsLive })) return;
    const json = verdictToJson(event, engine);

    if (mode === 'jsonl') {
      process.stdout.write(`${JSON.stringify(json, jsonReplacer)}\n`);
    } else if (mode === 'journal') {
      const shown = shownFindings.get(event.token.mint) ?? new Set<string>();
      shownFindings.set(event.token.mint, shown);
      console.log([renderVerdict(event), ...renderFindings(event.verdict.findings, shown)].join('\n'));
    } else {
      ui.pushEvent(renderVerdict(event));
    }
    postWebhook(common.webhook, json);

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
            ui.log(
              `${c.gray(clock())} ${c.bold(padEndVisible('◎ SCAN', 8))} ${color(c.bold(padEndVisible(result.risk.level, 6)))} ${color(padStartVisible(String(result.risk.score), 3))}  ${padEndVisible(c.bold(symbol.slice(0, 12)), 12)} scan complet${alerts.length ? ` — ${alerts.join(' · ')}` : ' — aucun indicateur critique'}`,
            );
          })
          .catch((error: unknown) =>
            ui.log(c.yellow(`scan complet de ${shortAddr(mint)} impossible : ${error instanceof Error ? error.message : String(error)}`)),
          ),
      );
    }
  });
  engine.on('status', (message, level) => ui.status('moteur', message, level));

  // --- Démarrage -------------------------------------------------------------
  process.stderr.write(
    `${c.bold('Token Risk Scanner — mode stream · Solana (Pump.fun)')}\n` +
      c.gray(
        `  sources : ${sources.map((s) => s.name).join(', ')}\n` +
          `  RPC enrichissement : ${values['no-enrich'] ? 'désactivé' : maskRpcUrl(config.rpcUrl)} · seuil ACTIF ${minTrades} trades · fenêtre bundle ${bundleSlots} slot(s) · ${loaded} créateurs en cache\n`,
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
  started = Date.now();
  let running = 0;
  for (const source of sources) {
    try {
      await source.start((tx) => engine.handleTx(tx), ui.status);
      running++;
    } catch (error) {
      ui.status(source.name, error instanceof Error ? error.message : String(error), 'warn');
    }
  }
  if (running === 0) throw new Error('aucune source de données n’a pu démarrer');
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
