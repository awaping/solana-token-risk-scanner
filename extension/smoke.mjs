/**
 * Test de fumée du bundle : le charger dans un contexte SANS `process` ni
 * `Buffer`, c'est-à-dire dans les conditions d'un service worker.
 *
 * Raison d'être : une seule ligne de code partagé qui lit `process.stdout`
 * suffit à tuer l'extension au chargement, et ça ne se voit ni au typecheck ni
 * au build — seulement dans Chrome, à l'exécution. Node, lui, a toujours
 * `process` : exécuter le bundle tel quel ne prouverait rien.
 *
 *   node extension/smoke.mjs
 */
import { build } from 'esbuild';
import { createContext, runInContext } from 'node:vm';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));

/** Faux `chrome` : enregistre les appels pour vérifier que l'init s'est faite. */
function fakeChrome(calls) {
  const listener = () => ({ addListener: (fn) => calls.push(fn && 'listener') });
  return {
    runtime: {
      onMessage: { addListener: () => calls.push('onMessage') },
      onStartup: listener(),
      onInstalled: listener(),
      id: 'smoke-test',
      getManifest: () => ({ version: '1.4.1' }),
      getURL: (path) => `chrome-extension://smoke-test/${path}`,
      sendMessage: async () => ({ ok: true }),
      sendNativeMessage: async () => {
        throw new Error('Specified native messaging host not found.');
      },
      reload: () => {},
    },
    storage: {
      sync: { get: async (d) => d, set: async () => {} },
      local: { get: async () => ({}), set: async () => {}, remove: async () => {} },
      onChanged: { addListener: () => calls.push('storage.onChanged') },
    },
    alarms: { create: () => {}, onAlarm: { addListener: () => calls.push('alarms') } },
    tabs: { create: async () => ({}) },
    permissions: { contains: async () => false, request: async () => false, onAdded: { addListener: () => {} } },
    action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} },
  };
}

async function smoke(name, entry, globals) {
  // IIFE : exécutable dans un contexte vm, contrairement à de l'ESM.
  const bundled = await build({
    entryPoints: [entry],
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'chrome120',
    write: false,
    logLevel: 'silent',
    define: { 'process.env.NODE_ENV': '"production"', global: 'globalThis' },
    inject: [join(ROOT, 'src/node-shims.js')],
  });
  const code = bundled.outputFiles[0].text;

  // Contexte volontairement nu : ni process, ni Buffer, ni require.
  const sandbox = {
    console,
    fetch: async () => {
      throw new Error('réseau non sollicité par le test de fumée');
    },
    TextEncoder,
    TextDecoder,
    URL,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    queueMicrotask,
    crypto: globalThis.crypto,
    atob: globalThis.atob,
    btoa: globalThis.btoa,
    ...globals,
  };
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;

  try {
    runInContext(code, createContext(sandbox), { timeout: 10_000 });
    return { name, ok: true };
  } catch (error) {
    return { name, ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

process.on('unhandledRejection', (error) => {
  console.error(`  ECHEC rejet non gere : ${error instanceof Error ? error.message : error}`);
  process.exit(1);
});

const calls = [];
const results = await Promise.all([
  smoke('background (service worker)', join(ROOT, 'src/background.ts'), { chrome: fakeChrome(calls) }),
  smoke('content (page)', join(ROOT, 'src/content.ts'), {
    chrome: fakeChrome(calls),
    location: { href: 'https://pump.fun/coin/BoDxYCeLDSUyCfrMabcdefghijklmnopqrstupump' },
    document: { documentElement: { append() {} }, getElementById: () => null, createElement: () => ({ append() {}, addEventListener() {}, classList: {}, style: {} }) },
    history: { pushState() {}, replaceState() {} },
    addEventListener() {},
  }),
  smoke('historique (page)', join(ROOT, 'src/history-page.ts'), {
    chrome: fakeChrome(calls),
    location: { hash: '' },
    document: {
      title: '',
      activeElement: null,
      getElementById: () => ({ replaceChildren() {}, append() {} }),
      createElement: () => ({ append() {}, addEventListener() {}, setAttribute() {}, replaceChildren() {}, classList: {}, style: {} }),
      createElementNS: () => ({ append() {}, setAttribute() {}, addEventListener() {} }),
    },
    HTMLInputElement: class {},
    addEventListener() {},
    requestAnimationFrame: () => 0,
    ResizeObserver: class {
      observe() {}
    },
  }),
]);

// Le content script arme des timers (surveillance d'URL d'une SPA) qui
// maintiendraient ce process en vie : on laisse la pile asynchrone se vider,
// puis on sort explicitement.
await new Promise((resolve) => setTimeout(resolve, 1_200));

let failed = false;
for (const r of results) {
  if (r.ok) {
    console.log(`  OK   ${r.name} — se charge sans process ni Buffer`);
  } else {
    failed = true;
    console.error(`  ECHEC ${r.name} : ${r.error}`);
  }
}
if (!calls.includes('onMessage')) {
  failed = true;
  console.error("  ECHEC background : le gestionnaire de messages n'a pas été enregistré");
} else {
  console.log('  OK   background — gestionnaire de messages enregistré');
}
process.exit(failed ? 1 : 0);
