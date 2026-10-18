/**
 * Content script : détecte le token regardé et affiche le verdict par-dessus
 * le site, quel qu'il soit.
 *
 * Deux contraintes dictent la conception :
 *
 *  1. ISOLATION — le panneau vit dans un shadow DOM. Sans lui, le CSS de Padre
 *     ou d'Axiom repeindrait le panneau, et le nôtre déborderait sur le leur.
 *     C'est ce qui permet au même code de s'afficher correctement partout.
 *
 *  2. NAVIGATION SANS RECHARGEMENT — ces terminaux sont des SPA : passer d'un
 *     token à l'autre ne recharge jamais la page. Un script qui ne lirait
 *     l'URL qu'au chargement afficherait éternellement le premier token.
 *     D'où la surveillance de l'historique.
 */
import { detectToken, type Detection } from './detect.js';
import { describeMissingModule } from './panel-result.js';
import { safeUrl, twitterLabel, type DevInfo, type Socials } from './socials.js';

interface Finding {
  severity: 'critical' | 'warning' | 'info' | 'ok';
  message: string;
}
interface ScanModule {
  label: string;
  score: number | null;
  findings: Finding[];
  unavailableReason?: string;
}
interface ScanLike {
  risk: { score: number; level: 'VERT' | 'ORANGE' | 'ROUGE'; confidence: number; modules: ScanModule[] };
  mint?: string;
  token?: { mint?: string; uri?: string };
  /** Adresse du dev (créateur), si identifiée. */
  creator?: string;
  /** Adresse de la page quand ce n'était pas le mint (bonding curve, pool) : le moteur a remonté jusqu'au token. */
  resolvedFrom?: { address: string; kind: string };
  /** Analyses précédentes du même token, pour afficher l'évolution de la note. */
  history?: { count: number; first: { at: number; score: number }; previous?: { at: number; score: number } };
}

type ScanResponse = { ok: true; result: ScanLike } | { ok: false; error: string; action?: 'options' | 'retry' };

const PANEL_ID = 'solana-risk-scanner-panel';
let host: HTMLElement | null = null;
let shadow: ShadowRoot | null = null;
let currentMint: string | null = null;
let dismissed = new Set<string>();
/** Extension rechargée ou mise à jour pendant que la page restait ouverte : ce script est orphelin. */
let orphaned = false;

/**
 * Vrai tant que ce script est relié à l'extension. Après un rechargement dans
 * chrome://extensions, les onglets déjà ouverts gardent l'ancien script : tout
 * appel à chrome.runtime y lève « Extension context invalidated ».
 */
function extensionAlive(): boolean {
  try {
    return Boolean(chrome.runtime?.id);
  } catch {
    return false;
  }
}

const isInvalidated = (error: unknown) => /context invalidated/i.test(error instanceof Error ? error.message : String(error));

// ---------------------------------------------------------------------------
// Panneau
// ---------------------------------------------------------------------------

