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
import { HistoryStore, type HistoryBrief } from './history-store.js';
import { toSnapshot } from './history-snapshot.js';
import { toPanelResult } from './panel-result.js';
import { ConfigError, explainRpcError, isBrowserHostile, RetryableError } from './rpc-errors.js';

export { ConfigError, explainRpcError, isBrowserHostile, RetryableError };

export interface Settings {
  rpcUrl: string;
  /** Recensement complet des holders : précis mais lent et souvent bloqué. */
  holderCensus: boolean;
  autoScan: boolean;
  /** Installe d'elle-même les nouvelles versions (nécessite l'assistant de mise à jour). */
  autoUpdate: boolean;
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
  if (flight.waiters <= 0) flight.controller.abort();
}

// ---------------------------------------------------------------------------
// Scan
// ---------------------------------------------------------------------------

/**
 * Analyse un token. `force` (bouton « Actualiser » du panneau) ignore le cache
 * pour relire la blockchain tout de suite.
 */
export async function scan(mintArg: string, tabId?: number, force = false): Promise<ScanOutcome> {
  const mint = parseMint(mintArg).toBase58();

  // Token précédent de cet onglet : l'utilisateur l'a quitté, son scan peut être annulé.
  const previous = tabId !== undefined ? tabTokens.get(tabId) : undefined;
  if (tabId !== undefined) {
    tabTokens.set(tabId, mint);
    if (previous && previous !== mint) release(previous);
  }

  const hit = cache.get(mint);
  if (!force && hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.outcome;

  const running = inFlight.get(mint);
  if (running && !running.controller.signal.aborted) {
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
      const brief = await history.record(toSnapshot(result)).catch(() => undefined);
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

  inFlight.set(mint, { task, controller, waiters: 1 });
  return task;
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
// Messages
// ---------------------------------------------------------------------------

type Request =
  | { type: 'scan'; mint: string; force?: boolean }
  | { type: 'update' }
  | { type: 'apply-update' }
  | { type: 'settings' }
  | { type: 'open-options' }
  | { type: 'open-history'; mint?: string };

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

const ALARM = 'update-check';
function scheduleChecks(): void {
  chrome.alarms?.create(ALARM, { periodInMinutes: 180 });
  void flagUpdate();
}
chrome.runtime.onStartup?.addListener(scheduleChecks);
chrome.runtime.onInstalled?.addListener(scheduleChecks);
chrome.alarms?.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM) void flagUpdate();
});
