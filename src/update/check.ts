/**
 * Détection d'une nouvelle version publiée sur GitHub.
 *
 * Deux principes :
 *
 * 1. NE JAMAIS RALENTIR NI CASSER LE SCAN. La vérification part en arrière-plan,
 *    a un timeout court, n'échoue jamais (elle renvoie `null`) et son résultat
 *    est mis en cache sur disque. Un GitHub injoignable ou un quota d'API épuisé
 *    doit être totalement invisible pour l'utilisateur.
 *
 * 2. VÉRIFIER AUTOMATIQUEMENT, INSTALLER MANUELLEMENT. `checkForUpdate()` ne
 *    fait que lire et comparer des numéros de version. Installer, c'est exécuter
 *    du code distant sur la machine : cela reste une commande explicite
 *    (`sol-risk update`). Un scanner de sécurité qui s'auto-exécuterait du code
 *    tiré du réseau sans demande serait une contradiction.
 */
import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { compareVersions } from './version.js';

const require = createRequire(import.meta.url);

/** Racine du paquet (le dossier qui contient package.json). */
const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

function readPackageField<T>(field: string, fallback: T): T {
  try {
    return (require(join(PACKAGE_ROOT, 'package.json')) as Record<string, T>)[field] ?? fallback;
  } catch {
    return fallback;
  }
}

/** Version installée, lue depuis package.json (source unique de vérité). */
export const CURRENT_VERSION = readPackageField<string>('version', '0.0.0');

/** `owner/repo` déduit du champ `repository` de package.json. */
export function repoSlug(): string | null {
  const repository = readPackageField<unknown>('repository', null);
  const url = typeof repository === 'string' ? repository : (repository as { url?: string } | null)?.url;
  if (typeof url !== 'string') return null;
  const match = /github\.com[/:]([^/]+)\/([^/.]+)/.exec(url);
  return match ? `${match[1]}/${match[2]}` : null;
}

export interface UpdateInfo {
  current: string;
  latest: string;
  url: string;
  publishedAt?: string;
}

interface CacheEntry {
  checkedAt: number;
  latest: string;
  url: string;
  publishedAt?: string;
}

const CACHE_PATH = join(PACKAGE_ROOT, '.cache', 'update.json');
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 2_500;

// ---------------------------------------------------------------------------
// Comparaison de versions
// ---------------------------------------------------------------------------

/**
 * Compare deux versions semver (major.minor.patch).
 *
 * Une version avec pré-publication (`1.2.0-beta.1`) est considérée ANTÉRIEURE à
 * la version stable correspondante, conformément à semver : on ne propose
 * jamais une bêta comme mise à jour d'une stable.
 */
export { compareVersions } from './version.js';

// ---------------------------------------------------------------------------
// Cache disque
// ---------------------------------------------------------------------------

async function readCache(): Promise<CacheEntry | null> {
  try {
    const entry = JSON.parse(await readFile(CACHE_PATH, 'utf8')) as CacheEntry;
    return Date.now() - entry.checkedAt < CACHE_TTL_MS ? entry : null;
  } catch {
    return null;
  }
}

async function writeCache(entry: CacheEntry): Promise<void> {
  try {
    await mkdir(dirname(CACHE_PATH), { recursive: true });
    await writeFile(CACHE_PATH, JSON.stringify(entry), 'utf8');
  } catch {
    // Disque en lecture seule ou droits insuffisants : on revérifiera au
    // prochain lancement, ce n'est pas une erreur.
  }
}

// ---------------------------------------------------------------------------
// Interrogation de GitHub
// ---------------------------------------------------------------------------