const STYLE = `
:host { all: initial; }
.panel {
  position: fixed; top: 76px; right: 16px; z-index: 2147483647;
  width: 310px; max-height: 70vh; overflow: auto;
  font: 13px/1.45 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  color: #e8eaed; background: #14161a; border: 1px solid #2a2e35;
  border-radius: 10px; box-shadow: 0 10px 32px rgba(0,0,0,.55);
}
.head { display: flex; align-items: center; gap: 8px; padding: 10px 12px; border-bottom: 1px solid #2a2e35; }
.score { font-size: 21px; font-weight: 700; font-variant-numeric: tabular-nums; }
.level { font-size: 11px; font-weight: 700; letter-spacing: .06em; padding: 2px 7px; border-radius: 999px; }
.scale { font-size: 10px; color: #8b9199; margin-left: auto; text-align: right; line-height: 1.3; }
.close { cursor: pointer; background: none; border: 0; color: #8b9199; font-size: 17px; padding: 0 2px; }
.close:hover { color: #e8eaed; }
.body { padding: 9px 12px 11px; }
.row { display: flex; gap: 7px; align-items: flex-start; margin: 5px 0; }
.dot { flex: 0 0 auto; margin-top: 6px; width: 6px; height: 6px; border-radius: 50%; }
.muted { color: #8b9199; font-size: 11px; }
.warn { margin: 8px 0 2px; padding: 7px 8px; border-radius: 6px; background: #3a2a06; color: #fbbf24; font-size: 11px; line-height: 1.45; }
.mint { font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 10px; color: #6b7280; word-break: break-all; }
.vert   { color: #34d399; } .bg-vert   { background: #34d399; color: #04281c; }
.orange { color: #fbbf24; } .bg-orange { background: #fbbf24; color: #2d1f02; }
.rouge  { color: #f87171; } .bg-rouge  { background: #f87171; color: #2d0606; }
.spin { color: #8b9199; padding: 12px; }
.err  { color: #fbbf24; padding: 10px 12px; font-size: 12px; line-height: 1.5; }
.act  { margin: 10px 12px 12px; padding: 7px 12px; border: 0; border-radius: 6px; background: #2563eb; color: #fff; font: inherit; font-weight: 600; cursor: pointer; }
.act:hover { background: #1d4ed8; }
.icon { cursor: pointer; background: none; border: 1px solid #2a2e35; border-radius: 6px; color: #c3c7ce; font-size: 13px; line-height: 1; padding: 4px 6px; }
.icon:hover { color: #fff; border-color: #3b414b; }
.icon:disabled { cursor: progress; opacity: .6; }
.busy .body { opacity: .5; }
.hist { margin-top: 8px; padding-top: 7px; border-top: 1px solid #2a2e35; font-size: 11px; color: #8b9199; line-height: 1.5; }
.up { color: #f87171; font-weight: 600; } .down { color: #34d399; font-weight: 600; }
.link { cursor: pointer; background: none; border: 0; padding: 0; color: #60a5fa; font: inherit; font-size: 11px; }
.link:hover { text-decoration: underline; }
.socials { margin: 8px 0 4px; font-size: 12px; color: #c3c7ce; line-height: 1.5; }
.lnk { color: #60a5fa; text-decoration: none; } .lnk:hover { text-decoration: underline; }
.version { padding: 0 12px 8px; font-size: 10px; color: #6b7280; text-align: right; }
`;

function ensurePanel(): ShadowRoot {
  if (shadow) return shadow;
  host = document.createElement('div');
  host.id = PANEL_ID;
  // `all: initial` sur :host plus un shadow fermé : le site hôte ne peut ni
  // styler ni interroger le panneau.
  shadow = host.attachShadow({ mode: 'closed' });
  const style = document.createElement('style');
  style.textContent = STYLE;
  shadow.append(style);
  document.documentElement.append(host);
  return shadow;
}

function removePanel(): void {
  host?.remove();
  host = null;
  shadow = null;
}

const levelClass = (level: string) => (level === 'ROUGE' ? 'rouge' : level === 'ORANGE' ? 'orange' : 'vert');

function render(nodes: (Node | string)[]): void {
  const root = ensurePanel();
  for (const child of [...root.children]) if (child.tagName !== 'STYLE') child.remove();
  const panel = document.createElement('div');
  panel.className = 'panel';
  panel.append(...nodes);
  if (VERSION) panel.append(el('div', 'version', `Solana Token Risk Scanner ${VERSION}`));
  root.append(panel);
}

/** Version chargée : permet de vérifier d'un coup d'œil que la mise à jour est bien active. */
const VERSION = (() => {
  try {
    return `v${chrome.runtime.getManifest().version}`;
  } catch {
    return '';
  }
})();

