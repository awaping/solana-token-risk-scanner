/**
 * Comparaison de versions semver, sans aucune dépendance.
 *
 * Fichier séparé de `check.ts` à dessein : `check.ts` lit package.json et le
 * cache disque, donc tire des APIs Node. L'extension de navigateur a besoin de
 * cette comparaison seule — l'isoler ici évite d'en dupliquer une seconde
 * implémentation qui divergerait.
 */

/**
 * Renvoie -1, 0 ou 1. Une pré-publication (`1.2.0-beta.1`) est ANTÉRIEURE à la
 * stable correspondante, conformément à semver : on ne propose jamais une bêta
 * comme mise à jour d'une version stable.
 */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const [core = '', pre = ''] = v.replace(/^v/, '').split('-', 2);
    const parts = core.split('.').map((n) => Number.parseInt(n, 10) || 0);
    return { nums: [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0], pre };
  };
  const left = parse(a);
  const right = parse(b);
  for (let i = 0; i < 3; i++) {
    const diff = (left.nums[i] ?? 0) - (right.nums[i] ?? 0);
    if (diff !== 0) return diff < 0 ? -1 : 1;
  }
  if (left.pre === right.pre) return 0;
  if (left.pre === '') return 1;
  if (right.pre === '') return -1;
  return left.pre < right.pre ? -1 : 1;
}
