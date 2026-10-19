/**
 * Cache de scan dans chrome.storage.session : en mémoire du navigateur (rien
 * sur disque), mais il survit à la mise en veille du service worker, qui
 * survient après 30 s d'inactivité. Les transactions déjà lues d'un dev et
 * l'activité des wallets ne sont ainsi pas relues à la prochaine analyse.
 */
import { memoryCache, type ScanCache } from '../../src/cache.js';

const PREFIXES = ['creator-tx:', 'wallet:'];

export function sessionCache(): ScanCache {
  const area = chrome.storage?.session;
  if (!area) return memoryCache();
  let writes = 0;
  const prune = async () => {
    const all = (await area.get(null)) as Record<string, { expires?: number }>;
    const now = Date.now();
    const stale = Object.entries(all)
      .filter(([key, entry]) => PREFIXES.some((p) => key.startsWith(p)) && (entry?.expires ?? 0) <= now)
      .map(([key]) => key);
    if (stale.length) await area.remove(stale);
  };
  return {
    async get<T>(key: string) {
      const entry = (await area.get(key))[key] as { expires: number; value: T } | undefined;
      return entry && entry.expires > Date.now() ? entry.value : undefined;
    },
    async set<T>(key: string, value: T, ttlMs: number) {
      await area.set({ [key]: { expires: Date.now() + ttlMs, value } });
      if (++writes % 200 === 0) void prune().catch(() => undefined);
    },
  };
}
