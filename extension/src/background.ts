/**
 * Service worker : tout ce qui touche au réseau et au scoring.
 *
 * Pourquoi ici et pas dans le content script : un content script s'exécute dans
 * la page, donc soumis à sa CSP et à son origine. Le service worker a ses
 * propres permissions réseau, un cycle de vie indépendant de l'onglet, et un
 * cache partagé entre tous les onglets — ouvrir dix fois le même token ne
 * déclenche qu'un seul scan.
 *
 * Le moteur de score est le MÊME code que le CLI (`src/scanner.ts`), empaqueté
 * par esbuild. Aucune réimplémentation : une seule définition du risque.
 */
import { RpcClient } from '../../src/rpc/client.js';
import { scanToken, parseMint } from '../../src/scanner.js';
import type { ScanResult } from '../../src/types.js';
import { compareVersions } from '../../src/update/version.js';
import { chromeLocalStore } from './chrome-store.js';
import { HistoryStore, type FollowUp, type HistoryBrief, type ScanTrigger } from './history-store.js';
import { toSnapshot } from './history-snapshot.js';
import { toPanelResult } from './panel-result.js';
import type { PaperPosition, PaperWallet } from './paper.js';
import { extractSocials, metadataCandidates, pumpUsername, type DevInfo, type Socials } from './socials.js';
import { ConfigError, explainRpcError, isBrowserHostile, RetryableError } from './rpc-errors.js';

export { ConfigError, explainRpcError, isBrowserHostile, RetryableError };

export interface Settings {
  rpcUrl: string;
  /** Recensement complet des holders : précis mais lent et souvent bloqué. */
  holderCensus: boolean;
  autoScan: boolean;
  /** Installe d'elle-même les nouvelles versions (nécessite l'assistant de mise à jour). */
  autoUpdate: boolean;
  /** Lit les positions de paper trading DryFlip affichées sur la page. */
  paperTracking: boolean;
}

/**
 * Pas de RPC par défaut, volontairement.
 *
 * `api.mainnet-beta.solana.com` répond 200 à un script serveur mais 403 à
 * toute requête portant un `Origin: chrome-extension://` — il bloque les
 * navigateurs. Le mettre par défaut donnerait une extension qui échoue à
 * chaque token avec un message incompréhensible. Mieux vaut exiger une
 * configuration explicite et le dire clairement.
 */
const DEFAULTS: Settings = {
  rpcUrl: '',
  // Une seule requête (getProgramAccounts réduit au propriétaire et au solde) : le
  // dusting check en dépend, il est donc actif par défaut.
  holderCensus: true,
  autoScan: true,
  autoUpdate: true,
  paperTracking: true,
};

const REPO = 'awaping/solana-token-risk-scanner';
/** Durée de validité d'un scan en cache. Un token jeune bouge vite. */
const CACHE_TTL_MS = 60_000;
const CACHE_MAX = 200;