function el(tag: string, className: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function showLoading(detection: Detection): void {
  const body = el('div', 'spin', `Analyse de ${detection.address.slice(0, 6)}…${detection.address.slice(-4)}`);
  render([body]);
}

/**
 * Panneau d'erreur.
 *
 * `action` transforme un constat en geste : une erreur de configuration doit
 * ouvrir les réglages, pas laisser deviner. Afficher la réponse JSON brute du
 * RPC — « 403 : {"jsonrpc":"2.0",… } » — n'apprend rien à personne.
 */
function showError(message: string, action?: 'options' | 'retry'): void {
  const head = el('div', 'head');
  head.append(el('span', 'level bg-orange', 'ERREUR'));
  const close = el('button', 'close', '×');
  close.addEventListener('click', removePanel);
  head.append(close);

  const nodes: (Node | string)[] = [head, el('div', 'err', message)];
  if (action === 'retry') {
    const button = el('button', 'act', 'Réessayer');
    button.addEventListener('click', () => {
      currentMint = null;
      void evaluate();
    });
    nodes.push(button);
  }
  if (action === 'options') {
    const button = el('button', 'act', 'Ouvrir les réglages');
    button.addEventListener('click', () => {
      if (!extensionAlive()) return showOrphaned();
      void chrome.runtime.sendMessage({ type: 'open-options' }).catch(() => showOrphaned());
    });
    nodes.push(button);
  }
  render(nodes);
}

/** Heure courte : « 14:02 » le jour même, « 17/10 14:02 » sinon. */
function when(at: number): string {
  const d = new Date(at);
  const hm = d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  return d.toDateString() === new Date().toDateString() ? hm : `${d.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit' })} ${hm}`;
}

/** Variation de note : rouge si le risque monte, vert s'il baisse. */
function delta(now: number, before: number): HTMLElement {
  const diff = now - before;
  if (diff === 0) return el('span', '', '±0');
  return el('span', diff > 0 ? 'up' : 'down', diff > 0 ? `+${diff}` : String(diff));
}

/** Lien externe : uniquement http(s), ouvert dans un nouvel onglet, sans référent. */
function anchor(url: string, label: string): HTMLElement | null {
  const href = safeUrl(url);
  if (!href) return null;
  const a = document.createElement('a');
  a.className = 'lnk';
  a.href = href;
  a.target = '_blank';
  a.rel = 'noreferrer noopener';
  a.textContent = label;
  return a;
}

const shortAddr = (address: string) => `${address.slice(0, 4)}…${address.slice(-4)}`;

/**
 * Dev et réseaux sociaux du token. Chargés APRÈS l'affichage de la note, par une
 * demande séparée : ni la note ni son délai n'en dépendent.
 */
function socialsLine(result: ScanLike, address: string): HTMLElement | null {
  const creator = result.creator;
  const uri = result.token?.uri;
  if (!creator && !uri) return null;
  const line = el('div', 'socials');
  const dev = (info?: DevInfo) => {
    if (!creator) return [];
    const label = info?.username ? `@${info.username}` : shortAddr(creator);
    return ['Dev : ', anchor(`https://pump.fun/profile/${creator}`, label) ?? label];
  };
  line.append(...dev(), el('span', 'muted', creator ? ' · liens…' : 'liens…'));

  const fill = (socials: Socials, info?: DevInfo) => {
    const parts: (Node | string)[] = [];
    const add = (node: Node | string | null) => {
      if (!node) return;
      if (parts.length) parts.push(' · ');
      parts.push(node);
    };
    if (creator) {
      const [prefix, link] = dev(info);
      const devNode = el('span', '');
      devNode.append(prefix as string, link as Node | string);
      add(devNode);
    }
    if (socials.twitter) {
      const x = el('span', '');
      x.append('X : ', anchor(socials.twitter.url, twitterLabel(socials.twitter)) ?? '');
      add(x);
    }
    if (socials.telegram) add(anchor(socials.telegram, 'Telegram'));
    if (socials.website) add(anchor(socials.website, new URL(socials.website).hostname.replace(/^www\./, '')));
    if (!socials.twitter && !socials.telegram && !socials.website) add(el('span', 'muted', 'aucun réseau déclaré'));
    line.replaceChildren(...parts);
  };

  if (!extensionAlive()) return line;
  void chrome.runtime
    .sendMessage({ type: 'socials', mint: result.mint ?? address, uri, creator })
    .then((reply: { ok?: boolean; socials?: Socials; dev?: DevInfo } | undefined) => {
      if (currentMint !== address) return;
      fill(reply?.socials ?? {}, reply?.dev);
    })
    .catch(() => fill({}));
  return line;
}

/** Ligne d'évolution : analyses précédentes de ce token, et accès à l'historique complet. */
function historyLine(result: ScanLike, mint: string): HTMLElement {
  const line = el('div', 'hist');
  const h = result.history;
  if (h && h.count >= 2 && h.previous) {
    line.append(`Précédente : ${h.previous.score} à ${when(h.previous.at)} (`, delta(result.risk.score, h.previous.score), ')');
    if (h.count > 2) line.append(` · 1re : ${h.first.score} à ${when(h.first.at)} (`, delta(result.risk.score, h.first.score), ')');
    line.append(` · ${h.count} analyses · `);
  } else if (h) {
    line.append('Première analyse de ce token · ');
  }
  const open = el('button', 'link', 'Historique ›');
  open.addEventListener('click', () => {
    if (!extensionAlive()) return showOrphaned();
    void chrome.runtime.sendMessage({ type: 'open-history', mint: result.mint ?? mint }).catch(() => showOrphaned());
  });
  line.append(open);
  return line;
}

function showResult(mint: string, result: ScanLike): void {
  const { score, level } = result.risk;
  const cls = levelClass(level);

  const head = el('div', 'head');
  head.append(el('span', `score ${cls}`, String(score)));
  head.append(el('span', `level bg-${cls}`, level));
  const scale = el('div', 'scale');
  // Le sens de l'échelle est écrit à côté du chiffre : un « 75 » nu se lit
  // spontanément comme une note sur 100 où plus c'est haut, mieux c'est.
  scale.append(document.createTextNode('risque /100'));
  scale.append(document.createElement('br'));
  scale.append(document.createTextNode('0 = sain · 100 = danger'));
  head.append(scale);
  // Actualiser : relit la blockchain tout de suite (sans cache) et garde la mesure dans l'historique.
  const refresh = el('button', 'icon', '↻') as HTMLButtonElement;
  refresh.title = 'Actualiser la note';
  refresh.addEventListener('click', () => {
    refresh.disabled = true;
    refresh.textContent = '…';
    refresh.closest('.panel')?.classList.add('busy');
    void requestScan(mint, true);
  });
  head.append(refresh);
  const close = el('button', 'close', '×');
  close.addEventListener('click', () => {
    dismissed.add(mint);
    removePanel();
  });
  head.append(close);

  const body = el('div', 'body');
  // Un module absent, c'est un angle mort — pas une bonne nouvelle. Sans ce
  // bandeau, un token dont l'analyse des holders a échoué s'affiche VERT et
  // se lit comme « sain », alors que la mesure la plus importante manque.
  const missing = result.risk.modules.filter((m) => m.score === null);
  if (missing.length > 0) {
    // Chaque module manquant avec SA raison : un réglage désactivé n'est pas un RPC défaillant.
    const details = missing.map((m) => `${m.label} — ${describeMissingModule(m.unavailableReason)}`).join(' · ');
    const coverage = Math.round((result.risk.confidence ?? 0) * 100);
    body.append(el('div', 'warn', `Note incomplète (${coverage} % de couverture). Non analysé : ${details}.`));
  }

  // Critiques d'abord, puis alertes ; un même constat n'apparaît qu'une fois.
  const seen = new Set<string>();
  const findings = result.risk.modules
    .flatMap((m) => m.findings)
    .filter((f) => f.severity === 'critical' || f.severity === 'warning')
    .sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'critical' ? -1 : 1))
    .filter((f) => !seen.has(f.message) && Boolean(seen.add(f.message)))
    .slice(0, 7);

  if (findings.length === 0) {
    body.append(el('div', 'muted', 'Aucun signal critique détecté.'));
  } else {
    for (const finding of findings) {
      const row = el('div', 'row');
      const dot = el('span', `dot bg-${finding.severity === 'critical' ? 'rouge' : 'orange'}`);
      row.append(dot, el('span', '', finding.message));
      body.append(row);
    }
  }
  // Pages qui affichent la pool ou la bonding curve (Axiom, DexScreener, Photon) : on
  // montre le mint réellement analysé, et d'où il a été déduit.
  if (result.resolvedFrom && result.mint) {
    body.append(el('div', 'muted', `Token retrouvé depuis la ${result.resolvedFrom.kind} de la page :`));
    body.append(el('div', 'mint', result.mint));
  } else {
    body.append(el('div', 'mint', mint));
  }
  const socials = socialsLine(result, mint);
  if (socials) body.append(socials);
  body.append(historyLine(result, mint));
  render([head, body]);
}

