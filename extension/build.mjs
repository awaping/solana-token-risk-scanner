/**
 * Build de l'extension : esbuild, trois entrées indépendantes.
 *
 *   node extension/build.mjs            compile une fois
 *   node extension/build.mjs --watch    recompile à chaque modification
 *
 * `background` embarque tout le scanner (web3.js inclus) et pèse ~900 Ko ;
 * `content` et `options` restent minuscules parce qu'ils ne font que de la
 * détection et de l'affichage — tout le réseau et le scoring vivent dans le
 * service worker.
 */
import { build, context } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = dirname(fileURLToPath(import.meta.url));
const watch = process.argv.includes('--watch');

/** @type {import('esbuild').BuildOptions} */
const common = {
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'chrome120',
  logLevel: 'info',
  legalComments: 'none',
  // Les paquets Solana testent `process.env.NODE_ENV` et `global`, absents du
  // navigateur : on les résout à la compilation plutôt que d'embarquer un shim.
  define: { 'process.env.NODE_ENV': '"production"', global: 'globalThis' },
  minify: !watch,
  sourcemap: watch ? 'inline' : false,
};

const entries = [
  { in: join(ROOT, 'src/background.ts'), out: join(ROOT, 'dist/background.js'), shims: true },
  { in: join(ROOT, 'src/content.ts'), out: join(ROOT, 'dist/content.js'), shims: false },
  { in: join(ROOT, 'src/options.ts'), out: join(ROOT, 'dist/options.js'), shims: false },
];

const configs = entries.map((entry) => ({
  ...common,
  entryPoints: [entry.in],
  outfile: entry.out,
  // Seul le service worker manipule des Buffer (via web3.js) : inutile
  // d'alourdir le content script avec le polyfill.
  ...(entry.shims ? { inject: [join(ROOT, 'src/node-shims.js')] } : {}),
}));

if (watch) {
  const contexts = await Promise.all(configs.map((config) => context(config)));
  await Promise.all(contexts.map((ctx) => ctx.watch()));
  console.log('extension : surveillance active (Ctrl+C pour arrêter)');
} else {
  await Promise.all(configs.map((config) => build(config)));
  console.log('extension : build terminé → extension/dist/');
}