export async function getSettings(): Promise<Settings> {
  const stored = await chrome.storage.sync.get(DEFAULTS);
  return { ...DEFAULTS, ...stored } as Settings;
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

interface CacheEntry {
  at: number;
  outcome: ScanOutcome;
}

const cache = new Map<string, CacheEntry>();

/**
 * Scans en vol : deux onglets sur le même token partagent la même requête.
 * `waiters` compte les onglets qui attendent ce résultat ; quand plus aucun ne
 * l'attend (l'utilisateur est passé à un autre token), le scan est annulé.
 */
/** Résultat d'un scan et résumé de l'historique du token (première analyse, précédente). */
export interface ScanOutcome {
  result: ScanResult;
  brief?: HistoryBrief;
}

interface Flight {
  task: Promise<ScanOutcome>;
  controller: AbortController;
  waiters: number;
  /** Analyse d'entrée ou de suivi : jamais annulée quand l'onglet passe à un autre token. */
  keep?: boolean;
}
const inFlight = new Map<string, Flight>();
/** Dernier token demandé par chaque onglet. */
const tabTokens = new Map<number, string>();

/** Chaque analyse (initiale ou actualisation) est conservée pour suivre l'évolution du token. */
const history = new HistoryStore(chromeLocalStore());

function remember(mint: string, outcome: ScanOutcome): void {
  if (cache.size >= CACHE_MAX) {
    // Map conserve l'ordre d'insertion : la première clé est la plus ancienne.
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(mint, { at: Date.now(), outcome });
}

/**
 * Un seul client RPC par endpoint, partagé par tous les scans : le plafond de
 * débit vaut pour l'ensemble des onglets, pas pour chaque analyse séparément.
 * 8 requêtes/s laisse de la marge sous la limite des offres gratuites (≈ 10/s).
 */
const clients = new Map<string, RpcClient>();
function clientFor(url: string): RpcClient {
  let client = clients.get(url);
  if (!client) {
    client = new RpcClient({ url, concurrency: 3, maxRetries: 4, maxRps: 8 });
    clients.set(url, client);
  }
  return client;
}

/** L'onglet ne regarde plus ce token : son scan est annulé si personne d'autre ne l'attend. */
function release(mint: string): void {
  const flight = inFlight.get(mint);
  if (!flight) return;
  flight.waiters--;
  if (flight.waiters <= 0 && !flight.keep) flight.controller.abort();
}

// ---------------------------------------------------------------------------
// Scan
// ---------------------------------------------------------------------------

/**
 * Analyse un token. `force` (bouton « Actualiser » du panneau) ignore le cache
 * pour relire la blockchain tout de suite. `trigger` : origine de l'analyse,
 * gardée dans l'historique (une analyse « entrée » est rattachée à l'achat paper).
 */
export async function scan(mintArg: string, tabId?: number, force = false, trigger?: ScanTrigger): Promise<ScanOutcome> {
  const requestedAt = Date.now();
  const mint = parseMint(mintArg).toBase58();
  const origin: ScanTrigger = trigger ?? (force ? 'actualisation' : 'ouverture');
  // Achat ou suivi : une mesure fraîche et à part, qui ne se greffe pas sur un scan déjà lancé.
  const own = origin === 'entrée' || origin === 'suivi';

  // Token précédent de cet onglet : l'utilisateur l'a quitté, son scan peut être annulé.
  const previous = tabId !== undefined ? tabTokens.get(tabId) : undefined;
  if (tabId !== undefined) {
    tabTokens.set(tabId, mint);
    if (previous && previous !== mint) release(previous);
  }

  const hit = cache.get(mint);
  if (!force && hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.outcome;

  const running = inFlight.get(mint);
  if (!own && running && !running.controller.signal.aborted) {
    // Même onglet qui redemande le même token : il est déjà compté parmi les attentes.
    const alreadyWaiting = tabId !== undefined && previous === mint;
    if (!alreadyWaiting) running.waiters++;
    return running.task;
  }

  const settings = await getSettings();
  if (!settings.rpcUrl.trim()) {
    throw new ConfigError(
      "Aucun endpoint RPC configuré. L'analyse nécessite un RPC privé (Helius, Triton, QuickNode) : les endpoints publics refusent les requêtes venant d'un navigateur.",
    );
  }

  const controller = new AbortController();
  const rpc = clientFor(settings.rpcUrl).scoped(controller.signal);
  const task = scanToken(mint, {
    rpcUrl: settings.rpcUrl,
    concurrency: 3,
    maxRetries: 4,
    // 30 transactions suffisent à repérer un déployeur en série, pour ~3 fois
    // moins de requêtes que l'historique complet du CLI (offres RPC gratuites).
    creatorTxScanLimit: 30,
    mintHistoryMaxPages: 3,
    holderCensus: settings.holderCensus,
  }, { rpc })
    .then(async (result) => {
      // Enregistrée avant la réponse : le panneau affiche aussitôt l'évolution de la note.
      const brief = await history.record(toSnapshot(result, Date.now(), { trigger: origin, requestedAt })).catch(() => undefined);
      const outcome: ScanOutcome = { result, ...(brief ? { brief } : {}) };
      remember(mint, outcome);
      return outcome;
    })
    .catch((error: unknown) => {
      throw explainRpcError(error, settings.rpcUrl);
    })
    .finally(() => {
      if (inFlight.get(mint)?.task === task) inFlight.delete(mint);
    });

  inFlight.set(mint, { task, controller, waiters: own ? 0 : 1, ...(own ? { keep: true } : {}) });
  return task;
}

// ---------------------------------------------------------------------------
// Réseaux sociaux et dev (en plus de la note, jamais sur son chemin)
// ---------------------------------------------------------------------------

interface SocialsReply {
  ok: true;
  socials: Socials;
  dev?: DevInfo;
  /** Hébergeur des métadonnées que l'extension n'a pas le droit de lire (à autoriser dans les réglages). */
  blocked?: string;
}

/**
 * L'extension a-t-elle le droit de lire cette origine ? Sans ce droit, Chrome
 * bloque la requête (CORS) ET l'inscrit dans les erreurs de l'extension : on ne
 * la lance donc pas du tout.
 */
async function mayFetch(url: string): Promise<boolean> {
  try {
    return await chrome.permissions.contains({ origins: [`${new URL(url).origin}/*`] });
  } catch {
    return false;
  }
}

/** Métadonnées du token : hébergeur d'origine, sinon passerelle IPFS publique, si autorisés. */
async function loadMetadata(uri: string | undefined): Promise<{ json?: unknown; blocked?: string }> {
  const candidates = metadataCandidates(uri);
  let blocked: string | undefined;
  for (const url of candidates) {
    if (!(await mayFetch(url))) {
      blocked ??= new URL(url).hostname;
      continue;
    }
    const json = await fetchJson(url, 6_000);
    if (json !== undefined) return { json };
  }
  return blocked ? { blocked } : {};
}

const SOCIALS_TTL_MS = 10 * 60_000;
const socialsCache = new Map<string, { at: number; reply: Promise<SocialsReply> }>();

/** JSON d'un tiers : délai court, taille plafonnée, aucune erreur propagée. */
async function fetchJson(url: string, timeoutMs: number, maxBytes = 64 * 1024): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal, credentials: 'omit' });
    if (!res.ok || Number(res.headers.get('content-length') ?? 0) > maxBytes) return undefined;
    const text = await res.text();
    return text.length > maxBytes ? undefined : (JSON.parse(text) as unknown);
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Twitter / Telegram / site du projet (fichier de métadonnées du token) et
 * pseudo pump.fun du dev. Demandé par le panneau APRÈS l'affichage de la note :
 * ni la note ni son délai n'en dépendent.
 */
function loadSocials(mint: string, uri: string | undefined, creator: string | undefined): Promise<SocialsReply> {
  const cached = socialsCache.get(mint);
  if (cached && Date.now() - cached.at < SOCIALS_TTL_MS) return cached.reply;
  const reply = (async (): Promise<SocialsReply> => {
    // Adresse validée avant d'entrer dans une URL.
    const dev = creator ? parseMint(creator).toBase58() : undefined;
    const [metadata, profile] = await Promise.all([
      loadMetadata(uri),
      dev ? fetchJson(`https://frontend-api-v3.pump.fun/users/${dev}`, 4_000) : undefined,
    ]);
    const socials = extractSocials(metadata.json);
    const username = pumpUsername(profile);
    const devInfo: DevInfo | undefined = dev ? { address: dev, ...(username ? { username } : {}) } : undefined;
    void history
      .attachSocials(mint, { ...socials, ...(devInfo ? { dev: devInfo } : {}), ...(metadata.blocked ? { blocked: metadata.blocked } : {}), at: Date.now() })
      .catch(() => undefined);
    return { ok: true, socials, ...(devInfo ? { dev: devInfo } : {}), ...(metadata.blocked ? { blocked: metadata.blocked } : {}) };
  })();
  socialsCache.set(mint, { at: Date.now(), reply });
  return reply;
}

// ---------------------------------------------------------------------------
// Mise à jour
// ---------------------------------------------------------------------------

/** Nom de l'assistant de mise à jour installé par `npm run setup:updater`. */
const UPDATER = 'com.solana_risk_scanner.updater';
const MANIFEST_URL = `https://raw.githubusercontent.com/${REPO}/main/extension/manifest.json`;

export interface UpdateState {
  current: string;
  latest?: string;
  url: string;
  hasUpdate: boolean;
  /** ready = l'assistant répond ; missing = pas installé (ou pas pour cette extension). */
  helper: 'ready' | 'missing';
  autoUpdate: boolean;
}

interface HelperReply {
  ok: boolean;
  error?: string;
  version?: string;
  from?: string;
  to?: string;
  behind?: number;
}

/** Appel à l'assistant de mise à jour ; `missing` s'il n'est pas installé. */
async function helper(action: 'status' | 'check' | 'update'): Promise<HelperReply & { missing?: boolean }> {
  try {
    return (await chrome.runtime.sendNativeMessage(UPDATER, { action })) as HelperReply;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, missing: /not found|forbidden|access to the specified native messaging host/i.test(message), error: message };
  }
}

