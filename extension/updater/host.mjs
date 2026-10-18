/**
 * Assistant de mise à jour de l'extension (hôte « native messaging » de Chrome).
 *
 * Une extension chargée depuis un dossier ne peut pas réécrire ses propres
 * fichiers : Chrome l'interdit. Cet assistant, installé une fois avec
 * `npm run setup:updater`, est lancé par Chrome à la demande de l'extension et
 * fait la seule chose qu'elle ne peut pas faire : `git pull` dans ce dépôt.
 * L'extension se recharge ensuite d'elle-même.
 *
 * Il n'accepte que trois commandes, sans argument libre :
 *   status  version installée et dossier
 *   check   y a-t-il des commits plus récents sur la branche suivie ?
 *   update  récupère la dernière version (avance rapide uniquement)
 *
 * Protocole Chrome : chaque message est un JSON précédé de sa longueur
 * (4 octets, petit-boutiste), sur stdin / stdout.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** Racine du dépôt : ce fichier vit dans <dépôt>/extension/updater/. */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Fichiers générés que l'assistant peut écraser sans risque avant la mise à jour. */
const GENERATED = ['extension/dist', 'package-lock.json'];

export function encodeMessage(message) {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  return Buffer.concat([header, body]);
}

/** Premier message complet d'un tampon, ou null s'il en manque une partie. */
export function decodeMessage(buffer) {
  if (buffer.length < 4) return null;
  const length = buffer.readUInt32LE(0);
  if (buffer.length < 4 + length) return null;
  return JSON.parse(buffer.subarray(4, 4 + length).toString('utf8'));
}

function git(root, args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000 }).trim();
}

function localVersion(root) {
  try {
    return JSON.parse(readFileSync(join(root, 'extension/manifest.json'), 'utf8')).version;
  } catch {
    return undefined;
  }
}

function upstreamVersion(root) {
  try {
    return JSON.parse(git(root, ['show', '@{u}:extension/manifest.json'])).version;
  } catch {
    return undefined;
  }
}

/** Message d'erreur lisible ; les fichiers modifiés localement qui bloquent la mise à jour sont nommés. */
function errorText(error) {
  const raw = String(error?.stderr || error?.message || error).trim();
  if (/would be overwritten|commit your changes or stash them/i.test(raw)) {
    const files = raw
      .split('\n')
      .filter((line) => /^\s+\S/.test(line) && !/please|aborting/i.test(line))
      .map((line) => line.trim());
    return (
      `modifications locales sur ${files.join(', ') || 'des fichiers suivis'} : la mise à jour les écraserait. ` +
      'Annule-les (git checkout -- <fichier>) ou mets-les de côté (git stash), puis réessaie.'
    );
  }
  return raw.split('\n').slice(-3).join(' ');
}

/** Exécute une commande de l'extension. `root` est paramétrable pour les tests. */
export function runAction(action, root = REPO_ROOT) {
  try {
    if (action === 'status') {
      return { ok: true, version: localVersion(root), root };
    }
    if (action === 'check') {
      git(root, ['fetch', '--quiet']);
      const behind = Number(git(root, ['rev-list', '--count', 'HEAD..@{u}']));
      return { ok: true, behind, version: localVersion(root), latest: upstreamVersion(root) ?? localVersion(root) };
    }
    if (action === 'update') {
      const from = localVersion(root);
      git(root, ['fetch', '--quiet']);
      // Les fichiers générés (extension construite, lockfile) modifiés localement
      // bloquent `git pull` : ils sont régénérés par la version distante, on les rétablit.
      for (const path of GENERATED) {
        try {
          git(root, ['checkout', '--', path]);
        } catch {
          // chemin absent : rien à rétablir
        }
      }
      const output = git(root, ['pull', '--ff-only']);
      return { ok: true, from, to: localVersion(root), output: output.split('\n').slice(-3).join(' ') };
    }
    return { ok: false, error: `commande inconnue : ${String(action)}` };
  } catch (error) {
    return { ok: false, error: errorText(error) };
  }
}

async function main() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
    const message = decodeMessage(Buffer.concat(chunks));
    if (message) {
      // Une seule réponse par lancement : Chrome relance l'assistant à chaque demande.
      process.stdout.write(encodeMessage(runAction(message?.action)), () => process.exit(0));
      return;
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
