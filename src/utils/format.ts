/**
 * Formatage console : couleurs ANSI (sans dépendance), nombres en locale
 * française et barres de progression.
 */

let colorEnabled = process.env.FORCE_COLOR ? true : !process.env.NO_COLOR && Boolean(process.stdout.isTTY);

export function setColorEnabled(enabled: boolean): void {
  colorEnabled = enabled;
}

const wrap = (open: number, close: number) => (text: string | number) =>
  colorEnabled ? `\u001b[${open}m${text}\u001b[${close}m` : String(text);

export const c = {
  bold: wrap(1, 22),
  dim: wrap(2, 22),
  red: wrap(31, 39),
  green: wrap(32, 39),
  yellow: wrap(33, 39),
  blue: wrap(34, 39),
  magenta: wrap(35, 39),
  cyan: wrap(36, 39),
  gray: wrap(90, 39),
  bgRed: wrap(41, 49),
  bgGreen: wrap(42, 49),
  bgYellow: wrap(43, 49),
};

// Les instances Intl.NumberFormat sont coûteuses à créer : cache par précision.
const formatters = new Map<number, Intl.NumberFormat>();
const nf = (digits: number): Intl.NumberFormat => {
  let formatter = formatters.get(digits);
  if (!formatter) {
    formatter = new Intl.NumberFormat('fr-FR', { minimumFractionDigits: digits, maximumFractionDigits: digits });
    formatters.set(digits, formatter);
  }
  return formatter;
};

/** 12.3456 → "12,35 %" */
export const fmtPct = (value: number, digits = 2): string => `${nf(digits).format(value)} %`;

/** Nombre avec séparateurs de milliers français. */
export const fmtNum = (value: number, digits = 0): string => nf(digits).format(value);

/** Montant en SOL avec une précision adaptée à l'ordre de grandeur. */
export function fmtSol(value: number): string {
  const digits = value === 0 ? 2 : value < 0.01 ? 6 : value < 1 ? 4 : 2;
  return `${nf(digits).format(value)} SOL`;
}

/** Prix très petit (ex : 2,8e-8 SOL) en notation lisible. */
export function fmtPrice(value: number): string {
  if (value === 0) return '0 SOL';
  if (value >= 0.0001) return fmtSol(value);
  return `${value.toExponential(4).replace('.', ',')} SOL`;
}

/** Montant brut (bigint) converti en unités UI. */
export function fmtTokenAmount(raw: bigint, decimals: number, digits = 0): string {
  const factor = 10n ** BigInt(decimals);
  const whole = raw / factor;
  const frac = Number(raw % factor) / Number(factor);
  return nf(digits).format(Number(whole) + frac);
}

export const shortAddr = (address: string, size = 4): string =>
  address.length <= size * 2 + 1 ? address : `${address.slice(0, size)}…${address.slice(-size)}`;

/** Barre horizontale proportionnelle (0-100). */
export function bar(value: number, width = 20, max = 100): string {
  const ratio = Math.min(1, Math.max(0, value / max));
  const filled = Math.round(ratio * width);
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

/** Couleur associée à un score de risque 0-100. */
export function colorForScore(score: number): (text: string | number) => string {
  if (score >= 70) return c.red;
  if (score > 30) return c.yellow;
  return c.green;
}

/**
 * Largeur d'un caractère dans un terminal : 0 (contrôle, marque combinante,
 * caractère invisible), 2 (idéogrammes CJK, emoji) ou 1.
 */
function charWidth(cp: number): number {
  if (cp < 0x20 || (cp >= 0x7f && cp < 0xa0)) return 0;
  if (
    (cp >= 0x300 && cp <= 0x36f) ||
    (cp >= 0x200b && cp <= 0x200f) ||
    (cp >= 0x202a && cp <= 0x202e) ||
    (cp >= 0x2060 && cp <= 0x206f) ||
    (cp >= 0xfe00 && cp <= 0xfe0f) ||
    cp === 0xfeff ||
    (cp >= 0x1f3fb && cp <= 0x1f3ff) ||
    (cp >= 0xe0000 && cp <= 0xe01ef)
  ) {
    return 0;
  }
  if (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    cp >= 0x1f000
  ) {
    return 2;
  }
  return 1;
}

const ANSI = /\u001b\[[0-9;]*m/g;

/** Largeur visible d'une chaîne dans un terminal (sans les séquences ANSI, emoji = 2 colonnes). */
export function visibleLength(text: string): number {
  let width = 0;
  for (const ch of text.replace(ANSI, '')) width += charWidth(ch.codePointAt(0)!);
  return width;
}

export const padEndVisible = (text: string, width: number): string =>
  text + ' '.repeat(Math.max(0, width - visibleLength(text)));

export const padStartVisible = (text: string, width: number): string =>
  ' '.repeat(Math.max(0, width - visibleLength(text))) + text;

/** Tronque une chaîne à `width` colonnes visibles en préservant les séquences ANSI. */
export function truncateVisible(text: string, width: number): string {
  let visible = 0;
  let out = '';
  let full = false;
  for (let i = 0; i < text.length; ) {
    if (text[i] === '\u001b') {
      const end = text.indexOf('m', i);
      if (end !== -1) {
        out += text.slice(i, end + 1);
        i = end + 1;
        continue;
      }
    }
    const cp = text.codePointAt(i)!;
    const ch = String.fromCodePoint(cp);
    i += ch.length;
    if (full) continue;
    const w = charWidth(cp);
    if (visible + w > width) {
      full = true;
      continue;
    }
    out += ch;
    visible += w;
  }
  return out;
}

/**
 * Nettoie un nom ou un symbole de token choisi par son créateur : caractères
 * de contrôle, inversions de sens d'écriture (U+202E…) et caractères invisibles
 * peuvent décaler ou maquiller l'affichage du terminal.
 */
export function sanitizeLabel(text: string): string {
  return text
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufe00-\ufe0f\ufeff\u{e0000}-\u{e007f}]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}
