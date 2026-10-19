/**
 * Repère le widget DryFlip dans la page et le convertit en arbre de textes pour
 * paper.ts. Content script uniquement.
 *
 * DryFlip s'injecte dans la page du terminal (Axiom, GMGN, Padre…) : ses
 * éléments partagent le DOM du site, éventuellement dans un shadow DOM, fermé
 * ou non (`chrome.dom.openOrClosedShadowRoot` les ouvre aux content scripts).
 * On ne lit que ce qui est identifiable comme DryFlip (classe, identifiant,
 * ressource de l'extension ou texte « DryFlip ») : jamais le reste de la page,
 * où le terminal affiche les positions du vrai wallet.
 */
import { labelCount, mergeReadings, readPaper, toneOf, type DryFlipScan, type TextTree } from './paper.js';

export type { DryFlipScan };

/** Identifiant de DryFlip sur le Chrome Web Store : ses images sont servies depuis cette origine. */
export const DRYFLIP_EXTENSION_ID = 'aehjhejjgmbhahniliogialmockfojib';
const ORIGIN = `chrome-extension://${DRYFLIP_EXTENSION_ID}/`;
const MARKS = [
  '[id*="dryflip" i]',
  '[class*="dryflip" i]',
  '[id*="dry-flip" i]',
  '[class*="dry-flip" i]',
  '[data-dryflip]',
  `img[src^="${ORIGIN}"]`,
  `[style*="${DRYFLIP_EXTENSION_ID}"]`,
].join(',');
const FRAMES = `iframe[src^="${ORIGIN}"]`;
const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'svg', 'CANVAS', 'VIDEO', 'IFRAME', 'INPUT', 'TEXTAREA', 'SELECT']);
const TEXT_MARK = /dry\s?flip/i;
/** Au-delà, on est sorti du widget : c'est la page du terminal. */
const MAX_WIDGET_LEAVES = 500;

type Scope = Document | ShadowRoot;

function shadowOf(el: Element): ShadowRoot | null {
  if (el.shadowRoot) return el.shadowRoot;
  try {
    return chrome.dom?.openOrClosedShadowRoot?.(el as HTMLElement) ?? null;
  } catch {
    return null;
  }
}

const parentOf = (node: Element): Element | null => node.parentElement ?? ((node.parentNode as ShadowRoot | null)?.host ?? null);

function visible(el: Element): boolean {
  const check = (el as Element & { checkVisibility?: (o?: object) => boolean }).checkVisibility;
  return typeof check === 'function' ? check.call(el, { checkOpacity: true, checkVisibilityCSS: true }) : true;
}

/** Arbre de textes d'un élément (shadow DOM compris), borné. `ownId` : notre panneau, ignoré. */
export function toTree(root: Node, ownId: string, budget = { left: 1_500 }): TextTree | null {
  if (budget.left-- <= 0) return null;
  if (root.nodeType === Node.TEXT_NODE) {
    const text = root.textContent ?? '';
    if (!text.trim()) return null;
    const parent = root.parentElement;
    const tone = parent ? toneOf(getComputedStyle(parent).color) : undefined;
    return { text, ...(tone ? { tone } : {}) };
  }
  const children: TextTree[] = [];
  const add = (node: Node) => {
    const tree = toTree(node, ownId, budget);
    if (tree) children.push(tree);
  };
  if (root.nodeType === Node.ELEMENT_NODE) {
    const el = root as Element;
    if (SKIP.has(el.tagName) || el.id === ownId || !visible(el)) return null;
    if (el.tagName === 'IMG') {
      // Logo d'unité (SOL, BNB) affiché en image à côté du nombre.
      const alt = (el.getAttribute('alt') ?? '').trim();
      // Logo « DryFlip » en image : repère de l'en-tête (le solde le suit).
      if (/^dry\s?flip$/i.test(alt)) return { text: alt };
      const src = el.getAttribute('src') ?? '';
      const unit = /^(sol|bnb|eth|usd)$/i.test(alt) ? alt : /solana|\bsol\b|sol[-_.]/i.test(src) ? 'SOL' : /bnb|binance/i.test(src) ? 'BNB' : '';
      return unit ? { text: unit } : null;
    }
    const shadow = shadowOf(el);
    if (shadow) shadow.childNodes.forEach(add);
  }
  root.childNodes.forEach(add);
  return children.length ? { children } : null;
}

function leafCount(tree: TextTree | null): number {
  if (!tree) return 0;
  return (tree.text ? 1 : 0) + (tree.children ?? []).reduce((n, c) => n + leafCount(c), 0);
}

/** Portées où chercher : le document et les shadow DOM (ceux du premier niveau, ou tous). */
function scopes(doc: Document, ownId: string, deep: boolean): Scope[] {
  const out: Scope[] = [doc];
  const visit = (scope: Scope) => {
    const candidates = deep ? scope.querySelectorAll('*') : [...(doc.body?.children ?? []), ...doc.documentElement.children];
    for (const el of candidates) {
      if (el.id === ownId) continue;
      const shadow = shadowOf(el);
      if (shadow && !out.includes(shadow)) {
        out.push(shadow);
        if (deep) visit(shadow);
      }
    }
  };
  visit(doc);
  return out;
}

interface Marker {
  el: Element;
  how: 'classe/id' | 'ressource' | 'texte' | 'shadow';
}

