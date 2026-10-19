/**
 * Positions de paper trading DryFlip, lues sur la page du token.
 *
 * DryFlip (extension tierce) garde tout dans son propre stockage, et une
 * extension ne peut pas lire celui d'une autre. En revanche, DryFlip affiche sa
 * position sur la page (Bought / Sold / Remaining / PnL) et, en option, une carte
 * flottante avec le solde : on lit ce qu'il affiche, comme l'utilisateur le voit.
 *
 * Ce module ne travaille que sur un arbre de textes (construit à partir du DOM
 * par paper-dom.ts) : il est pur et testable sans navigateur. La mise en page
 * exacte de DryFlip n'étant pas documentée, la lecture se fonde sur les
 * libellés, quelle que soit leur disposition (libellé au-dessus, à gauche ou
 * dans le même texte que la valeur).
 */

export type PaperUnit = 'SOL' | 'BNB' | 'ETH' | 'USD' | '';

export interface PaperAmount {
  value: number;
  unit: PaperUnit;
}

/** Position sur le token de la page. */
export interface PaperPosition {
  /** Montant investi (cumul des achats). */
  bought?: PaperAmount;
  sold?: PaperAmount;
  /** Valeur de ce qui reste en portefeuille. */
  remaining?: PaperAmount;
  /** Reste affiché en pourcentage de la position (« 0 % » une fois tout revendu). */
  remainingPct?: number;
  pnl?: PaperAmount;
  pnlPct?: number;
}

/** Carte flottante DryFlip : solde du portefeuille virtuel. */
export interface PaperWallet {
  balance?: PaperAmount;
  pnl?: PaperAmount;
  pnlPct?: number;
}

export interface PaperReading {
  position?: PaperPosition;
  wallet?: PaperWallet;
}

/** Résultat d'une lecture de la page. */
export interface DryFlipScan {
  /** Un élément de DryFlip a été trouvé sur la page. */
  found: boolean;
  reading: PaperReading;
  /** Widget servi dans un iframe de l'extension DryFlip : illisible depuis une autre extension. */
  framed?: boolean;
}

/** Arbre de textes : un élément (enfants) ou un texte, avec sa teinte s'il est nettement rouge ou vert. */
export interface TextTree {
  text?: string;
  tone?: 'up' | 'down';
  children?: TextTree[];
}

type Field = 'bought' | 'sold' | 'remaining' | 'pnl' | 'balance';

/**
 * Libellés reconnus. Volontairement au passé (« Bought », pas « Buy ») : les
 * boutons d'achat rapide (« Buy 0.5 ») ne sont pas une position.
 */
const LABELS: Array<[Field, RegExp]> = [
  ['bought', /^(total )?(bought|invested|spent|achet[ée]|investi)$/],
  ['sold', /^(total )?(sold|vendu)$/],
  ['remaining', /^(remaining|holding|holdings|current value|value|restant|reste)$/],
  ['pnl', /^((total|unrealized|unrealised|realized|realised|live) )?(pnl|p&l|p\/l|profit|profit\/loss)$/],
  ['balance', /^((wallet|paper|virtual|sol|bnb) )?(balance|solde)$/],
];

interface Label {
  field: Field;
  /** Unité écrite dans le libellé : « Bought (SOL) ». */
  unit: PaperUnit;
}

function unitOf(token: string): PaperUnit {
  const t = token.toLowerCase();
  if (t === 'sol' || t === '◎') return 'SOL';
  if (t === 'bnb') return 'BNB';
  if (t === 'eth' || t === 'Ξ') return 'ETH';
  if (t === '$' || t === 'usd' || t === 'usdc' || t === 'usdt') return 'USD';
  return '';
}

/** Libellé de position, avec son unité éventuelle ; null si ce n'en est pas un. */
export function parseLabel(text: string): Label | null {
  let t = text.toLowerCase().replace(/\s+/g, ' ').trim().replace(/[:：]$/, '').trim();
  let unit: PaperUnit = '';
  const hint = /\s*[([]\s*(sol|bnb|eth|usdc?|usdt|\$)\s*[)\]]$|\s+in (sol|bnb|eth|usd)$/.exec(t);
  if (hint) {
    unit = unitOf(hint[1] ?? hint[2] ?? '');
    t = t.slice(0, hint.index).trim();
  }
  if (!t || t.length > 24) return null;
  for (const [field, pattern] of LABELS) if (pattern.test(t)) return { field, unit };
  return null;
}

