/**
 * Installe (une fois) l'assistant de mise à jour de l'extension.
 *
 *   npm run setup:updater              installe pour Chrome, Edge, Brave, Chromium
 *   npm run setup:updater -- --remove  désinstalle
 *
 * Écrit le lanceur de l'assistant et sa déclaration (manifest « native
 * messaging »), puis l'enregistre auprès des navigateurs : base de registre
 * sous Windows (HKCU, sans droits administrateur), dossiers de profil sous
 * macOS et Linux. Seule cette extension (identifiant fixe, dérivé de la clé de
 * son manifest) est autorisée à lancer l'assistant.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const HOST_NAME = 'com.solana_risk_scanner.updater';
const HERE = dirname(fileURLToPath(import.meta.url));

/** Identifiant Chrome d'une extension à partir de la clé publique de son manifest. */
export function extensionIdFromKey(key) {
  const digest = createHash('sha256').update(Buffer.from(key, 'base64')).digest();
  return [...digest.subarray(0, 16).toString('hex')].map((c) => String.fromCharCode(97 + Number.parseInt(c, 16))).join('');
}

/** Déclaration de l'assistant lue par le navigateur. */
export function hostManifest(launcher, extensionId) {
  return {
    name: HOST_NAME,
    description: "Assistant de mise à jour de l'extension Solana Token Risk Scanner (git pull)",
    path: launcher,
    type: 'stdio',
    allowed_origins: [`chrome-extension://${extensionId}/`],
  };
}

/** Clés de registre (Windows) des navigateurs Chromium. */
const WINDOWS_KEYS = [
  'HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts',
  'HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts',
  'HKCU\\Software\\BraveSoftware\\Brave-Browser\\NativeMessagingHosts',
  'HKCU\\Software\\Chromium\\NativeMessagingHosts',
].map((base) => `${base}\\${HOST_NAME}`);

/** Dossiers de déclaration (macOS / Linux) des navigateurs Chromium. */
function unixManifestDirs() {
  const home = homedir();
  if (platform() === 'darwin') {
    const support = join(home, 'Library', 'Application Support');
    return ['Google/Chrome', 'Microsoft Edge', 'BraveSoftware/Brave-Browser', 'Chromium'].map((d) => join(support, d, 'NativeMessagingHosts'));
  }
  const config = join(home, '.config');
  return ['google-chrome', 'microsoft-edge', 'BraveSoftware/Brave-Browser', 'chromium'].map((d) => join(config, d, 'NativeMessagingHosts'));
}

function install() {
  const manifest = JSON.parse(readFileSync(join(HERE, '..', 'manifest.json'), 'utf8'));
  if (!manifest.key) throw new Error('extension/manifest.json ne contient pas de clé « key » : identifiant d’extension inconnu');
  const extensionId = extensionIdFromKey(manifest.key);
  const host = join(HERE, 'host.mjs');
  const windows = platform() === 'win32';

  // Lanceur : chemin absolu de Node, pour ne pas dépendre du PATH vu par le navigateur.
  const launcher = join(HERE, windows ? 'host.cmd' : 'host.sh');
  writeFileSync(
    launcher,
    windows ? `@echo off\r\n"${process.execPath}" "${host}" %*\r\n` : `#!/bin/sh\nexec "${process.execPath}" "${host}" "$@"\n`,
  );
  if (!windows) chmodSync(launcher, 0o755);
  const declaration = JSON.stringify(hostManifest(launcher, extensionId), null, 2);

  if (windows) {
    const file = join(HERE, 'host-manifest.json');
    writeFileSync(file, declaration);
    for (const key of WINDOWS_KEYS) {
      execFileSync('reg', ['add', key, '/ve', '/t', 'REG_SZ', '/d', file, '/f'], { stdio: 'ignore' });
    }
  } else {
    for (const dir of unixManifestDirs()) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `${HOST_NAME}.json`), declaration);
    }
  }

  console.log('✔ Assistant de mise à jour installé.');
  console.log(`  Extension autorisée : ${extensionId}`);
  console.log(`  Dossier mis à jour  : ${resolve(HERE, '..', '..')}`);
  console.log('  Recharge l’extension dans chrome://extensions, puis utilise le bouton « Mettre à jour » de ses réglages.');
}

function remove() {
  if (platform() === 'win32') {
    for (const key of WINDOWS_KEYS) {
      try {
        execFileSync('reg', ['delete', key, '/f'], { stdio: 'ignore' });
      } catch {
        // clé absente
      }
    }
  } else {
    for (const dir of unixManifestDirs()) rmSync(join(dir, `${HOST_NAME}.json`), { force: true });
  }
  for (const file of ['host.cmd', 'host.sh', 'host-manifest.json']) {
    if (existsSync(join(HERE, file))) rmSync(join(HERE, file));
  }
  console.log('✔ Assistant de mise à jour désinstallé.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.includes('--remove')) remove();
    else install();
  } catch (error) {
    console.error(`✖ ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
