/**
 * Cache des données qui changent peu d'une analyse à l'autre : transactions déjà
 * lues d'un créateur, activité des wallets. Rescanner un token (bouton ↻,
 * suivi automatique) ou ouvrir un autre token du même dev ne relit alors que
 * le nouveau. L'implémentation est injectée : mémoire pour le CLI,
 * chrome.storage.session pour l'extension (survit à la mise en veille du
 * service worker).
 */
export interface ScanCache {
  get<T>(key: string): Promise<T | undefined>;
  set<T>(key: string, value: T, ttlMs: number): Promise<void>;
}

/** Cache en mémoire, borné (les entrées les plus anciennes partent en premier). */
export function memoryCache(maxEntries = 5_000): ScanCache {
  const entries = new Map<string, { expires: number; value: unknown }>();
  return {
    async get<T>(key: string) {
      const entry = entries.get(key);
      if (!entry) return undefined;
      if (entry.expires <= Date.now()) {
        entries.delete(key);
        return undefined;
      }
      return entry.value as T;
    },
    async set<T>(key: string, value: T, ttlMs: number) {
      entries.delete(key);
      entries.set(key, { expires: Date.now() + ttlMs, value });
      while (entries.size > maxEntries) entries.delete(entries.keys().next().value!);
    },
  };
}