const MINUS = /[-−–]/;
const NUMBER =
  /([+\-−–]?)\s*([$◎Ξ]?)\s*([+\-−–]?)\s*(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:[.,]\d+)?)\s*([kmb](?![a-z]))?\s*(%|sol\b|bnb\b|eth\b|usdc?\b|usdt\b|\$)?/gi;

/** Teinte nettement rouge ou verte (perte / gain affichés sans signe). */
export function toneOf(color: string): 'up' | 'down' | undefined {
  const rgb = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/.exec(color);
  if (rgb) {
    const [r, g, b] = [Number(rgb[1]) / 255, Number(rgb[2]) / 255, Number(rgb[3]) / 255];
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const l = (max + min) / 2;
    const d = max - min;
    if (d < 0.2 || l < 0.2 || l > 0.9) return undefined;
    const hue = max === r ? (60 * ((g - b) / d) + 360) % 360 : max === g ? 60 * ((b - r) / d) + 120 : 60 * ((r - g) / d) + 240;
    if (hue <= 20 || hue >= 340) return 'down';
    if (hue >= 85 && hue <= 170) return 'up';
    return undefined;
  }
  const oklch = /oklch\(\s*([\d.]+%?)\s+([\d.]+)\s+([\d.]+)/.exec(color);
  if (oklch && Number(oklch[2]) > 0.08) {
    const hue = Number(oklch[3]);
    if (hue <= 40 || hue >= 340) return 'down';
    if (hue >= 125 && hue <= 175) return 'up';
  }
  return undefined;
}

/** Montant et pourcentage contenus dans un texte (« +0.32 SOL (+25.1%) »). */
export function parseValue(text: string, tone?: 'up' | 'down', unitHint: PaperUnit = ''): { amount?: PaperAmount; pct?: number } {
  const out: { amount?: PaperAmount; pct?: number } = {};
  for (const match of text.matchAll(NUMBER)) {
    const [, sign1 = '', prefix = '', sign2 = '', digits = '', scale = '', suffix = ''] = match;
    let raw = digits;
    raw = /^\d{1,3}(,\d{3})+(\.\d+)?$/.test(raw) ? raw.replace(/,/g, '') : raw.replace(',', '.');
    let value = Number(raw) * ({ k: 1e3, m: 1e6, b: 1e9 }[scale.toLowerCase()] ?? 1);
    if (!Number.isFinite(value)) continue;
    const explicit = MINUS.test(sign1) || MINUS.test(sign2) ? -1 : sign1 === '+' || sign2 === '+' ? 1 : 0;
    // Signe absent : la couleur du texte fait foi (perte en rouge sans « − »).
    if (explicit === -1 || (explicit === 0 && tone === 'down')) value = -value;
    if (suffix === '%') {
      out.pct ??= value;
      continue;
    }
    if (out.amount) continue;
    out.amount = { value, unit: unitOf(prefix || suffix) || unitHint };
  }
  return out;
}

interface Leaf {
  text: string;
  tone?: 'up' | 'down';
  /** Ancêtres, de la racine au parent direct. */
  path: TextTree[];
}

const MAX_LEAVES = 600;

function flatten(root: TextTree): { leaves: Leaf[]; range: Map<TextTree, [number, number]> } {
  const leaves: Leaf[] = [];
  const range = new Map<TextTree, [number, number]>();
  const walk = (node: TextTree, path: TextTree[]) => {
    if (leaves.length >= MAX_LEAVES) return;
    const start = leaves.length;
    const text = node.text?.replace(/\s+/g, ' ').trim();
    if (text) leaves.push({ text, ...(node.tone ? { tone: node.tone } : {}), path });
    for (const child of node.children ?? []) walk(child, [...path, node]);
    range.set(node, [start, leaves.length - 1]);
  };
  walk(root, []);
  return { leaves, range };
}

/** Libellé suivi de sa valeur dans le même texte : « Bought: 1.5 SOL ». */
function inlineLabel(text: string): { label: Label; rest: string } | null {
  const cut = /[:：]\s*|\s+(?=[+\-−–$◎Ξ]?\s*\d)/.exec(text);
  if (!cut || cut.index === 0) return null;
  const label = parseLabel(text.slice(0, cut.index));
  const rest = text.slice(cut.index + cut[0].length);
  return label && /\d/.test(rest) ? { label, rest } : null;
}

interface Found {
  amount?: PaperAmount;
  pct?: number;
}

/** Lit toutes les valeurs étiquetées d'un arbre (première occurrence de chaque libellé). */
export function readFields(root: TextTree): Partial<Record<Field, Found>> {
  const { leaves, range } = flatten(root);
  const labels = leaves.map((leaf) => parseLabel(leaf.text));
  const fields: Partial<Record<Field, Found>> = {};
  const set = (field: Field, found: Found) => {
    if (fields[field] || (found.amount === undefined && found.pct === undefined)) return;
    fields[field] = found;
  };

  leaves.forEach((leaf, i) => {
    const inline = labels[i] ? null : inlineLabel(leaf.text);
    if (inline) return set(inline.label.field, parseValue(inline.rest, leaf.tone, inline.label.unit));
    const label = labels[i];
    if (!label || fields[label.field]) return;

    // Valeur rangée avec son libellé dans un même conteneur (le cas des cartes de stats).
    for (let up = 1; up <= 4 && up <= leaf.path.length; up++) {
      const [start, end] = range.get(leaf.path[leaf.path.length - up]!)!;
      let otherLabel = false;
      const parts: Leaf[] = [];
      for (let j = start; j <= end; j++) {
        if (j === i) continue;
        if (labels[j] || inlineLabel(leaves[j]!.text)) otherLabel = true;
        else parts.push(leaves[j]!);
      }
      if (otherLabel) break;
      if (parts.some((p) => /\d/.test(p.text))) {
        const tone = parts.find((p) => /\d/.test(p.text))?.tone;
        return set(label.field, parseValue(parts.map((p) => p.text).join(' '), tone, label.unit));
      }
    }

    // Repli : textes qui suivent le libellé, jusqu'au libellé suivant.
    const parts: Leaf[] = [];
    for (let j = i + 1; j < leaves.length && j <= i + 4 && !labels[j]; j++) parts.push(leaves[j]!);
    if (parts.some((p) => /\d/.test(p.text))) {
      const tone = parts.find((p) => /\d/.test(p.text))?.tone;
      set(label.field, parseValue(parts.map((p) => p.text).join(' '), tone, label.unit));
    }
  });
  return fields;
}

const nonZero = (amount?: PaperAmount) => amount !== undefined && Math.abs(amount.value) > 1e-12;

/**
 * Position et solde lus dans un widget DryFlip. Le widget du token porte les
 * achats et ventes ; la carte flottante, le solde : son PnL est celui du
 * portefeuille, pas du token.
 */
export function readPaper(root: TextTree): PaperReading {
  const f = readFields(root);
  const reading: PaperReading = {};
  const hasTrade = f.bought !== undefined || f.sold !== undefined || f.remaining !== undefined;
  if (hasTrade) {
    const position: PaperPosition = {
      ...(f.bought?.amount ? { bought: f.bought.amount } : {}),
      ...(f.sold?.amount ? { sold: f.sold.amount } : {}),
      ...(f.remaining?.amount ? { remaining: f.remaining.amount } : {}),
      ...(f.remaining?.pct !== undefined ? { remainingPct: f.remaining.pct } : {}),
      ...(f.pnl?.amount ? { pnl: f.pnl.amount } : {}),
      ...(f.pnl?.pct !== undefined ? { pnlPct: f.pnl.pct } : {}),
    };
    // « Bought 0 » : DryFlip affiche son widget, mais aucune position n'est ouverte.
    if (nonZero(position.bought) || nonZero(position.sold)) reading.position = position;
  }
  if (f.balance?.amount || (!hasTrade && f.pnl)) {
    reading.wallet = {
      ...(f.balance?.amount ? { balance: f.balance.amount } : {}),
      ...(!hasTrade && f.pnl?.amount ? { pnl: f.pnl.amount } : {}),
      ...(!hasTrade && f.pnl?.pct !== undefined ? { pnlPct: f.pnl.pct } : {}),
    };
  }
  return reading;
}

/** Nombre de libellés distincts reconnus : sert à repérer le conteneur du widget. */
export function labelCount(root: TextTree): number {
  return Object.keys(readFields(root)).length;
}

/** Fusionne les lectures de plusieurs widgets DryFlip de la page. */
export function mergeReadings(readings: PaperReading[]): PaperReading {
  const position = readings.find((r) => r.position)?.position;
  const wallet = readings.find((r) => r.wallet?.balance)?.wallet ?? readings.find((r) => r.wallet)?.wallet;
  return { ...(position ? { position } : {}), ...(wallet ? { wallet } : {}) };
}

/** Clé des opérations : change à chaque achat ou vente, pas à chaque variation de prix. */
export function tradeKey(position: PaperPosition | undefined): string {
  if (!position) return '';
  const v = (a?: PaperAmount) => (a ? `${a.value}${a.unit}` : '-');
  return `${v(position.bought)}|${v(position.sold)}`;
}

/** Clé complète (position + PnL) : détecte un changement à afficher ou enregistrer. */
export function positionKey(position: PaperPosition | undefined): string {
  if (!position) return '';
  const v = (a?: PaperAmount) => (a ? `${a.value}${a.unit}` : '-');
  return `${tradeKey(position)}|${v(position.remaining)}|${position.remainingPct ?? '-'}|${v(position.pnl)}|${position.pnlPct ?? '-'}`;
}

/**
 * Position fermée : tout a été revendu. Le reste peut s'afficher à zéro, en
 * pourcentage (« 0 % »), ou garder une poussière d'arrondi (moins de 1 % du
 * montant investi).
 */
export function isClosed(position: PaperPosition | undefined): boolean {
  if (!position || !nonZero(position.sold)) return false;
  if (position.remainingPct !== undefined && position.remainingPct < 1) return true;
  const rest = position.remaining;
  if (!rest) return false;
  if (!nonZero(rest)) return true;
  const bought = position.bought;
  return bought !== undefined && bought.unit === rest.unit && bought.value > 0 && Math.abs(rest.value) < bought.value * 0.01;
}

/** Achat supplémentaire (ou premier achat) par rapport à la position connue. */
export function isNewBuy(before: PaperPosition | undefined, after: PaperPosition): boolean {
  if (!nonZero(after.bought)) return false;
  if (!before?.bought) return true;
  if (before.bought.unit !== after.bought!.unit) return true;
  return after.bought!.value > before.bought.value * (1 + 1e-6) + 1e-9;
}

/** « 1,25 SOL », « 45,2 $ », « +0,32 SOL » (signé). */
export function formatAmount(amount: PaperAmount, signed = false): string {
  const abs = Math.abs(amount.value);
  const digits = abs >= 1000 ? 0 : abs >= 100 ? 1 : abs >= 1 ? 2 : abs >= 0.01 ? 3 : 5;
  const text = abs.toLocaleString('fr-FR', { maximumFractionDigits: digits });
  const sign = amount.value < 0 ? '−' : signed && amount.value > 0 ? '+' : '';
  const unit = amount.unit === 'USD' ? ' $' : amount.unit ? ` ${amount.unit}` : '';
  return `${sign}${text}${unit}`;
}

export function formatPct(pct: number): string {
  const sign = pct < 0 ? '−' : pct > 0 ? '+' : '';
  return `${sign}${Math.abs(pct).toLocaleString('fr-FR', { maximumFractionDigits: Math.abs(pct) >= 100 ? 0 : 1 })} %`;
}
