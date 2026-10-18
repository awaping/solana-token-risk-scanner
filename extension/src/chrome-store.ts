/**
 * Adaptateur chrome.storage.local pour l'historique (service worker et pages de
 * l'extension). Séparé de history-store.ts, qui reste sans API chrome pour les tests.
 */
import type { KeyValueStore } from './history-store.js';

export function chromeLocalStore(): KeyValueStore {
  return {
    get: (keys) => chrome.storage.local.get(keys),
    set: (items) => chrome.storage.local.set(items),
    remove: (keys) => chrome.storage.local.remove(keys),
  };
}