/**
 * Compare la version installée à celle de la branche principale du dépôt
 * (dépôt public : simple lecture du manifest sur GitHub, sans clé).
 *
 * Une extension installée depuis le Chrome Web Store se met à jour seule. Une
 * extension chargée depuis un dossier, jamais : Chrome lui interdit de
 * réécrire ses fichiers. D'où l'assistant local, qui fait le `git pull`.
 */
export async function checkUpdate(): Promise<UpdateState> {
  const current = chrome.runtime.getManifest().version;
  const [settings, status] = await Promise.all([getSettings(), helper('status')]);
  const base = {
    current,
    url: `https://github.com/${REPO}`,
    helper: status.ok ? ('ready' as const) : ('missing' as const),
    autoUpdate: settings.autoUpdate,
  };
  try {
    const res = await fetch(MANIFEST_URL, { cache: 'no-store' });
    if (!res.ok) return { ...base, hasUpdate: false };
    const latest = String(((await res.json()) as { version?: string }).version ?? '');
    return { ...base, latest, hasUpdate: Boolean(latest) && compareVersions(latest, current) > 0 };
  } catch {
    // Hors ligne : jamais bloquant.
    return { ...base, hasUpdate: false };
  }
}

/** Fait récupérer la dernière version par l'assistant, puis recharge l'extension. */
export async function applyUpdate(): Promise<{ ok: boolean; from?: string; to?: string; error?: string; missing?: boolean }> {
  const reply = await helper('update');
  if (!reply.ok) return { ok: false, error: reply.error, missing: reply.missing };
  if (reply.to && reply.to !== reply.from) {
    // Laisse le temps à la réponse de partir avant que le service worker ne redémarre.
    setTimeout(() => chrome.runtime.reload(), 400);
  }
  return { ok: true, from: reply.from, to: reply.to };
}

