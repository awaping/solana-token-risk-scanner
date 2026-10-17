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
  token?: { mint?: string };
  /** Adresse de la page quand ce n'était pas le mint (bonding curve, pool) : le moteur a remonté jusqu'au token. */
  resolvedFrom?: { address: string; kind: string };
}

const PANEL_ID = 'solana-risk-scanner-panel';
let host: HTMLElement | null = null;
let shadow: ShadowRoot | null = null;
let currentMint: string | null = null;
let dismissed = new Set<string>();

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
.act  { margin: 10px 12px 12px; padding: 7px 12px; border: 0; border-radius: 6px; background: #2563eb; color: #fff; font: inherit; font-weight: 600; cursor: pointer; }
.act:hover { background: #1d4ed8; }
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
  root.append(panel);
}

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
function showError(message: string, action?: 'options'): void {
  const head = el('div', 'head');
  head.append(el('span', 'level bg-orange', 'ERREUR'));
  const close = el('button', 'close', '×');
  close.addEventListener('click', removePanel);
  head.append(close);

  const nodes: (Node | string)[] = [head, el('div', 'err', message)];
  if (action === 'options') {
    const button = el('button', 'act', 'Ouvrir les réglages');
    button.addEventListener('click', () => void chrome.runtime.sendMessage({ type: 'open-options' }));
    nodes.push(button);
  }
  render(nodes);
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
    const names = missing.map((m) => m.label).join(", ");
    const coverage = Math.round((result.risk.confidence ?? 0) * 100);
    body.append(
      el('div', 'warn', `Note incomplète (${coverage} % de couverture) — non analysé : ${names}. Ton RPC refuse les méthodes indexées : il faut un fournisseur qui les supporte (Helius, Alchemy, QuickNode).`),
    );
  }

  const findings = result.risk.modules
    .flatMap((m) => m.findings)
    .filter((f) => f.severity === 'critical' || f.severity === 'warning')
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
  render([head, body]);
}

// ---------------------------------------------------------------------------
// Cycle
// ---------------------------------------------------------------------------

async function evaluate(): Promise<void> {
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
  try {
    const response = (await chrome.runtime.sendMessage({ type: 'scan', mint: detection.address })) as
      | { ok: true; result: ScanLike }
      | { ok: false; error: string; action?: 'options' };
    // La page a pu changer pendant le scan : on n'écrase pas un verdict plus récent.
    if (currentMint !== detection.address) return;
    if (response?.ok) showResult(detection.address, response.result);
    else showError(response?.error ?? 'analyse impossible', response?.action);
  } catch (error) {
    if (currentMint === detection.address) {
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
