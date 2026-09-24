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

/** Longueur visible d'une chaîne (sans les séquences ANSI). */
export const visibleLength = (text: string): number => text.replace(/\u001b\[[0-9;]*m/g, '').length;

export const padEndVisible = (text: string, width: number): string =>
  text + ' '.repeat(Math.max(0, width - visibleLength(text)));

export const padStartVisible = (text: string, width: number): string =>
  ' '.repeat(Math.max(0, width - visibleLength(text))) + text;
