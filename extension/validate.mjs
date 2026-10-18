/**
 * Valide le dossier de l'extension AVANT de le charger dans Chrome.
 *
 * Chrome refuse une extension avec un message laconique ("Manifest file is
 * missing or unreadable", "Could not load javascript…") sans jamais dire quel
 * fichier manque. Ce script le dit.
 *
 *   node extension/validate.mjs
 */
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const problems = [];
const notes = [];

const manifestPath = join(ROOT, 'manifest.json');
if (!existsSync(manifestPath)) {
  console.error(`✖ manifest.json introuvable dans ${ROOT}`);
  console.error('  Dans Chrome, sélectionne le dossier "extension/", pas la racine du dépôt.');
  process.exit(1);
}

let manifest;
try {
  manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
} catch (error) {
  console.error(`✖ manifest.json illisible : ${error.message}`);
  process.exit(1);
}

/** Chaque chemin cité par le manifest doit exister sur le disque. */
const referenced = [
  manifest.background?.service_worker,
  manifest.options_page,
  manifest.action?.default_popup,
  ...(manifest.content_scripts ?? []).flatMap((cs) => [...(cs.js ?? []), ...(cs.css ?? [])]),
  ...Object.values(manifest.icons ?? {}),
  ...Object.values(manifest.action?.default_icon ?? {}),
].filter(Boolean);

for (const relative of referenced) {
  if (!existsSync(join(ROOT, relative))) {
    problems.push(`fichier manquant : ${relative}`);
  }
}

// Les fichiers construits sont la cause n°1 d'échec après un clone : ils sont
// produits par le build, pas versionnés dans la plupart des configurations.
if (problems.some((p) => p.includes('dist/'))) {
  notes.push('Lance `npm run build:ext` : le dossier dist/ est généré, pas livré tel quel.');
}

// Un html peut référencer un script absent sans que Chrome ne le signale
// clairement : la page d'options s'ouvre vide.
// history.html n'est pas déclarée dans le manifest : elle est ouverte depuis le panneau et les réglages.
for (const page of [manifest.options_page, manifest.action?.default_popup, 'history.html'].filter(Boolean)) {
  const file = join(ROOT, page);
  if (!existsSync(file)) continue;
  const html = readFileSync(file, 'utf8');
  for (const match of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
    const target = match[1];
    if (/^(https?:)?\/\//.test(target) || target.startsWith('data:')) continue;
    if (!existsSync(join(ROOT, target))) problems.push(`${page} référence ${target}, absent`);
  }
}

if (manifest.manifest_version !== 3) problems.push('manifest_version doit valoir 3');

// Une version minimale trop haute fait refuser l'installation sans explication
// utile : on la compare au Chrome réellement installé si on peut le deviner.
if (manifest.minimum_chrome_version) {
  notes.push(
    `minimum_chrome_version = ${manifest.minimum_chrome_version} : si ton Chrome est plus ancien, ` +
      'il refusera l\'extension. Vérifie dans chrome://version',
  );
}

const PATTERN = /^(\*|https?|file|ftp):\/\/(\*|\*\.[^/*]+|[^/*]+)?\/.*$/;
for (const cs of manifest.content_scripts ?? []) {
  for (const pattern of cs.matches ?? []) {
    if (!PATTERN.test(pattern)) problems.push(`motif de correspondance invalide : ${pattern}`);
  }
}

console.log(`Dossier : ${ROOT}`);
console.log(`Extension : ${manifest.name} ${manifest.version}`);
console.log(`Fichiers référencés : ${referenced.length}`);

if (problems.length === 0) {
  console.log('\n✔ Le dossier est chargeable par Chrome.');
  console.log('  chrome://extensions → Mode développeur → Charger l\'extension non empaquetée');
  console.log(`  → sélectionne exactement : ${ROOT}`);
} else {
  console.log('');
  for (const problem of problems) console.error(`✖ ${problem}`);
}
for (const note of notes) console.log(`• ${note}`);
process.exit(problems.length === 0 ? 0 : 1);
