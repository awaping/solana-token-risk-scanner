# Extension navigateur

Affiche le score de risque d'un token Solana par-dessus les terminaux memecoin.
**Échelle : 0 = sain · 100 = danger maximum.**

## Installation

```bash
npm install
npm run build:ext
```

Puis dans Chrome : `chrome://extensions` → activer **Mode développeur** →
**Charger l'extension non empaquetée** → choisir le dossier `extension/`.

Ouvrir ensuite les options (icône de l'extension) et coller un **endpoint RPC
privé** (Helius, Triton, QuickNode). L'endpoint public est limité en débit et
rendra la plupart des analyses incomplètes. La clé reste dans ce navigateur,
elle n'est envoyée nulle part ailleurs.

### Si Chrome refuse le dossier

```bash
npm run validate:ext
```

Le script dit précisément quel fichier manque — Chrome, lui, se contente de
« Manifest file is missing or unreadable » sans préciser lequel. Les trois
causes habituelles :

| Message de Chrome | Cause |
|---|---|
| Manifest file is missing or unreadable | mauvais dossier sélectionné : il faut `extension/`, pas la racine du dépôt |
| Could not load javascript 'dist/…' | `dist/` absent — `npm run build:ext` |
| This extension requires a newer version | Chrome < 120, voir `chrome://version` |

### Reconstruire après modification

```bash
npm run build:ext
```

puis recharger l'extension dans `chrome://extensions`.

## Sites couverts

pump.fun · Padre · Axiom · GMGN · Birdeye · Solscan · BullX · DexScreener ·
Photon.

La détection ne dépend pas d'un scraper par site : elle cherche une adresse
Solana valide dans l'URL puis dans la page. Un site absent de la liste
fonctionne dès qu'on l'ajoute à `content_scripts.matches` dans `manifest.json`.

DexScreener et Photon exposent l'adresse de la **pool**, et Axiom souvent celle
de la **bonding curve**, pas celle du token. Le moteur vérifie le compte on-chain
et remonte jusqu'au mint (bonding curve Pump.fun, pools PumpSwap et Raydium) ; le
panneau indique alors le mint réellement analysé. Pour une pool d'un autre DEX,
il explique qu'il faut ouvrir la page du token.

## Mises à jour

| Installation | Mise à jour |
|---|---|
| Chrome Web Store | **automatique**, gérée par Chrome |
| Non empaquetée (ci-dessus) | **jamais automatique** — c'est une limite de Chrome, pas un choix |

Pour l'installation non empaquetée, l'extension interroge les releases GitHub au
démarrage : une pastille **MAJ** apparaît sur l'icône et la page d'options
affiche le lien. Installer reste manuel :

```bash
git pull && npm run build:ext
```

puis recharger l'extension dans `chrome://extensions`.

## Architecture

```
content.ts    détecte le token (URL + page), affiche le panneau en shadow DOM
     │ chrome.runtime.sendMessage
background.ts service worker : RPC, scoring, cache 60 s, vérification de version
     │
src/scanner.ts  ← le MÊME moteur que le CLI, empaqueté par esbuild
```

Le scoring n'est pas réimplémenté en JS : `extension/build.mjs` empaquette
`src/`. Une seule définition du risque, pas deux moteurs à garder synchronisés.

## Vérifications

```bash
npm run typecheck:ext   # types (DOM + chrome + node)
npm run smoke:ext       # charge les bundles SANS process ni Buffer
npm test                # dont test/extension-detect.test.ts
```

`smoke:ext` existe parce qu'une seule ligne de code partagé lisant
`process.stdout` suffit à tuer le service worker au chargement — invisible au
typecheck comme au build, et visible seulement dans Chrome.

## Limite connue

L'extension exécute le **scan complet** (requêtes RPC), pas le scorer du mode
stream. Les deux partagent les analyseurs mais pas toutes les règles : celles
qui dépendent de la progression de la courbe (baleines sur réserve mince, part
du flottant) ne vivent aujourd'hui que dans `src/stream/fast-score.ts`. Un même
token peut donc être noté différemment ici et dans `npm run stream`.
