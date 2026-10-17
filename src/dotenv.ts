/**
 * Chargement du fichier .env (CLI uniquement : lit le disque, absent de l'extension).
 */
import { existsSync } from 'node:fs';

/**
 * Charge le fichier .env s'il existe (API native Node >= 20.12). Signale le
 * piège courant sous Windows : un fichier enregistré « .env.txt » par le Bloc-notes.
 */
export function loadDotEnv(path = '.env'): void {
  if (existsSync(path)) {
    try {
      process.loadEnvFile(path);
    } catch (error) {
      process.stderr.write(`Attention : ${path} illisible (${error instanceof Error ? error.message : String(error)})\n`);
    }
    return;
  }
  for (const wrong of [`${path}.txt`, `${path}.example.txt`]) {
    if (existsSync(wrong)) {
      process.stderr.write(
        `Attention : fichier « ${wrong} » trouvé mais pas « ${path} » : il est ignoré. Renommez-le : Rename-Item ${wrong} ${path}\n`,
      );
    }
  }
}