/** Vérification au démarrage puis toutes les 3 h : pastille « MAJ », et installation si autorisée. */
async function flagUpdate(): Promise<void> {
  const state = await checkUpdate();
  await chrome.action.setBadgeText({ text: state.hasUpdate ? 'MAJ' : '' });
  if (!state.hasUpdate) return;
  await chrome.action.setBadgeBackgroundColor({ color: '#2563eb' });
  if (state.autoUpdate && state.helper === 'ready') await applyUpdate();
}

// ---------------------------------------------------------------------------
// Paper trading (DryFlip)
// ---------------------------------------------------------------------------

/** Montant reçu du content script : seuls des nombres finis et des unités connues passent. */
function cleanAmount(value: unknown): PaperPosition['bought'] {
  const a = value as { value?: unknown; unit?: unknown } | undefined;
  if (!a || typeof a.value !== 'number' || !Number.isFinite(a.value)) return undefined;
  const unit = ['SOL', 'BNB', 'ETH', 'USD', ''].includes(String(a.unit)) ? (String(a.unit) as NonNullable<PaperPosition['bought']>['unit']) : '';
  return { value: a.value, unit };
}

function cleanPosition(value: unknown): PaperPosition {
  const p = (value ?? {}) as Record<string, unknown>;
  const out: PaperPosition = {};
  for (const key of ['bought', 'sold', 'remaining', 'pnl'] as const) {
    const amount = cleanAmount(p[key]);
    if (amount) out[key] = amount;
  }
  if (typeof p.pnlPct === 'number' && Number.isFinite(p.pnlPct)) out.pnlPct = p.pnlPct;
  if (typeof p.remainingPct === 'number' && Number.isFinite(p.remainingPct)) out.remainingPct = p.remainingPct;
  return out;
}

