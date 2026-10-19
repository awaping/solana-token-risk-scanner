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

## Panneau : actualiser la note

Le bouton **↻** en haut du panneau relance l'analyse immédiatement, sans
attendre le cache de 60 s : la blockchain est relue et la nouvelle note
s'affiche avec son évolution (« Précédente : 62 à 14:02 (+13) · 1re : 58 à
13:40 · 3 analyses »). Une hausse s'affiche en rouge (plus risqué), une baisse
en vert.

## Dev et réseaux sociaux

Sous la note, le panneau affiche le **dev** (lien vers son profil pump.fun, avec
son pseudo quand pump.fun le fournit) et les **réseaux déclarés par le token** :
X/Twitter (pseudo, tweet ou communauté), Telegram, site. Ils sont lus dans le
fichier de métadonnées du token (le JSON pointé par l'URI on-chain, souvent sur
IPFS), dont le lien est déjà récupéré pendant l'analyse : aucune requête RPC de
plus.

C'est purement informatif : ces liens sont chargés **après** l'affichage de la
note, par une demande séparée, et n'entrent pas dans le score. Leur contenu est
choisi par le créateur du token : seuls les liens http(s) sont affichés, le lien
X est reconstruit à partir du pseudo, et rien n'est interprété comme du HTML.
Le pseudo du dev vient d'un service non officiel de pump.fun : s'il ne répond
pas, seule l'adresse du dev est affichée. Les réseaux sont aussi enregistrés
dans l'historique (fiche du token).

Les fichiers de métadonnées sont hébergés chez des services très variés (IPFS,
Arweave, outils de lancement comme j7tracker…). Les plus courants sont autorisés
d'office ; un fichier IPFS servi par une autre passerelle est relu via
`ipfs.io`. Pour un hébergeur non autorisé, l'extension ne tente pas la lecture
(Chrome la bloquerait et l'inscrirait dans les erreurs de l'extension) : le
panneau affiche « réseaux non lus (hébergeur) · autoriser ». Le bouton
**Autoriser tous les hébergeurs** des réglages lève cette limite en une fois
(les requêtes partent sans cookies).

## Historique des analyses

Chaque analyse est conservée dans le navigateur (`chrome.storage.local`) :
l'analyse faite à l'ouverture du token, puis chaque actualisation. Le lien
**Historique ›** du panneau (ou le bouton des réglages) ouvre la page
`history.html` :

- la liste des tokens analysés, avec leur première et dernière note et une
  mini-courbe ;
- pour un token : la courbe de sa note dans le temps sur fond des zones
  VERT / ORANGE / ROUGE (survol = note exacte), le tableau de chaque analyse
  (couverture, top 10, plus gros wallet, baleines, holders, réserve, mcap,
  progression de la courbe, part du créateur, alertes) et le détail complet de
  la dernière analyse (constats de chaque module, top holders, créateur,
  marché, données brutes en JSON) ;
- export JSON (un token ou tout l'historique) et suppression.

La page se met à jour en direct quand une analyse arrive. L'historique reste
sur ta machine : rien n'est envoyé ailleurs. Plafonds : 1 000 tokens et
200 analyses par token (l'analyse initiale est toujours gardée).

Chaque analyse garde aussi l'**âge du token** au moment où elle a été demandée
(date de la première transaction du mint, lue en une requête pour un token
jeune) : le panneau affiche « Âge du token : 1 min 05 s · 17 s à l'ouverture de
la page », et la fiche du token l'origine de chaque analyse (ouverture,
actualisation, achat, suivi automatique).

### Coins déjà rug à l'ouverture

Un token déjà mort quand tu ouvres sa page (pool vidée sous 1 SOL, ou bonding
curve revenue sous 0,5 SOL après au moins 40 transactions ou 15 min de vie) est
marqué **déjà rug** : bandeau rouge dans le panneau, étiquette dans la liste.
Ces tokens sont masqués de la liste et exclus des statistiques par défaut (case
**Masquer les coins déjà rug à l'ouverture**, décochable). Un token vivant à
l'ouverture qui meurt ensuite n'est pas concerné : c'est une issue, comptée
comme un rug.

## Paper trading DryFlip et analyse rug / run

Avec l'extension [DryFlip](https://dryflip.com) (paper trading sur Axiom, GMGN,
Padre…), le panneau affiche ta position sur le token ouvert :
« Paper DryFlip · IN 1 SOL · PnL +0,4 SOL (+40 %) · reste 0 SOL · solde 9 SOL »,
puis « IN à 39 s de vie · OUT à 58 s · détenu 19 s ».

**Comment c'est lu.** Une extension ne peut pas lire le stockage d'une autre :
le panneau lit ce que DryFlip **affiche** sur la page (Bought / Sold /
Remaining / PnL du widget, Balance de la carte flottante), chaque seconde, y
compris dans un shadow DOM fermé. Seuls les éléments identifiables comme DryFlip
sont lus, jamais le reste de la page (où le terminal affiche ton vrai wallet).
La mise en page de DryFlip n'étant pas documentée, la lecture se fonde sur les
libellés. Si la position n'apparaît pas alors que tu es IN, le lien
**diagnostic** du panneau copie ce que l'extension voit du widget (textes de
DryFlip uniquement) : colle-le dans une issue pour ajuster la lecture.

