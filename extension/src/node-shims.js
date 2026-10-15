/**
 * Globaux Node attendus par le code partagé, fournis au navigateur.
 *
 * esbuild injecte ce module dans tout fichier qui référence `Buffer` ou
 * `process`. Sans lui, le service worker meurt dès son chargement sur
 * `process.stdout.isTTY` (détection de couleurs ANSI dans utils/format.ts) —
 * une ligne inoffensive côté CLI, fatale côté navigateur.
 *
 * `process` est volontairement minimal et inerte : pas de TTY, pas de
 * variables d'environnement. Le code de couleurs en déduit « pas de couleurs »,
 * ce qui est exactement ce qu'on veut dans une extension.
 */
import { Buffer } from 'buffer';

const process = {
  env: {},
  argv: [],
  platform: 'browser',
  version: '',
  stdout: { isTTY: false },
  stderr: { isTTY: false },
};

export { Buffer, process };