export interface PaperReply {
  ok: boolean;
  /** Achat vu : l'analyse d'entrée a été faite, voici son résultat pour le panneau. */
  result?: ReturnType<typeof toPanelResult>;
  /** Opérations enregistrées sur ce token, avec l'âge du token à chacune. */
  trades?: Array<{ kind: 'achat' | 'vente'; at: number; observed: boolean; tokenAgeSec?: number; closes?: boolean }>;
  deadAtOpen?: string;
  error?: string;
}

async function handlePaper(request: { mint?: string; position?: unknown; wallet?: unknown; at?: number; observed?: boolean; vanished?: boolean; manual?: boolean }): Promise<PaperReply> {
  const at = typeof request.at === 'number' && Math.abs(request.at - Date.now()) < 120_000 ? request.at : Date.now();
  const balance = cleanAmount((request.wallet as PaperWallet | undefined)?.balance);
  if (balance) {
    const pnl = cleanAmount((request.wallet as PaperWallet).pnl);
    await history.setWallet({ balance, ...(pnl ? { pnl } : {}) }, at);
  }
  if (!request.mint || (!request.position && !request.vanished)) return { ok: true };
  const mint = parseMint(request.mint).toBase58();
  const change = await history.attachPaper(mint, cleanPosition(request.position), {
    at,
    observed: request.observed === true,
    vanished: request.vanished === true,
    manual: request.manual === true,
  });
  if (!change.known) return { ok: false, error: 'token pas encore analysé' };

  const coin = await history.get(mint);
  if (change.firstBuy && !coin?.deadAtOpen) {
    // Le token est ré-analysé ensuite à intervalles : c'est ce qui dira s'il a « run » ou « rug ».
    await history.scheduleFollowUps(mint, at);
    armFollowUps();
  }
  const reply: PaperReply = {
    ok: true,
    trades: (coin?.paper?.trades ?? []).map((t) => ({
      kind: t.kind,
      at: t.at,
      observed: t.observed,
      ...(t.tokenAgeSec !== undefined ? { tokenAgeSec: t.tokenAgeSec } : {}),
      ...(t.closes ? { closes: true } : {}),
    })),
    ...(coin?.deadAtOpen ? { deadAtOpen: coin.deadAtOpen.reason } : {}),
  };
  // Achat vu en direct : analyse complète immédiate, gardée avec l'achat (les données exactes du IN).
  if (change.buy && request.observed) {
    try {
      const { result, brief } = await scan(mint, undefined, true, 'entrée');
      reply.result = toPanelResult(result, brief);
    } catch (error) {
      reply.error = error instanceof Error ? error.message : String(error);
    }
  }
  return reply;
}

const FOLLOW_UP_ALARM = 'paper-followups';
let followUpsRunning = false;

/** Réveil chaque minute tant que des ré-analyses sont en attente (survit à la mise en veille du service worker). */
function armFollowUps(): void {
  chrome.alarms?.create(FOLLOW_UP_ALARM, { periodInMinutes: 1 });
}