async function githubJson(url: string, signal: AbortSignal): Promise<unknown> {
  const headers: Record<string, string> = {
    accept: 'application/vnd.github+json',
    // GitHub refuse les requêtes sans user-agent.
    'user-agent': `solana-token-risk-scanner/${CURRENT_VERSION}`,
  };
  // Un jeton n'est pas nécessaire : il ne sert qu'à relever le quota anonyme
  // (60 requêtes/h par IP), largement suffisant avec le cache de 6 h.
  const token = process.env.GITHUB_TOKEN?.trim();
  if (token) headers.authorization = `Bearer ${token}`;

  const res = await fetch(url, { headers, signal });
  if (!res.ok) throw new Error(`GitHub HTTP ${res.status}`);
  return res.json();
}

/** Dernière version publiée : release si elle existe, sinon dernier tag. */
async function fetchLatest(slug: string, signal: AbortSignal): Promise<CacheEntry | null> {
  try {
    const release = (await githubJson(`https://api.github.com/repos/${slug}/releases/latest`, signal)) as {
      tag_name?: string;
      html_url?: string;
      published_at?: string;
      draft?: boolean;
      prerelease?: boolean;
    };
    if (release.tag_name && !release.draft && !release.prerelease) {
      return {
        checkedAt: Date.now(),
        latest: release.tag_name.replace(/^v/, ''),
        url: release.html_url ?? `https://github.com/${slug}/releases`,
        ...(release.published_at ? { publishedAt: release.published_at } : {}),
      };
    }
  } catch {
    // Pas de release publiée (404) ou API indisponible : on tente les tags.
  }

  try {
    const tags = (await githubJson(`https://api.github.com/repos/${slug}/tags?per_page=20`, signal)) as Array<{
      name?: string;
    }>;
    const names = tags.map((t) => t.name).filter((n): n is string => typeof n === 'string');
    if (names.length === 0) return null;
    // L'API renvoie les tags par ordre de création, pas par version.
    const latest = names.reduce((best, name) => (compareVersions(name, best) > 0 ? name : best));
    return {
      checkedAt: Date.now(),
      latest: latest.replace(/^v/, ''),
      url: `https://github.com/${slug}/releases/tag/${latest}`,
    };
  } catch {
    return null;
  }
}

export interface CheckOptions {
  /** Ignore le cache disque. */
  force?: boolean;
  /** Dépôt `owner/repo` (sinon déduit de package.json). */
  slug?: string;
}

/**
 * Renvoie les informations de mise à jour, ou `null` si la version installée
 * est à jour — ou si quoi que ce soit a échoué. Ne lève jamais.
 *
 * Désactivable par `NO_UPDATE_CHECK=1` (utile en CI ou hors ligne).
 */
export async function checkForUpdate(options: CheckOptions = {}): Promise<UpdateInfo | null> {
  if (process.env.NO_UPDATE_CHECK?.trim() && process.env.NO_UPDATE_CHECK !== '0') return null;

  const slug = options.slug ?? repoSlug();
  if (!slug) return null;

  let entry = options.force ? null : await readCache();
  if (!entry) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      entry = await fetchLatest(slug, controller.signal);
      if (entry) await writeCache(entry);
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
  if (!entry) return null;

  if (compareVersions(entry.latest, CURRENT_VERSION) <= 0) return null;
  return {
    current: CURRENT_VERSION,
    latest: entry.latest,
    url: entry.url,
    ...(entry.publishedAt ? { publishedAt: entry.publishedAt } : {}),
  };
}

/** Bandeau d'information (une ligne, sans couleur imposée). */
export function updateNotice(info: UpdateInfo): string {
  return `Mise à jour disponible : ${info.current} → ${info.latest}  ·  ${info.url}  ·  lancer : npm run update`;
}

/**
 * Affiche le bandeau si une mise à jour existe.
 *
 * Écrit sur stderr pour ne jamais polluer une sortie `--json` consommée par un
 * script. N'attend jamais plus que la vérification déjà en cours.
 */
export async function printUpdateNotice(
  pending: Promise<UpdateInfo | null>,
  write: (line: string) => void = (line) => process.stderr.write(line),
): Promise<void> {
  try {
    const info = await pending;
    if (info) write(`\n${updateNotice(info)}\n`);
  } catch {
    // Jamais bloquant.
  }
}
