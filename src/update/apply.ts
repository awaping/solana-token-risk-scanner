/**
 * Application d'une mise à jour (`sol-risk update`).
 *
 * Déclenchée UNIQUEMENT par une commande explicite : récupérer et exécuter du
 * code distant n'est pas une opération qu'un outil doit décider seul.
 *
 * Trois garde-fous, dans cet ordre :
 *   1. le dossier doit être un dépôt git (sinon l'installation vient de npm) ;
 *   2. l'arbre de travail doit être propre — un `git pull` sur des
 *      modifications locales non commitées les écraserait ou ferait échouer la
 *      fusion à mi-chemin ;
 *   3. la fusion est `--ff-only` : jamais de merge automatique, jamais de
 *      conflit à résoudre dans le dos de l'utilisateur.
 */
import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Exécute une commande sans passer par un shell : les arguments sont transmis
 * tels quels, il n'y a donc rien à échapper et rien à injecter.
 */
export function run(command: string, args: string[], cwd = PACKAGE_ROOT): Promise<RunResult> {
  return new Promise((resolve) => {
    // `shell: true` sur Windows uniquement pour résoudre npm.cmd / git.exe via
    // le PATH ; les arguments restent passés en tableau.
    const child = spawn(command, args, { cwd, shell: process.platform === 'win32' });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr?.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    child.on('error', (error) => resolve({ code: null, stdout, stderr: String(error) }));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

const exists = async (path: string): Promise<boolean> => {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
};

export interface UpdateOutcome {
  ok: boolean;
  message: string;
  steps: string[];
}

/**
 * Met à jour l'installation locale : `git pull --ff-only`, puis dépendances,
 * puis build si le projet est compilé.
 */
export async function applyUpdate(log: (line: string) => void = console.log): Promise<UpdateOutcome> {
  const steps: string[] = [];
  const fail = (message: string): UpdateOutcome => ({ ok: false, message, steps });

  if (!(await exists(join(PACKAGE_ROOT, '.git')))) {
    return fail(
      "ce dossier n'est pas un dépôt git — mise à jour via npm : npm update -g solana-token-risk-scanner",
    );
  }

  const status = await run('git', ['status', '--porcelain']);
  if (status.code !== 0) return fail(`git status a échoué : ${status.stderr.trim() || status.stdout.trim()}`);
  if (status.stdout.trim() !== '') {
    const files = status.stdout.trim().split('\n').slice(0, 10).join('\n  ');
    return fail(
      `modifications locales non commitées — mise à jour annulée pour ne pas les écraser :\n  ${files}\n` +
        '  Commitez ou remisez (git stash) avant de relancer.',
    );
  }

  log('→ git pull --ff-only');
  const pull = await run('git', ['pull', '--ff-only']);
  steps.push('git pull');
  if (pull.code !== 0) {
    return fail(
      `git pull a échoué : ${pull.stderr.trim() || pull.stdout.trim()}\n` +
        "  (une divergence avec la branche distante demande une intervention manuelle)",
    );
  }
  log(pull.stdout.trim());
  if (/Already up to date|Déjà à jour/i.test(pull.stdout)) {
    return { ok: true, message: 'déjà à jour', steps };
  }

  log('→ npm install');
  const install = await run('npm', ['install', '--no-audit', '--no-fund']);
  steps.push('npm install');
  if (install.code !== 0) return fail(`npm install a échoué : ${install.stderr.trim().slice(-500)}`);

  // Build seulement si le projet était déjà compilé : l'utilisateur qui lance
  // via tsx n'a pas besoin de dist/.
  if (await exists(join(PACKAGE_ROOT, 'dist'))) {
    log('→ npm run build');
    const build = await run('npm', ['run', 'build']);
    steps.push('npm run build');
    if (build.code !== 0) return fail(`build échoué : ${build.stderr.trim().slice(-500)}`);
  }

  return { ok: true, message: 'mise à jour terminée', steps };
}

/**
 * Marqueur transmis au processus relancé : sans lui, le nouveau processus
 * revérifierait et pourrait se relancer à son tour. Une boucle de relance est
 * le genre de panne qui ne se remarque qu'après avoir tourné toute la nuit.
 */
const RESTARTED_ENV = 'SOL_RISK_UPDATED';

/**
 * Mise à jour entièrement automatique, à activer par `AUTO_UPDATE=1`.
 *
 * Installe la nouvelle version PUIS relance la commande d'origine à l'identique :
 * du point de vue de l'utilisateur, l'outil démarre simplement à jour.
 *
 * Renvoie le code de sortie du processus relancé, ou `null` s'il n'y avait rien
 * à faire (auquel cas l'appelant continue normalement).
 *
 * Volontairement opt-in : récupérer et exécuter du code depuis le réseau à
 * chaque démarrage est un comportement qui doit être choisi, pas subi.
 */
export async function autoUpdateAndRestart(
  log: (line: string) => void = console.error,
): Promise<number | null> {
  if (process.env[RESTARTED_ENV]) return null; // déjà relancé : on ne reboucle pas
  if (process.env.AUTO_UPDATE?.trim() !== '1') return null;

  const { checkForUpdate } = await import('./check.js');
  const info = await checkForUpdate();
  if (!info) return null;

  log(`Mise à jour ${info.current} → ${info.latest} : installation…`);
  const outcome = await applyUpdate(log);
  if (!outcome.ok) {
    log(`Mise à jour impossible (${outcome.message}) — poursuite avec la version installée.`);
    return null;
  }
  if (outcome.message === 'déjà à jour') return null;

  log(`Mise à jour installée, redémarrage sur la version ${info.latest}.`);
  const { spawnSync } = await import('node:child_process');
  // Même interpréteur, mêmes arguments, même terminal : le relancement est
  // transparent pour l'utilisateur comme pour les scripts qui pipent la sortie.
  const child = spawnSync(process.execPath, process.argv.slice(1), {
    stdio: 'inherit',
    env: { ...process.env, [RESTARTED_ENV]: '1' },
  });
  return child.status ?? 1;
}