function findMarkers(doc: Document, ownId: string, deep: boolean): { markers: Marker[]; framed: boolean } {
  const markers: Marker[] = [];
  let framed = false;
  for (const scope of scopes(doc, ownId, deep)) {
    if (scope.querySelector(FRAMES)) framed = true;
    for (const el of scope.querySelectorAll(MARKS)) {
      markers.push({ el, how: el.tagName === 'IMG' || el.hasAttribute('style') ? 'ressource' : 'classe/id' });
    }
    // Shadow DOM dont l'hôte est marqué DryFlip : tout son contenu est à DryFlip.
    if (scope instanceof ShadowRoot && TEXT_MARK.test(`${scope.host.id} ${scope.host.className} ${scope.host.tagName}`)) {
      markers.push({ el: scope.host, how: 'shadow' });
    }
    if (!deep) continue;
    // Texte « DryFlip » (titre ou logo du widget) : marque la moins forte, et la plus coûteuse
    // à chercher (tous les textes de la page) : seulement lors des recherches complètes.
    const walker = (scope instanceof ShadowRoot ? scope.ownerDocument : scope).createTreeWalker(scope, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(), n = 0; node && n < 40_000; node = walker.nextNode(), n++) {
      if (TEXT_MARK.test(node.textContent ?? '') && node.parentElement && !node.parentElement.closest(`#${ownId}`)) {
        markers.push({ el: node.parentElement, how: 'texte' });
      }
    }
  }
  return { markers, framed };
}

/** Plus petit conteneur, autour d'une marque DryFlip, qui porte au moins deux libellés de position. */
function containerFor(marker: Element, ownId: string): Element | null {
  let node: Element | null = marker;
  for (let up = 0; node && up < 8; up++) {
    const tree = toTree(node, ownId);
    if (tree && labelCount(tree) >= 2) return node;
    if (leafCount(tree) > MAX_WIDGET_LEAVES) return null;
    node = parentOf(node);
  }
  return null;
}


/**
 * Lecteur avec mémoire : les conteneurs trouvés sont relus tels quels tant
 * qu'ils restent dans la page ; la recherche complète (coûteuse sur un terminal
 * chargé) n'est refaite qu'à intervalle.
 */
export class DryFlipReader {
  private containers: Element[] = [];
  private markerSeen = false;
  private lastDeep = 0;

  constructor(
    private readonly ownId: string,
    private readonly deepEveryMs = 10_000,
  ) {}

  read(doc: Document = document, now = Date.now()): DryFlipScan {
    let framed = false;
    const alive = this.containers.length > 0 && this.containers.every((c) => c.isConnected);
    // Widget retiré (navigation vers un autre token) : on le recherche partout tout de suite.
    if (this.containers.length && !alive) this.lastDeep = 0;
    const due = now - this.lastDeep >= this.deepEveryMs;
    if (!alive || due) {
      if (due) this.lastDeep = now;
      const found = findMarkers(doc, this.ownId, due);
      framed = found.framed;
      const containers = found.markers.map((m) => containerFor(m.el, this.ownId)).filter((c): c is Element => c !== null);
      // Un conteneur inclus dans un autre est déjà lu avec lui.
      const outer = [...new Set(containers)].filter((c, _, all) => !all.some((o) => o !== c && o.contains(c)));
      // Recherche rapide qui ne voit pas un widget trouvé en profondeur : on garde celui-ci.
      if (outer.length || !alive) this.containers = outer;
      if (due || found.markers.length) this.markerSeen = found.markers.length > 0;
    }
    const readings = this.containers.map((c) => toTree(c, this.ownId)).filter((t): t is TextTree => t !== null).map(readPaper);
    return { found: this.markerSeen || this.containers.length > 0 || framed, reading: mergeReadings(readings), ...(framed ? { framed } : {}) };
  }
}

const describe = (el: Element) =>
  `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}${typeof el.className === 'string' && el.className ? `.${el.className.trim().split(/\s+/).slice(0, 4).join('.')}` : ''}`.slice(0, 120);

function leafTexts(tree: TextTree | null, out: string[] = []): string[] {
  if (!tree || out.length >= 150) return out;
  if (tree.text) out.push(`${tree.text.trim().slice(0, 60)}${tree.tone ? ` [${tree.tone === 'up' ? 'vert' : 'rouge'}]` : ''}`);
  for (const child of tree.children ?? []) leafTexts(child, out);
  return out;
}

/**
 * Diagnostic à copier quand la position n'est pas lue : où se trouve DryFlip et
 * ce qu'il affiche. Seuls les textes des éléments DryFlip sont inclus, jamais
 * ceux du reste de la page.
 */
export function diagnose(ownId: string, doc: Document = document): Record<string, unknown> {
  const { markers, framed } = findMarkers(doc, ownId, true);
  const allScopes = scopes(doc, ownId, true);
  return {
    page: `${location.hostname}${location.pathname}`,
    framedWidget: framed,
    shadowRoots: allScopes.filter((s): s is ShadowRoot => s instanceof ShadowRoot).map((s) => describe(s.host)),
    markers: markers.slice(0, 12).map((m) => {
      const container = containerFor(m.el, ownId);
      const chain: string[] = [];
      for (let node: Element | null = m.el, i = 0; node && i < 6; node = parentOf(node), i++) chain.push(describe(node));
      return {
        how: m.how,
        element: chain,
        container: container ? describe(container) : null,
        texts: leafTexts(toTree(container ?? m.el, ownId)),
      };
    }),
  };
}
