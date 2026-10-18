/**
 * Assistant de mise à jour de l'extension : protocole native messaging,
 * identifiant d'extension, et mise à jour réelle sur des dépôts git temporaires
 * (un dépôt « distant », un poste qui publie, le poste de l'utilisateur).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decodeMessage, encodeMessage, runAction } from '../extension/updater/host.mjs';
import { extensionIdFromKey, hostManifest, HOST_NAME } from '../extension/updater/install.mjs';

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.com', '-c', 'init.defaultBranch=main', ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();

function writeManifest(dir: string, version: string): void {
  mkdirSync(join(dir, 'extension', 'dist'), { recursive: true });
  writeFileSync(join(dir, 'extension', 'manifest.json'), JSON.stringify({ name: 'test', version }));
  writeFileSync(join(dir, 'extension', 'dist', 'background.js'), `// ${version}\n`);
}

/** Dépôt distant + poste de publication + poste utilisateur, à la version 1.0.0. */
function repos() {
  const base = mkdtempSync(join(tmpdir(), 'updater-'));
  const origin = join(base, 'origin.git');
  const publisher = join(base, 'publisher');
  const user = join(base, 'user');
  git(base, 'init', '--bare', '-b', 'main', origin);
  git(base, 'clone', '-q', origin, publisher);
  writeManifest(publisher, '1.0.0');
  git(publisher, 'add', '.');
  git(publisher, 'commit', '-q', '-m', 'v1.0.0');
  git(publisher, 'push', '-q', 'origin', 'HEAD:main');
  git(base, 'clone', '-q', origin, user);
  const publish = (version: string) => {
    writeManifest(publisher, version);
    git(publisher, 'commit', '-q', '-am', `v${version}`);
    git(publisher, 'push', '-q', 'origin', 'HEAD:main');
  };
  return { user, publish };
}

test('protocole Chrome : longueur sur 4 octets puis JSON ; message incomplet = null', () => {
  const encoded = encodeMessage({ action: 'check', note: 'é' });
  assert.equal(encoded.readUInt32LE(0), encoded.length - 4);
  assert.deepEqual(decodeMessage(encoded), { action: 'check', note: 'é' });
  assert.equal(decodeMessage(encoded.subarray(0, encoded.length - 1)), null);
  assert.equal(decodeMessage(Buffer.alloc(2)), null);
});

test('identifiant d’extension fixe, dérivé de la clé du manifest, seul autorisé', () => {
  const manifest = JSON.parse(readFileSync('extension/manifest.json', 'utf8')) as { key: string };
  const id = extensionIdFromKey(manifest.key);
  assert.equal(id, 'mfklmdnbbdihmkpbfidgnhjpbafgdppg');
  const declaration = hostManifest('C:\\scanner\\extension\\updater\\host.cmd', id);
  assert.equal(declaration.name, HOST_NAME);
  assert.equal(declaration.type, 'stdio');
  assert.deepEqual(declaration.allowed_origins, [`chrome-extension://${id}/`]);
});

test('vérification puis mise à jour : le poste utilisateur passe à la dernière version', () => {
  const { user, publish } = repos();
  assert.deepEqual(runAction('status', user), { ok: true, version: '1.0.0', root: user });
  assert.deepEqual(runAction('check', user), { ok: true, behind: 0, version: '1.0.0', latest: '1.0.0' });

  publish('1.1.0');
  assert.deepEqual(runAction('check', user), { ok: true, behind: 1, version: '1.0.0', latest: '1.1.0' });

  // Extension reconstruite localement : ne doit pas bloquer la mise à jour.
  writeFileSync(join(user, 'extension', 'dist', 'background.js'), '// build local\n');
  const update = runAction('update', user);
  assert.equal(update.ok, true, String(update.error));
  assert.equal(update.from, '1.0.0');
  assert.equal(update.to, '1.1.0');
  assert.equal(readFileSync(join(user, 'extension', 'dist', 'background.js'), 'utf8'), '// 1.1.0\n');
});

test('modification locale d’un fichier suivi : échec explicite, rien n’est écrasé', () => {
  const { user, publish } = repos();
  publish('1.1.0');
  writeFileSync(join(user, 'extension', 'manifest.json'), '{"name":"test","version":"9.9.9"}');
  const update = runAction('update', user);
  assert.equal(update.ok, false);
  assert.match(String(update.error), /overwritten|écrasé|local changes|modifications/i);
  assert.equal(JSON.parse(readFileSync(join(user, 'extension', 'manifest.json'), 'utf8')).version, '9.9.9');
  assert.equal(runAction('inconnue', user).ok, false);
});

test('bout en bout : Chrome lance l’assistant, envoie une commande, lit la réponse', async () => {
  const child = spawn(process.execPath, ['extension/updater/host.mjs', 'chrome-extension://test/'], { stdio: ['pipe', 'pipe', 'inherit'] });
  const chunks: Buffer[] = [];
  child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
  const exited = new Promise<number | null>((resolve) => child.on('exit', resolve));
  child.stdin.write(encodeMessage({ action: 'status' }));
  assert.equal(await exited, 0, 'l’assistant se termine après sa réponse');
  const reply = decodeMessage(Buffer.concat(chunks)) as { ok: boolean; version: string };
  assert.equal(reply.ok, true);
  assert.equal(reply.version, JSON.parse(readFileSync('extension/manifest.json', 'utf8')).version);
});
