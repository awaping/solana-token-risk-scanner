/**
 * Console Windows classique (conhost) : en « mode d'édition rapide », un simple
 * clic dans la fenêtre démarre une sélection et SUSPEND toute écriture du
 * programme — le tableau de bord se fige jusqu'à ce qu'on appuie sur Échap.
 *
 * Pendant le mode stream, l'édition rapide est désactivée sur la console
 * (via un PowerShell enfant, qui partage la console du programme), puis
 * rétablie à l'arrêt. Sans effet hors de Windows ou si la sortie n'est pas un
 * terminal ; toute erreur est ignorée (au pire, le comportement par défaut reste).
 * Variable SOL_RISK_KEEP_QUICKEDIT=1 pour ne pas y toucher.
 */
import { spawn, spawnSync } from 'node:child_process';

const ENABLE_QUICK_EDIT_MODE = 0x40;
const ENABLE_EXTENDED_FLAGS = 0x80;

const psScript = (body: string) =>
  [
    "$s='[DllImport(\"kernel32.dll\")]public static extern IntPtr GetStdHandle(int n);" +
      '[DllImport("kernel32.dll")]public static extern bool GetConsoleMode(IntPtr h,out uint m);' +
      "[DllImport(\"kernel32.dll\")]public static extern bool SetConsoleMode(IntPtr h,uint m);'",
    '$k=Add-Type -MemberDefinition $s -Name ConsoleMode -Namespace SolRiskScanner -PassThru',
    '$h=$k::GetStdHandle(-10)',
    body,
  ].join(';');

/** Arguments PowerShell : script encodé en base64 UTF-16LE (aucun problème de guillemets). */
const psArgs = (script: string) => ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')];

let previousMode: number | undefined;
let pending: Promise<void> | undefined;

/** Désactive l'édition rapide de la console (asynchrone, sans bloquer le flux). */
export function disableQuickEdit(): void {
  if (process.platform !== 'win32' || !process.stdin.isTTY || !process.stdout.isTTY) return;
  if (process.env.SOL_RISK_KEEP_QUICKEDIT === '1' || pending) return;
  const body =
    '$m=[uint32]0;if($k::GetConsoleMode($h,[ref]$m)){' +
    `[void]$k::SetConsoleMode($h,[uint32](($m -band (-bnot ${ENABLE_QUICK_EDIT_MODE})) -bor ${ENABLE_EXTENDED_FLAGS}));$m}`;
  pending = new Promise<void>((resolve) => {
    try {
      // stdin hérité : le PowerShell enfant agit sur la console du programme.
      const child = spawn('powershell.exe', psArgs(psScript(body)), {
        // Sans windowsHide : l'enfant reste attaché à la console du programme.
        stdio: ['inherit', 'pipe', 'ignore'],
      });
      let out = '';
      child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString()));
      child.on('error', () => resolve());
      child.on('exit', () => {
        const mode = Number.parseInt(out.trim(), 10);
        if (Number.isFinite(mode) && mode & ENABLE_QUICK_EDIT_MODE) previousMode = mode;
        resolve();
      });
    } catch {
      resolve();
    }
  });
}

/** Rétablit l'édition rapide si elle était active au démarrage (appel synchrone, à l'arrêt). */
export function restoreQuickEdit(): void {
  if (previousMode === undefined) return;
  const mode = previousMode;
  previousMode = undefined;
  try {
    spawnSync('powershell.exe', psArgs(psScript(`[void]$k::SetConsoleMode($h,[uint32]${mode})`)), {
      stdio: ['inherit', 'ignore', 'ignore'],
      timeout: 5_000,
    });
  } catch {
    // console déjà fermée : rien à rétablir
  }
}
