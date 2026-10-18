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
import { toPanelResult } from './panel-result.js';
import { ConfigError, explainRpcError, isBrowserHostile, RetryableError } from './rpc-errors.js';

export { ConfigError, explainRpcError, isBrowserHostile, RetryableError };

export interface Settings {
  rpcUrl: string;
  /** Recensement complet des holders : précis mais lent et souvent bloqué. */
  holderCensus: boolean;
  autoScan: boolean;
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
  holderCensus: false,
  autoScan: true,
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
  result: ScanResult;
}

const cache = new Map<string, CacheEntry>();

/**
 * Scans en vol : deux onglets sur le même token partagent la même requête.
 * `waiters` compte les onglets qui attendent ce résultat ; quand plus aucun ne
 * l'attend (l'utilisateur est passé à un autre token), le scan est annulé.
 */
interface Flight {
  task: Promise<ScanResult>;
  controller: AbortController;
  waiters: number;
}
const inFlight = new Map<string, Flight>();
/** Dernier token demandé par chaque onglet. */
const tabTokens = new Map<number, string>();

function remember(mint: string, result: ScanResult): void {
  if (cache.size >= CACHE_MAX) {
    // Map conserve l'ordre d'insertion : la première clé est la plus ancienne.
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(mint, { at: Date.now(), result });
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

export async function scan(mintArg: string, tabId?: number): Promise<ScanResult> {
  const mint = parseMint(mintArg).toBase58();

  // Token précédent de cet onglet : l'utilisateur l'a quitté, son scan peut être annulé.
  const previous = tabId !== undefined ? tabTokens.get(tabId) : undefined;
  if (tabId !== undefined) {
    tabTokens.set(tabId, mint);
    if (previous && previous !== mint) release(previous);
  }

  const hit = cache.get(mint);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.result;

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
    .then((result) => {
      remember(mint, result);
      return result;
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

export interface UpdateState {
  current: string;
  latest?: string;
  url: string;
  hasUpdate: boolean;
}

/**
 * Compare la version de l'extension à la dernière publiée sur GitHub.
 *
 * Note : une extension installée depuis le Chrome Web Store se met à jour
 * toute seule, sans ce code. Cette vérification sert aux installations
 * « décompressée » (chargées à la main), qui ne reçoivent jamais de mise à
 * jour automatique — c'est le cas d'une extension qu'on se distribue à soi-même.
 */
export async function checkUpdate(): Promise<UpdateState> {
  const current = chrome.runtime.getManifest().version;
  const fallback: UpdateState = { current, url: `https://github.com/${REPO}/releases`, hasUpdate: false };
  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: { accept: 'application/vnd.github+json' },
    });
    if (!res.ok) return fallback;
    const release = (await res.json()) as { tag_name?: string; html_url?: string; draft?: boolean; prerelease?: boolean };
    if (!release.tag_name || release.draft || release.prerelease) return fallback;
    const latest = release.tag_name.replace(/^v/, '');
    return {
      current,
      latest,
      url: release.html_url ?? fallback.url,
      hasUpdate: compareVersions(latest, current) > 0,
    };
  } catch {
    // Hors ligne ou quota d'API épuisé : jamais bloquant.
    return fallback;
  }
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

type Request =
  | { type: 'scan'; mint: string }
  | { type: 'update' }
  | { type: 'settings' }
  | { type: 'open-options' };

chrome.runtime.onMessage.addListener((request: Request, _sender, sendResponse) => {
  // `sendResponse` asynchrone impose de renvoyer `true` : sans ça, Chrome
  // ferme le canal avant la réponse et l'appelant reçoit `undefined`.
  if (request.type === 'scan') {
    scan(request.mint, _sender.tab?.id)
      // Résultat réduit à ce qu'affiche le panneau : un ScanResult complet contient des
      // BigInt que la messagerie de Chrome ne sait pas sérialiser.
      .then((result) => sendResponse({ ok: true, result: toPanelResult(result) }))
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
    checkUpdate().then((state) => sendResponse({ ok: true, state }));
    return true;
  }
  if (request.type === 'open-options') {
    // Seul le contexte de l'extension peut l'ouvrir : le content script doit
    // obligatoirement passer par ce message.
    chrome.runtime.openOptionsPage();
    sendResponse({ ok: true });
    return false;
  }
  if (request.type === 'settings') {
    getSettings().then((settings) => sendResponse({ ok: true, settings }));
    return true;
  }
  return false;
});

// Vérification au démarrage : une pastille sur l'icône, rien d'intrusif.
chrome.runtime.onStartup?.addListener(() => void flagUpdate());
chrome.runtime.onInstalled?.addListener(() => void flagUpdate());

async function flagUpdate(): Promise<void> {
  const state = await checkUpdate();
  if (!state.hasUpdate) return;
  await chrome.action.setBadgeText({ text: 'MAJ' });
  await chrome.action.setBadgeBackgroundColor({ color: '#2563eb' });
}