// ---------------------------------------------------------------------------
// Cycle
// ---------------------------------------------------------------------------

/** Ce script n'est plus relié à l'extension (mise à jour, rechargement) : seule la page rafraîchie le remplace. */
function showOrphaned(): void {
  orphaned = true;
  const head = el('div', 'head');
  head.append(el('span', 'level bg-orange', 'MISE À JOUR'));
  const close = el('button', 'close', '×');
  close.addEventListener('click', removePanel);
  head.append(close);
  const reload = el('button', 'act', 'Rafraîchir la page');
  reload.addEventListener('click', () => location.reload());
  render([head, el('div', 'err', "L'extension a été rechargée ou mise à jour : rafraîchis la page (F5) pour réactiver l'analyse."), reload]);
}

async function evaluate(): Promise<void> {
  if (orphaned) return;
  if (!extensionAlive()) return showOrphaned();
  const detection = detectToken(location.href, document.body?.innerText);
  if (!detection) {
    if (currentMint !== null) {
      currentMint = null;
      removePanel();
    }
    return;
  }
  if (detection.address === currentMint) return;
  currentMint = detection.address;
  if (dismissed.has(detection.address)) return;

  // Adresse de pool ou de bonding curve (DexScreener, Photon, Axiom) : le moteur
  // vérifie le compte on-chain et remonte jusqu'au mint du token (PumpSwap,
  // Raydium, bonding curve Pump.fun), ou explique pourquoi c'est impossible.

  showLoading(detection);
  await requestScan(detection.address, false);
}