**À chaque achat (IN)** vu en direct, le token est analysé immédiatement : note,
holders, dusting, réserve, créateur… tels qu'au moment de l'achat, avec l'âge du
token à la seconde près (lecture chaque seconde). Une position déjà ouverte à
l'ouverture de la page est marquée comme telle (heure = première lecture). Les
ventes (OUT) sont datées de la même façon ; une position qui disparaît du widget
plus de 5 s (ou le widget qui disparaît de la page) vaut vente totale, datée du
moment de la disparition, au dernier PnL affiché (si elle revient telle quelle
dans la minute, c'était un simple re-rendu : la sortie est annulée). Une position
est aussi considérée comme soldée quand le reste affiché est à zéro, à « 0 % »,
ou n'est plus qu'une poussière d'arrondi (moins de 1 % du montant investi). Si
une sortie échappe malgré tout à la lecture, le lien **j'ai vendu (OUT)** du
panneau l'enregistre à l'instant, avec le dernier PnL affiché ; le lien
**diagnostic** (toujours présent) copie ce que l'extension voit du widget.

**Issue du token.** Après le premier achat, le token est ré-analysé
automatiquement à 5 min, 15 min, 1 h, 4 h et 24 h, même si la page est fermée
(reprise au redémarrage du navigateur). Sa capitalisation (en SOL) dit s'il a :

- **run** : au moins ×2 après l'achat ;
- **rug** : −70 % ou plus (ou réserve vidée à 90 %) sans avoir doublé avant ;
- **neutre** : ni l'un ni l'autre à 4 h.

**Page « Paper trading & analyse »** (bouton en haut de l'historique) : solde
DryFlip dans le temps, PnL total, taux de réussite, résultats par note de risque
au moment de l'achat, puis deux comparaisons : **run vs rug** et **trades
gagnants vs perdants**. Pour chacune, la médiane de chaque donnée relevée à
l'achat (note, âge du token, capitalisation, réserve, top 10, plus gros wallet,
holders, poussière, part et passé du créateur, clusters…) et les alertes plus
fréquentes d'un côté que de l'autre. Export CSV de tous les trades (séparateur
« ; », pour Excel). La case **Suivre mes positions de paper trading DryFlip**
des réglages désactive le tout.

## Mises à jour

Chrome interdit à une extension chargée depuis un dossier de réécrire ses
propres fichiers. L'extension détecte donc les nouvelles versions (lecture du
manifest sur la branche `main` du dépôt, au démarrage puis toutes les 3 h :
pastille **MAJ** sur l'icône), et confie l'installation à un **assistant
local** qui fait le `git pull` à sa place.

### Installer l'assistant (une seule fois)

Dans PowerShell (ou un terminal), dans le dossier du projet :

```bash
npm run setup:updater
```

Puis recharge l'extension dans `chrome://extensions`. Les réglages de
l'extension affichent alors **Mettre à jour maintenant** quand une version est
disponible, et la case **Mise à jour automatique** (cochée par défaut) installe
les nouvelles versions d'elle-même. Après une mise à jour, l'extension
redémarre ; les onglets déjà ouverts proposent de rafraîchir la page.

L'assistant (`extension/updater/host.mjs`) ne connaît que trois commandes
(état, vérification, mise à jour en avance rapide) et n'agit que dans ce
dossier. Seule cette extension peut le lancer : son identifiant est fixe
(`mfklmdnbbdihmkpbfidgnhjpbafgdppg`, dérivé de la clé `key` du manifest), quel
que soit le dossier d'installation. Les fichiers générés modifiés localement
(`extension/dist`, `package-lock.json`) sont rétablis avant la mise à jour ;
toute autre modification locale bloque la mise à jour avec un message qui
nomme les fichiers. Désinstallation : `npm run setup:updater -- --remove`.

Sans assistant, la mise à jour reste manuelle : `git pull` dans le dossier,
puis ↻ dans `chrome://extensions`.

> **Passage à la 1.3.0** : l'identifiant de l'extension devient fixe. Chrome la
> considère donc comme une nouvelle extension une dernière fois : il faut
> recoller l'endpoint RPC dans les réglages. Ensuite, réglages et historique
> sont conservés, même si tu déplaces ou reclones le dossier.

## Architecture

```
content.ts        détecte le token (URL + page), affiche le panneau en shadow DOM
     │ chrome.runtime.sendMessage
background.ts     service worker : RPC (8 req/s partagées), scoring, cache 60 s,
     │            historique, vérification et installation des mises à jour
     ├── src/scanner.ts        ← le MÊME moteur que le CLI, empaqueté par esbuild
     ├── history-store.ts      historique (chrome.storage.local) ← aussi lu par history-page.ts
     ├── paper-*.ts            lecture du widget DryFlip, achats / ventes, issue run / rug
     └── updater/host.mjs      assistant local (native messaging) : git pull
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