/** Ré-analyses de suivi arrivées à échéance, une à la fois (débit RPC partagé avec les onglets). */
async function runFollowUps(): Promise<void> {
  if (followUpsRunning) return;
  followUpsRunning = true;
  try {
    const list = await history.followUps();
    if (list.length === 0) {
      await chrome.alarms?.clear(FOLLOW_UP_ALARM);
      return;
    }
    const due: FollowUp[] = list.filter((f) => f.due <= Date.now()).sort((a, b) => a.due - b.due);
    for (const item of due) {
      let ok = true;
      try {
        await scan(item.mint, undefined, true, 'suivi');
      } catch {
        ok = false;
      }
      await history.settleFollowUp(item, ok);
    }
  } finally {
    followUpsRunning = false;
  }
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

type Request =
  | { type: 'scan'; mint: string; force?: boolean }
  | { type: 'update' }
  | { type: 'apply-update' }
  | { type: 'settings' }
  | { type: 'open-options' }
  | { type: 'open-history'; mint?: string }
  | { type: 'socials'; mint: string; uri?: string; creator?: string }
  | { type: 'paper'; mint?: string; position?: unknown; wallet?: unknown; at?: number; observed?: boolean; vanished?: boolean; manual?: boolean };

chrome.runtime.onMessage.addListener((request: Request, _sender, sendResponse) => {
  // `sendResponse` asynchrone impose de renvoyer `true` : sans ça, Chrome
  // ferme le canal avant la réponse et l'appelant reçoit `undefined`.
  if (request.type === 'scan') {
    scan(request.mint, _sender.tab?.id, request.force === true)
      // Résultat réduit à ce qu'affiche le panneau : un ScanResult complet contient des
      // BigInt que la messagerie de Chrome ne sait pas sérialiser.
      .then(({ result, brief }) => sendResponse({ ok: true, result: toPanelResult(result, brief) }))
      .catch((error: unknown) =>
        sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
          action: error instanceof ConfigError || error instanceof RetryableError ? error.action : undefined,
        }),
      );
    return true;
  }
  if (request.type === 'update') {
    checkUpdate().then((state) => {
      void chrome.action.setBadgeText({ text: state.hasUpdate ? 'MAJ' : '' });
      sendResponse({ ok: true, state });
    });
    return true;
  }
  if (request.type === 'apply-update') {
    applyUpdate().then((result) => sendResponse(result));
    return true;
  }
  if (request.type === 'open-options') {
    // Seul le contexte de l'extension peut l'ouvrir : le content script doit
    // obligatoirement passer par ce message.
    chrome.runtime.openOptionsPage();
    sendResponse({ ok: true });
    return false;
  }
  if (request.type === 'socials') {
    loadSocials(request.mint, request.uri, request.creator)
      .then((reply) => sendResponse(reply))
      .catch(() => sendResponse({ ok: true, socials: {} }));
    return true;
  }
  if (request.type === 'paper') {
    handlePaper(request)
      .then((reply) => sendResponse(reply))
      .catch((error: unknown) => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }));
    return true;
  }
  if (request.type === 'open-history') {
    const hash = request.mint ? `#${encodeURIComponent(request.mint)}` : '';
    void chrome.tabs.create({ url: chrome.runtime.getURL(`history.html${hash}`) });
    sendResponse({ ok: true });
    return false;
  }
  if (request.type === 'settings') {
    getSettings().then((settings) => sendResponse({ ok: true, settings }));
    return true;
  }
  return false;
});

// Nouveaux hébergeurs autorisés dans les réglages : les réseaux sont relus tout de suite.
chrome.permissions?.onAdded?.addListener(() => socialsCache.clear());

const ALARM = 'update-check';
function scheduleChecks(): void {
  chrome.alarms?.create(ALARM, { periodInMinutes: 180 });
  void flagUpdate();
  // Ré-analyses de suivi en attente (le navigateur a pu être fermé entre-temps) : reprises.
  void history.followUps().then((list) => {
    if (list.length === 0) return;
    armFollowUps();
    void runFollowUps();
  });
}
chrome.runtime.onStartup?.addListener(scheduleChecks);
chrome.runtime.onInstalled?.addListener(scheduleChecks);
chrome.alarms?.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM) void flagUpdate();
  if (alarm.name === FOLLOW_UP_ALARM) void runFollowUps();
});