/**
 * Demande l'analyse au service worker et affiche le résultat. `force` (bouton
 * Actualiser) ignore le cache : la blockchain est relue immédiatement.
 */
async function requestScan(address: string, force: boolean): Promise<void> {
  try {
    if (!extensionAlive()) return showOrphaned();
    const response = (await chrome.runtime.sendMessage({ type: 'scan', mint: address, force })) as ScanResponse;
    // La page a pu changer pendant le scan : on n'écrase pas un verdict plus récent.
    if (currentMint !== address) return;
    if (response?.ok) showResult(address, response.result);
    else showError(response?.error ?? 'analyse impossible', response?.action);
  } catch (error) {
    if (isInvalidated(error) || !extensionAlive()) {
      showOrphaned();
      return;
    }
    if (currentMint === address) {
      showError(error instanceof Error ? error.message : String(error));
    }
  }
}

/**
 * Surveille les changements d'URL d'une SPA.
 *
 * `popstate` ne couvre que le bouton Retour : une navigation interne passe par
 * `pushState`/`replaceState`, qui n'émettent aucun événement. On les enveloppe.
 */
function watchNavigation(onChange: () => void): void {
  let last = location.href;
  const notify = () => {
    if (location.href === last) return;
    last = location.href;
    onChange();
  };
  for (const name of ['pushState', 'replaceState'] as const) {
    const original = history[name];
    history[name] = function patched(this: History, ...args: Parameters<History['pushState']>) {
      const out = original.apply(this, args);
      queueMicrotask(notify);
      return out;
    } as History[typeof name];
  }
  addEventListener('popstate', notify);
  // Filet : certaines SPA réécrivent l'URL par d'autres voies.
  setInterval(notify, 1_000);
}

void (async () => {
  // Panneau laissé par une ancienne instance de ce script (extension rechargée ou
  // réinstallée sans rafraîchir la page) : on le retire avant d'afficher le nôtre.
  document.getElementById(PANEL_ID)?.remove();

  // Le service worker peut être endormi : `sendMessage` rejette, ou résout avec
  // une réponse partielle. Les deux doivent être sans conséquence — un réglage
  // illisible ne doit pas priver l'utilisateur du panneau.
  const settings = (await chrome.runtime.sendMessage({ type: 'settings' }).catch(() => null)) as
    | { ok: true; settings?: { autoScan?: boolean } }
    | null;
  if (settings?.ok && settings.settings?.autoScan === false) return;

  watchNavigation(() => void evaluate());
  // Les terminaux peignent leur contenu après le premier rendu : on laisse
  // l'URL se stabiliser avant la première évaluation.
  setTimeout(() => void evaluate(), 600);
})();
