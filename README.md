# Solana Token Risk Scanner

Outil **open-source** en ligne de commande (Node.js / TypeScript) qui analyse en temps réel un token SPL Solana à partir de son **adresse de mint**. Il vise en priorité les tokens lancés via une bonding curve (**Pump.fun**) ou négociés sur une pool décentralisée (**PumpSwap**, **Raydium**…).

Il interroge directement la blockchain via `@solana/web3.js`, sans API tierce, et produit un **diagnostic de sécurité** avec un **score de risque global de 0 à 100** :

| Niveau | Score | Signification |
|---|---|---|
| 🟢 **VERT** | 0 – 30 | Distribution saine, liquidité cohérente |
| 🟠 **ORANGE** | 31 – 69 | Signaux d'alerte : forte concentration, liquidité faible, créateur suspect… |
| 🔴 **ROUGE** | 70 – 100 | Pattern de manipulation avéré : wallets clonés, supply monopolisée, autorités dangereuses… |

Deux modes complémentaires :

| Mode | Commande | Usage | Délai |
|---|---|---|---|
| **Scan** | `npm run scan -- <MINT>` | Audit complet d'un token donné : 6 modules on-chain | quelques secondes |
| **Stream** | `npm run stream [blockchain]` | Surveille **tous** les nouveaux lancements en direct et affiche un **classement live des tokens actifs** (trades, volume, momentum) avec leur niveau de risque | Solana : ~20–300 µs de calcul après réception |

Le mode stream fonctionne sur **19 blockchains**, soit tous les réseaux actifs sur Based Bot : **Solana** (Pump.fun) et **18 chaînes EVM** (Ethereum, Base, BNB Chain, Robinhood Chain, Arbitrum, Monad…). Il suffit de nommer la chaîne :

```bash
npm run stream              # Solana (défaut)
npm run stream robinhood    # Robinhood Chain
npm run stream base         # Base
npm run stream -- --chains  # liste complète
```

Le scan ponctuel reste propre à Solana.

---

## Sommaire

- [Modules d'analyse](#modules-danalyse)
- [Installation](#installation)
- [Utilisation](#utilisation)
- [Exemple de rapport](#exemple-de-rapport)
- [Mode stream (temps réel)](#mode-stream-temps-réel)
- [Mode stream sur les blockchains EVM](#mode-stream-sur-les-blockchains-evm)
- [Moteur de scoring](#moteur-de-scoring)
- [Architecture](#architecture)
- [Choisir un endpoint RPC](#choisir-un-endpoint-rpc)
- [Déploiement](#déploiement)
- [Limites connues](#limites-connues)
- [Tests](#tests)

---

## Modules d'analyse

| # | Module | Ce qui est mesuré | Appels RPC |
|---|---|---|---|
| 1 | **Autorités & extensions** | Mint authority / freeze authority encore actives, extensions Token-2022 dangereuses (`PermanentDelegate`, `TransferHook`, taxe de transfert, `Pausable`, `DefaultAccountState` gelé, `NonTransferable`…), métadonnées modifiables | `getMultipleAccounts` |
| 2 | **Distribution des holders (Top 20)** | Top 20 des comptes, agrégés par propriétaire et classés (wallet, bonding curve, pool, burn, créateur, programme). Part cumulée du top 10 et du top 20 **hors comptes protocolaires**, part du plus gros wallet et part rapportée à la supply circulante | `getTokenLargestAccounts`, `getMultipleAccounts` |
| 3 | **Clustering de wallets** | Moyenne, **variance**, **écart-type**, coefficient de variation (σ/μ) et indice de Gini des soldes du top 20. Détection de groupes de wallets aux parts identiques **à 0,1 point de % près**, et de **clones stricts** (soldes identiques à 0,1 % près) | aucun (calcul local) |
| 4 | **Dusting check** | Recensement de **tous** les comptes du mint : nombre réel de holders comparé au nombre de soldes infinitésimaux (**< 0,001 % de la supply**), pour détecter un compteur de holders gonflé artificiellement | `getProgramAccounts` (filtre mint + `dataSlice`) |
| 5 | **Réserve réelle** | SOL **réellement** détenus par la bonding curve Pump.fun (vérifiés contre les lamports du compte, rent déduite) ou par les pools PumpSwap / Raydium AMM v4 / Raydium CPMM, comparés à la **capitalisation théorique** (prix spot × supply) | `getAccountInfo`, `getProgramAccounts`, `getMultipleAccounts` |
| 6 | **Traçabilité du créateur** | Identification du déployeur (champ `creator` de la bonding curve, sinon première transaction du mint). Solde SOL restant, part du token encore détenue, âge et activité du wallet, **nombre de tokens déjà créés** (instructions `InitializeMint` signées) | `getSignaturesForAddress`, `getTransaction`, `getBalance`, `getTokenAccountsByOwner` |

Chaque module est **isolé** : si un RPC refuse une requête (par exemple `getProgramAccounts` sur un endpoint public), le module est marqué *indisponible*, le score est recalculé sur les modules restants et l'**indice de confiance** baisse en conséquence.

---

## Installation

Prérequis : **Node.js ≥ 20.12**.

```bash
git clone https://github.com/awaping/solana-token-risk-scanner.git
cd solana-token-risk-scanner
npm install
cp .env.example .env        # puis renseigner SOLANA_RPC_URL
```

Dépendances d'exécution : `@solana/web3.js`, `@solana/spl-token` et `bignumber.js`, plus `ws` et `bs58` pour le mode stream et `viem` pour les blockchains EVM. Les couleurs ANSI, les arguments CLI et le chargement du `.env` passent par Node.js natif.

> **Deux commandes, deux usages** : `npm run scan -- <MINT>` analyse **un** token Solana donné ; `npm run stream [blockchain]` (sans adresse) surveille **tous** les nouveaux lancements d'une blockchain. Avec npm, les options se placent après `--` : `npm run scan -- <MINT> --json`, `npm run stream -- base --sort volume`.

**Sécurité des dépendances** (`npm audit` : 0 vulnérabilité) :
- `bigint-buffer`, module natif ancien utilisé par `@solana/spl-token` pour lire les entiers u64, a une faille sans correctif publié (GHSA-3gc7-fjrx-p6mg). Il est remplacé par `vendor/bigint-buffer`, une version JavaScript pure à l'API identique : aucun code natif, aucune compilation à l'installation.
- `jayson`, client RPC de `@solana/web3.js`, est forcé en v5 : elle n'embarque plus `stream-json` ni `uuid`, qui étaient vulnérables.
- Les avertissements npm `install-scripts` sur `bufferutil`, `utf-8-validate` et `esbuild` sont sans gravité : les deux premiers sont des accélérateurs optionnels de WebSocket, et `esbuild` (utilisé par `tsx`) fonctionne sans son script.

---

## Utilisation

```bash
# Analyse ponctuelle
npm run scan -- <MINT_ADDRESS>

# Avec un RPC dédié
npm run scan -- <MINT_ADDRESS> --rpc "https://mainnet.helius-rpc.com/?api-key=XXX"

# Sortie JSON (bots, pipelines)
npm run scan -- <MINT_ADDRESS> --json > rapport.json

# Surveillance en continu toutes les 60 s, avec évolution du score
npm run scan -- <MINT_ADDRESS> --watch 60

# Intégration CI / bot : code de sortie 2 si le niveau ROUGE est atteint
npm run scan -- <MINT_ADDRESS> --fail-on rouge

# Démo hors-ligne (RPC simulé, aucun endpoint requis)
npm run demo              # scénario "rug" : wallets clonés + dusting
npm run demo -- healthy   # bonding curve saine
npm run demo -- raydium   # pool Raydium + mint authority active
```

### Options

| Option | Description |
|---|---|
| `--rpc <url>` | Endpoint RPC (défaut : `$SOLANA_RPC_URL`, sinon mainnet-beta public) |
| `--creator <adresse>` | Force l'adresse du créateur (sinon détection automatique) |
| `--tx-limit <n>` | Nombre de transactions du créateur inspectées (défaut 100) |
| `--no-census` | Désactive le recensement complet des holders (module dusting) |
| `--watch <s>` | Relance l'analyse toutes les *s* secondes (minimum 15) |
| `--fail-on <niveau>` | Sort avec le code 2 si le niveau atteint `orange` ou `rouge` |
| `--json` | Sortie JSON sur stdout (la progression reste sur stderr) |
| `--no-color` | Désactive les couleurs (la variable `NO_COLOR` est aussi respectée) |

### Variables d'environnement (`.env`)

| Variable | Défaut | Rôle |
|---|---|---|
| `SOLANA_RPC_URL` | `https://api.mainnet-beta.solana.com` | Endpoint RPC |
| `RPC_CONCURRENCY` | `4` | Requêtes simultanées maximum |
| `RPC_MAX_RETRIES` | `5` | Tentatives en cas d'erreur 429, 5xx ou timeout (backoff exponentiel) |
| `CREATOR_TX_SCAN_LIMIT` | `100` | Transactions du créateur inspectées |
| `MINT_HISTORY_MAX_PAGES` | `5` | Pages de 1 000 signatures parcourues pour retrouver la création du mint |
| `HOLDER_CENSUS` | `true` | Active le recensement complet des holders |
| `SOLANA_WS_URL` | dérivé de `SOLANA_RPC_URL` | Mode stream : endpoint(s) WebSocket, séparés par des virgules |
| `YELLOWSTONE_GRPC_URL` / `YELLOWSTONE_GRPC_TOKEN` | — | Mode stream : source gRPC Geyser (optionnelle) |
| `STREAM_CHAIN` | `solana` | Mode stream : blockchain utilisée quand aucune n'est donnée en argument |
| `RPC_URL_<CHAÎNE>` | RPC publics intégrés | Mode stream EVM : RPC HTTP, ex. `RPC_URL_BASE`, `RPC_URL_ROBINHOOD` |
| `WS_URL_<CHAÎNE>` | WebSocket publics intégrés | Mode stream EVM : endpoint(s) WebSocket séparés par des virgules, ex. `WS_URL_BSC` |

### Compilation

```bash
npm run build                  # compile vers dist/
node dist/index.js <MINT>      # ou : npm link && sol-risk <MINT>
```

---

## Exemple de rapport

Extrait de `npm run demo` (scénario simulé) :

```text
── SCORE DE RISQUE GLOBAL ────────────────────────────────────────────────────
  80 / 100  [ROUGE]  ████████████████████████████████░░░░░░░░
  Pattern de manipulation avéré (wallets clonés, supply monopolisée, autorités dangereuses).
  Confiance 100 % (6/6 modules) · score pondéré 61,5 relevé au plancher 80

── Distribution des holders (Top 20) ────────────────────── ████░░░░░░  42/100
    #  Propriétaire      Part         Solde                Type
    1 EpcWrA…kT8Lq5     20,00 % ██████████     200 000 000  Pool · PumpSwap
    2 CpiopQ…PETuci      5,00 % ███░░░░░░░      50 000 000  Créateur
    3 LGe6cj…oKGW3h      3,00 % ██░░░░░░░░      30 000 000  Wallet
    4 Fj8DkW…5Xs9Ja      3,00 % ██░░░░░░░░      30 000 000  Wallet
    …
   ▲ Forte concentration — Top 10 : 32,00 % · Top 20 : 38,30 % (47,88 % de la supply circulante)
   • 20,00 % détenus par la bonding curve / les pools (exclus du calcul)

── Clustering de wallets ────────────────────────────────── ██████████ 100/100
   ✖ Wallets clonés : 10 wallets à ~3,00 % chacun, soldes identiques à 0,1 % près (30,00 % cumulés)
   • n = 14 · moyenne 2,736 % · écart-type 1,004 % · variance 1,0080 · CV 0,367 · Gini 0,168

── Dusting (faux holders) ───────────────────────────────── ██████████ 100/100
   ✖ 98,2 % des holders (800) ont un solde < 0,001 % de la supply : compteur gonflé artificiellement
   • 815 holders recensés · 15 significatifs · 0 comptes vides

── Réserve réelle & liquidité ───────────────────────────── █████░░░░░  49/100
   ✖ Liquidité quasi inexistante : 3,00 SOL dans la pool principale
   • PumpSwap · réserve 3,00 SOL · mcap théorique 15,00 SOL (ratio 20,00 %)

── Traçabilité du créateur ──────────────────────────────── ████████░░  75/100
   ▲ 3 autres tokens créés sur tout son historique
   ▲ Wallet jetable : seulement 4 transactions au total
   ▲ Wallet du créateur quasiment vidé (0,0100 SOL)

── INDICATEURS CRITIQUES ─────────────────────────────────────────────────────
   ✖ Wallets clonés : 10 wallets à ~3,00 % chacun … [Clustering de wallets]
   ✖ 98,2 % des holders (800) ont un solde < 0,001 % … [Dusting (faux holders)]
   ✖ Liquidité quasi inexistante : 3,00 SOL dans la pool principale [Réserve réelle & liquidité]
   ▲ …
   Planchers de score déclenchés :
     ≥ 80 : 10 wallets clonés (30,00 % de la supply)
```

---

## Mode stream (temps réel)

Le mode stream écoute **en continu** les transactions d'une blockchain. Sur Solana, il suit le programme Pump.fun : il rend un verdict sur chaque nouveau token **au moment même où sa création est reçue**, puis suit son **activité réelle** : trades, volume, capitalisation. Aucune requête RPC n'est faite sur le chemin critique. Les chaînes EVM sont décrites dans [la section suivante](#mode-stream-sur-les-blockchains-evm).

La plupart des lancements n'ont jamais d'acheteur : un verdict VERT signifie seulement « aucune manipulation détectée ». Le tableau de bord n'affiche donc que les tokens **ACTIFS**, qui ont franchi un seuil de **trades**, triés par activité. Le nombre de holders n'est pas utilisé comme critère : il se gonfle trop facilement en répartissant des achats sur des wallets jetables.

```bash
npm run stream                                  # Solana : tableau de bord live, trié par nombre de trades
npm run stream robinhood                        # une autre blockchain (voir --chains)
npm run stream -- --chains                      # blockchains prises en charge
npm run stream -- --sort volume --only vert     # tri par volume, risque VERT uniquement
npm run stream -- base --min-trades 50          # blockchain + options : tout après `--`
npm run stream -- --all                         # journal de chaque lancement (T0, T1, T2…)
npm run stream -- --jsonl --phases actif,alerte > actifs.jsonl   # flux JSON pour un bot
npm run stream -- --webhook https://mon-bot/hook
npm run demo:stream                             # démo hors-ligne Solana (faux nœud WebSocket)
npm run demo:stream -- robinhood                # démo hors-ligne EVM (faux nœud JSON-RPC)
npm run bench                                   # mesure de la latence du chemin critique
```

> Sans option, `npm run stream robinhood` suffit. Dès qu'il y a une option, tout se place après `--` (sinon npm intercepte les options) : `npm run stream -- robinhood --sort volume`.

### Tableau de bord

Extrait de `npm run demo:stream` :

```text
Token Risk Scanner — stream Solana (Pump.fun)  22:58:03 · en ligne depuis 4m12s · Ctrl+C pour quitter
412 tx/s · 1 187 lancements · 9 actifs · décision T0 p50 25 µs / p99 205 µs · slot 330000026 · ws:mainnet.helius-rpc.com 48 211

CLASSEMENT PAR NOMBRE DE TRADES — tokens actifs (≥ 15 trades) · lancements sans activité masqués
 #  Symbole       Âge  Trades        A/V  1 min        Volume          MCap  Courbe  Holders  Top10     Dev  Risque      Adresse
 1  HFROG          4s      32       26/6     32      14,9 SOL      47,3 SOL    31 %       20   18 %   1,8 %  VERT     0  7mjQFhfzANqaGVTG6RENFBqNpJrsnqi5HDhNK4BrrdJ3
 2  MOON           4s      23       22/1     23      35,2 SOL      64,2 SOL    46 %       21   27 %   vendu  ROUGE  100  H1KKhfTbbGXrTfKJyaFGSpeaX7cRqzYbRXA4btfZQV3j
 3  WHALE          4s      16       16/0     16      19,4 SOL      75,7 SOL    53 %       16   42 %   0,0 %  ROUGE   70  FMncUBdKagzNhG4txUGRSgqozQMnke4S5FkQNjMFBw94

DERNIERS ÉVÉNEMENTS
22:58:02.046 ⚠ ALERTE ROUGE  100  MOON   H1KKhfTbbGXrTfKJyaFGSpeaX7cRqzYbRXA4btfZQV3j · le dev vend ! · 23 trades
22:58:00.512 ★ ACTIF  ROUGE   70  WHALE  FMncUBdKagzNhG4txUGRSgqozQMnke4S5FkQNjMFBw94 · 16 trades · vol 19,4 SOL · mcap 76 SOL
22:57:59.870 ★ ACTIF  VERT     0  HFROG  7mjQFhfzANqaGVTG6RENFBqNpJrsnqi5HDhNK4BrrdJ3 · 15 trades · vol 6,2 SOL · mcap 35 SOL
```

| Colonne | Signification |
|---|---|
| Trades · A/V | Nombre total de trades, dont achats / ventes |
| 1 min | Trades sur la dernière minute (momentum) |
| Volume · MCap | Volume échangé ; capitalisation au prix spot, dans la devise de cotation (SOL, WETH, WBNB…) |
| Courbe | Solana : progression vers la graduation (`migré` une fois la pool créée) |
| Holders | Solana : wallets détenant un solde > 0, reconstruit à partir des achats et ventes. **Indicatif seulement** : ni seuil ni tri ne l'utilisent |
| Top10 · Dev | Part de la supply détenue par les 10 plus gros wallets ; part encore détenue par le dev (`vendu` s'il a vendu) |
| Risque | Score rapide recalculé en continu, **concentration réelle comprise** (`audit…` sur EVM tant que le contrat n'est pas audité) |

Les colonnes sans donnée pour la blockchain choisie sont masquées : sur EVM, Courbe, Holders et Top10 n'apparaissent pas.

Le tableau se redessine toutes les 2 s dans un terminal. Si la sortie est redirigée vers un fichier, les événements s'écrivent au fil de l'eau et le classement toutes les 30 s.

### Comment un lancement est analysé

```
 nœud Solana ──(WebSocket logsSubscribe / gRPC Geyser, commitment "processed")──▶ message brut
      │  horodatage haute résolution dès la réception
      ▼
 décodage des logs "Program data:" → CreateEvent / TradeEvent (Borsh, sans RPC)
      │
      ├─ T0  création        réputation du créateur (cache mémoire O(1)), achat initial du dev,
      │                      symbole copié  ─────────────────────────────▶ verdict en quelques µs
      ├─ T1  fenêtre bundle   acheteurs des N premiers slots : snipers, bundle Jito, montants SOL
      │                      identiques (wallets clonés), part de supply raflée ─▶ ~0,8 s après
      ├─ T2  enrichissement   historique RPC du créateur (tokens déjà déployés, âge du wallet),
      │                      en arrière-plan ─────────────────────────────▶ quelques secondes
      ├─ activité            chaque trade met à jour trades, volume, capitalisation, concentration
      ├─ ACTIF               seuil de trades franchi ─▶ le token entre au classement
      └─ ALERTE              le dev vend pendant la période de suivi ─────▶ immédiat
```

| Phase | Signal | Effet sur le score |
|---|---|---|
| T0 | Créateur vu ≥ 2 / 3 / 5 / 10 fois en 24 h | +20 / +40 / +65 / +90 (plancher 70 à 10) |
| T0 | Créateur ayant déjà revendu rapidement ses tokens | +25 (1 fois) · +45 et plancher 70 (≥ 3) |
| T0 | Achat initial du dev > 5 / 10 / 20 % | +10 / +25 / +40 (plancher 70 au-delà de 30 %) |
| T0 | Même symbole lancé il y a moins de 30 min | +10 |
| T1 | Acheteurs dans le slot de création : 3 / 6 / 10 | +15 / +30 / +45 |
| T1 | Supply raflée par ces acheteurs : 10 / 25 / 40 % | +15 / +30 / +45 (plancher 75 si dev + bundle ≥ 40 %) |
| T1 | ≥ 3 achats de montant SOL identique (±0,1 %) | +40, **plancher 80** (wallets clonés) |
| T2 | Tokens déjà créés (historique RPC), wallet jetable, wallet < 48 h | voir le scan complet |
| Activité | Top 10 holders ≥ 30 / 50 % de la supply | +15 / +30 (plancher 75 à partir de 70 %) |
| Activité | Un wallet (hors dev) ≥ 10 / 20 % | +10 / +25 (plancher 70 à partir de 30 %) |
| ALERTE | Le dev vend | +40, **plancher 70** |

### Pourquoi c'est rapide

- **Zéro RPC sur le chemin critique** : tout ce qu'il faut pour le verdict T0 est dans les logs de la transaction de création (nom, symbole, mint, créateur, achat du dev).
- **Client WebSocket minimal** sur `ws`, sans la couche de validation de web3.js ; compression désactivée ; `commitment: processed` (le plus tôt possible, avant confirmation).
- **Course entre sources** : plusieurs `--ws` et un `--grpc` peuvent tourner en parallèle ; la première source qui livre une transaction gagne, les doublons sont ignorés. Les statistiques indiquent quelle source gagne le plus souvent et de combien de millisecondes les autres sont en retard.
- **Décodage paresseux** : pour les trades de tokens non suivis (la grande majorité du trafic), seule une clé brute du mint est lue, sans encodage base58.
- **Préchauffage JIT** : au démarrage, 20 000 transactions synthétiques traversent le chemin complet pour que V8 compile le code optimisé *avant* le premier vrai lancement (sans cela, la première décision prend ~12 ms au lieu de ~0,2 ms).
- **Réputation persistée** (`.cache/creators.json`) : plus le flux tourne longtemps, plus il reconnaît les déployeurs en série.

Mesures `npm run bench` (Node 22, machine virtuelle partagée, 300 000 transactions) : **~20 µs** par transaction et **~100 µs** (p50) de la réception d'une création au verdict T0, soit une capacité de plus de 20 000 tx/s sur un seul cœur. Le flux Pump.fun réel en compte quelques centaines par seconde. En production, la commande affiche ses propres percentiles toutes les 30 s.

### Aller encore plus vite

À ce niveau, le calcul local (des microsecondes) est négligeable : **c'est le réseau qui décide** (quelques millisecondes à plusieurs dizaines de millisecondes par saut, un slot Solana ≈ 400 ms).

1. **Yellowstone gRPC** (Geyser) plutôt que WebSocket : `npm install @triton-one/yellowstone-grpc`, puis `--grpc <url> --grpc-token <jeton>` (Helius, Triton, QuickNode, Shyft…). Ce client n'est distribué que pour Linux et macOS : sous Windows, passez par WSL ou un VPS Linux.
2. **Mettre plusieurs fournisseurs en course** : `--ws wss://fournisseur-a --ws wss://fournisseur-b --grpc …`.
3. **Héberger au plus près des validateurs** : serveur à Francfort, Amsterdam ou New York, dans le même datacenter que votre fournisseur RPC.
4. Pour l'exécution d'ordres (hors du périmètre de cet outil) : transactions via bundles Jito ou connexions « stake-weighted » (SWQoS).

### Options du mode stream

| Option | Description |
|---|---|
| `[blockchain]` | Premier argument : `solana` (défaut, ou `$STREAM_CHAIN`), `robinhood`, `base`, `bsc`… Alias et noms complets acceptés (`hood`, `bnb`, `"Robinhood Chain"`) |
| `--chains` | Affiche les blockchains prises en charge et quitte |
| `--sort <clé>` | Tri du classement : `trades` (défaut), `volume`, `momentum` (trades / min), `mcap` |
| `--min-trades <n>` | Seuil pour qu'un token devienne ACTIF (défaut 15 trades) |
| `--top <n>` | Lignes du classement (défaut 15) |
| `--only <niveaux>` | Ne garde que ces niveaux de risque : `vert`, `orange`, `rouge` ou une combinaison (`vert,orange`) |
| `--refresh <s>` | Rafraîchissement du tableau (défaut 2 s, ou 30 s si la sortie n'est pas un terminal) |
| `--ws <url>` | Endpoint WebSocket, répétable. Solana : `$SOLANA_WS_URL`, sinon dérivé de `$SOLANA_RPC_URL`. EVM : `$WS_URL_<CHAÎNE>`, sinon les WebSocket publics intégrés (3 en course) |
| `--rpc <url>` | RPC HTTP (ou WebSocket). Solana : `$SOLANA_RPC_URL`. EVM : `$RPC_URL_<CHAÎNE>`, sinon les RPC publics intégrés (bascule automatique). Un RPC fourni n'est jamais remplacé par un endpoint public |
| `--grpc <url>` / `--grpc-token <jeton>` | Solana : source Yellowstone gRPC (défaut : `$YELLOWSTONE_GRPC_URL` / `$YELLOWSTONE_GRPC_TOKEN`) |
| `--bundle-slots <n>` | Solana : slots observés avant le verdict T1 (défaut 2 : création + slot suivant) |
| `--track <s>` | Durée maximale de suivi d'un token (défaut 1800 s). Un lancement jamais actif est oublié après 5 min sans trade |
| `--no-enrich` / `--enrich-tx <n>` | Solana : désactive / dimensionne l'enrichissement RPC des créateurs (défaut 25 tx) |
| `--deep-scan` | Solana : lance le scan complet (holders, réserve, créateur…) de chaque token qui devient ACTIF (hors ROUGE) |
| `--poll-ms <ms>` | EVM : intervalle d'interrogation `eth_getLogs` du relais HTTP (défaut : temps de bloc, entre 250 ms et 2 s) |
| `--audit-all` | EVM : audite chaque nouvelle pool dès sa création (défaut : seulement les tokens ACTIFS, pour économiser le RPC) |
| `--quote <adresse>` | EVM : devise de cotation supplémentaire (stablecoin, token de launchpad…), répétable |
| `--monitor <s>` | EVM : intervalle de relecture du solde du dev et de la liquidité des tokens actifs (défaut 15 s) |
| `--all` | Journal de chaque lancement (T0, T1, T2, ACTIF, ALERTE) au lieu du tableau de bord |
| `--jsonl` | Une ligne JSON par événement sur stdout, avec l'objet `activity` (trades, volume, mcap…) et le champ `chain` |
| `--phases <liste>` | Événements émis en `--all` / `--jsonl` / webhook : `t0,t1,t2,actif,alerte` |
| `--webhook <url>` | POST JSON des événements (en tableau de bord : ACTIF et ALERTE) pour un bot Telegram / Discord / trading |
| `--cache <fichier>` | Cache de réputation (défaut `.cache/creators.json` sur Solana, `.cache/creators-<chaîne>.json` sur EVM) |
| `--stats <s>` | Statistiques de débit, latence et course des sources en `--all` / `--jsonl` (défaut 30 s) |
| `--no-warmup` | Solana : saute le préchauffage JIT |

### Journal complet (`npm run stream -- --all`)

```text
⚡ T0     VERT    25  MOON    Moon Rocket · BYmF…q8qZ · dev 6zNV…ePwb · slot 330000003 +0 slot · décision 304 µs
                      ▲ Achat initial du dev : 12,00 % de la supply
◆ T1     ROUGE  100 (+75)  MOON   bundle 2 slot(s) : 7 acheteurs · 28,00 % supply · dev 12,00 % · 7 clones
                      ✖ Bundle au lancement : 7 acheteurs dans le slot de création, 7 sur les 2 premiers slots → 28,00 % de la supply
                      ✖ Wallets clonés : 7 achats identiques de 1,50 SOL (±0,1 %) dans la fenêtre
⚡ T0     ORANGE  40  CAT3    Serial CAT3 · 2aN2…qhP78 · dev FBVs…HiR6 · slot 330000008 +0 slot · décision 137 µs
                      ▲ Créateur FBVs…HiR6 : 3 lancements en 24 h (déployeur en série)
⚠ ALERTE ROUGE  100  MOON    le dev vend !
                      ✖ Le dev a vendu ses tokens
```

---

## Mode stream sur les blockchains EVM

```bash
npm run stream robinhood                           # Robinhood Chain
npm run stream -- base --sort volume --only vert   # Base, tri par volume, risque VERT uniquement
npm run stream -- bsc --ws wss://mon-noeud-bsc     # BNB Chain avec un WebSocket dédié
npm run demo:stream -- robinhood                   # démo hors-ligne
```

Le tableau de bord, le tri, les niveaux de risque et les sorties (`--all`, `--jsonl`, `--webhook`) sont les mêmes que sur Solana. Les montants sont exprimés dans la devise de cotation de la pool (WETH, WBNB, ETH natif…).

### Blockchains prises en charge

Ce sont les 19 réseaux actifs sur Based Bot. `npm run stream -- --chains` affiche la même liste.

| Clé | Réseau | Chain ID | Devise | DEX nommés | Endpoints publics intégrés (WS · HTTP) |
|---|---|---|---|---|---|
| `solana` (`sol`) | Solana | — | SOL | Pump.fun (bonding curve) | mainnet-beta (voir [RPC](#choisir-un-endpoint-rpc)) |
| `ethereum` (`eth`) | Ethereum | 1 | ETH | Uniswap v2 / v3 / v4 | 4 · 7 |
| `base` | Base | 8453 | ETH | Uniswap v2 / v3 / v4 | 4 · 6 |
| `bsc` (`bnb`) | BNB Smart Chain | 56 | BNB | PancakeSwap v2 / v3, Uniswap v2 / v3 / v4 | 4 · 6 |
| `avalanche` (`avax`) | Avalanche | 43114 | AVAX | Uniswap v2 / v3 / v4 | 2 · 5 |
| `arbitrum` (`arb`) | Arbitrum One | 42161 | ETH | Uniswap v2 / v3 / v4 | 3 · 5 |
| `abstract` (`abs`) | Abstract | 2741 | ETH | forks génériques | 2 · 2 |
| `hyperevm` (`hype`) | HyperEVM | 999 | HYPE | forks génériques | 0 · 2 |
| `ink` | Ink | 57073 | ETH | Uniswap v2 / v3 / v4 | 3 · 4 |
| `story` (`ip`) | Story (Data Network) | 1514 | DATA | forks génériques | 0 · 5 |
| `xlayer` (`okx`) | X Layer | 196 | OKB | Uniswap v2 / v3 / v4 | 1 · 4 |
| `unichain` | Unichain | 130 | ETH | Uniswap v2 / v3 / v4 | 2 · 4 |
| `plasma` (`xpl`) | Plasma | 9745 | XPL | forks génériques | 1 · 3 |
| `monad` (`mon`) | Monad | 143 | MON | Uniswap v2 / v3 / v4 | 3 · 4 |
| `megaeth` (`mega`) | MegaETH | 4326 | ETH | Uniswap v2 / v3 / v4 | 2 · 2 |
| `tempo` | Tempo | 4217 | USD | Uniswap v2 / v3 / v4 | 1 · 1 |
| `robinhood` (`hood`) | Robinhood Chain | 4663 | ETH | Uniswap v2 / v3 / v4 | 3 · 5 |
| `arc` | Arc | 5042 | USDC | Uniswap v2 / v3 / v4 | 1 · 5 |
| `stable` | Stable | 988 | USDT0 | forks génériques | 1 · 2 |

Identifiants et devises proviennent de `viem/chains`. Les adresses des factories et des wrapped natifs proviennent des SDK officiels (`@uniswap/sdk-core`, `@pancakeswap/sdk`, `@pancakeswap/v3-sdk`). Les endpoints publics intégrés (`src/chains/endpoints.ts`) viennent de [Chainlist](https://chainlist.org) (liste DefiLlama) et des RPC officiels des chaînes. Seuls sont retenus les fournisseurs sans pistage, sans clé d'API, et qui acceptent `eth_getLogs`.

### Comment un lancement est détecté

```
 nœud EVM ──(eth_subscribe "logs" en WebSocket, sinon eth_getLogs à chaque bloc)──▶ logs bruts
      │  filtre sur 9 signatures d'événements, quel que soit le contrat émetteur
      ▼
      ├─ T0     nouvelle pool   PairCreated (v2) · PoolCreated (v3, Solidly / Aerodrome) · Initialize (v4)
      │                         → côté token, côté devise de cotation ───────────────▶ immédiat
      ├─ activité               chaque Swap de la pool : achat ou vente, volume, prix, capitalisation
      ├─ ACTIF                  seuil de trades franchi ─▶ entrée au classement + audit du contrat
      ├─ T1     audit           lectures groupées (Multicall3) : propriétaire, bytecode, proxy,
      │                         créateur, part du dev, liquidité, LP brûlés ────────▶ quelques allers-retours RPC
      └─ ALERTE                 relecture toutes les --monitor s : le dev vend, la liquidité est retirée
```

- **Filtre générique** : le flux écoute les événements standard de Uniswap v2 / v3 / v4 et de Solidly / Aerodrome, quel que soit le contrat qui les émet. Tous les forks sont donc vus (PancakeSwap, SushiSwap, DEX propres à une chaîne, launchpads qui migrent vers une pool standard), même sur une chaîne sans DEX connu. Les factories connues servent seulement à nommer le DEX.
- **Devise de cotation** : une pool est retenue si elle associe un nouveau token à une devise connue. Ce peut être le natif (pools v4), le wrapped natif, une devise passée avec `--quote`, ou une devise **apprise** automatiquement, c'est-à-dire un token présent dans au moins 3 nouvelles pools. Les pools entre deux devises (WETH/USDC…) sont ignorées. Les montants de chaque swap sont ramenés au point de vue de la pool pour distinguer achats et ventes, y compris en v4 où les signes sont inversés.
- **Audit à la demande** : seuls les tokens ACTIFS sont audités. Sinon, les milliers de pools mortes créées chaque jour épuiseraient le quota RPC. `--audit-all` audite chaque pool dès sa création.
- **Créateur** : c'est l'émetteur (`from`) de la transaction qui crée la pool. Sa réputation (lancements, ventes rapides) est persistée par chaîne dans `.cache/creators-<chaîne>.json`.

### Audit du contrat et score

Les fonctions dangereuses sont repérées dans le **bytecode déployé** : on y cherche les sélecteurs de fonctions (`PUSH4`) de `mint`, `blacklist`, `setBots`, `pause`, `setTradingEnabled`, `setSellTax`, `setMaxWallet`… Ni code source vérifié ni explorateur ne sont nécessaires.

| Signal | Effet sur le score |
|---|---|
| Proxy modifiable (EIP-1967) : le code peut être remplacé | +40, plancher 65 |
| Fonction de mint et propriétaire actif | +40, plancher 60 |
| Blacklist / pause et propriétaire actif (honeypot possible) | +35, plancher 65 |
| Taxes modifiables par le propriétaire | +20 |
| Limites de transaction / wallet modifiables | +5 |
| Propriétaire non renoncé | +10 |
| Le créateur détient > 10 / 20 / 40 % de la supply | +15 / +30 / +40 (plancher 75 au-delà de 40 %) |
| Wallet créateur neuf (< 5 transactions) | +10 |
| LP brûlés < 50 % (pools v2) | +15 |
| Aucune liquidité dans la pool | +20 |
| Créateur vu 2 / ≥ 3 / ≥ 5 fois en 24 h | +20 / +40 / +60 (plancher 70 à 10) |
| Créateur ayant déjà vendu rapidement 1 / ≥ 3 de ses tokens | +25 / +45 (plancher 70) |
| ALERTE : le dev vend (solde < 50 % de son maximum observé) | +40, plancher 70 |
| ALERTE : liquidité retirée (< 20 % de son maximum observé) | plancher 90 |

Extrait de `npm run demo:stream -- robinhood --all` :

```text
Token Risk Scanner — mode stream · Robinhood Chain (chain ID 4663)
⚡ T0     audit…      ?            0x9704…e764 · nouvelle pool Uniswap v2 cotée en WETH · bloc 1001
⚡ T0     audit…      ?            0x32f3…5f06 · nouvelle pool Uniswap v3 cotée en WETH · bloc 1002
★ ACTIF  audit…      ?            0x32f3…5f06 · 10 trades · 1s après la création de la pool · Uniswap v3
◆ T1     VERT     0  HFROG        Hood Frog · 0x9704…e764 · audit du contrat · liquidité 8,000 WETH
◆ T1     ROUGE  100  MOON         Moon Rocket · 0x32f3…5f06 · audit du contrat · liquidité 5,000 WETH
                      ✖ Fonction de mint (mint) et propriétaire actif : la supply peut être gonflée
                      ✖ Blacklist / pause (setBots) : le propriétaire peut bloquer les ventes (honeypot possible)
                      ▲ Propriétaire non renoncé (0xbb…f6e1)
                      ✖ Le créateur détient 35,00 % de la supply
                      ▲ Wallet créateur neuf (1 transaction)
⚠ ALERTE ROUGE  100  MOON         0x32f3…5f06 · le dev vend !
⚠ ALERTE ROUGE  100  MOON         0x32f3…5f06 · liquidité retirée (rug) !
                      ✖ Liquidité retirée de la pool (rug pull)
```

### Sources et vitesse

**Aucune configuration n'est nécessaire** : chaque chaîne embarque une liste d'endpoints publics gratuits.

- **WebSocket en course** (`eth_subscribe "logs"`) : jusqu'à 3 WebSocket publics sont connectés en parallèle. Le premier qui livre un log gagne, les doublons sont ignorés, et si l'un tombe, les autres continuent. Un endpoint qui refuse la connexion est signalé une fois, puis retenté de plus en plus rarement (jusqu'à toutes les 30 s).
- **Relais HTTP** (`eth_getLogs`) : il reste en veille tant qu'un WebSocket fonctionne, sans consommer de quota. Si tous les WebSocket tombent, il prend le relais et reprend au bloc qui suit le dernier reçu, sans trou. Sur les chaînes sans WebSocket public (HyperEVM, Story), c'est la source principale, au rythme du temps de bloc (`--poll-ms` pour l'ajuster).
- **Bascule** : en cas d'erreur, l'interrogation HTTP et les audits passent à l'endpoint suivant de la liste. La plage `eth_getLogs` est réduite automatiquement si un RPC la refuse.

Le délai de détection est borné par le **temps de bloc** de la chaîne : de ~250 ms (Arbitrum, Robinhood Chain) à 12 s (Ethereum). Le calcul local reste de l'ordre de la microseconde.

#### Où trouver de meilleurs endpoints

Les endpoints publics sont limités en débit. Pour un usage continu, un fournisseur avec clé gratuite est plus fiable et plus rapide :

| Besoin | Où chercher |
|---|---|
| Liste des endpoints publics d'une chaîne | [chainlist.org](https://chainlist.org) : cherchez la chaîne, colonne « Privacy » pour le pistage |
| Clé gratuite multi-chaînes (HTTP + WebSocket) | [Alchemy](https://www.alchemy.com), [QuickNode](https://www.quicknode.com), [dRPC](https://drpc.org), [Ankr](https://www.ankr.com/rpc/) : vérifiez que la chaîne voulue est proposée |
| Solana | [Helius](https://www.helius.dev) (offre gratuite avec WebSocket), Triton, QuickNode |

Puis déclarez-les dans `.env` : les endpoints fournis remplacent les endpoints publics.

```bash
RPC_URL_ROBINHOOD=https://…        # RPC HTTP (audits, relais)
WS_URL_ROBINHOOD=wss://…,wss://…   # un ou plusieurs WebSocket, mis en course
SOLANA_RPC_URL=https://mainnet.helius-rpc.com/?api-key=…
```

---

## Moteur de scoring

### 1. Sous-scores (0-100) par module

Chaque métrique est convertie en score par **interpolation linéaire par morceaux** entre des seuils documentés (`src/scoring/engine.ts`).

| Module | Poids | Barème (métrique → sous-score) |
|---|---|---|
| Autorités | 10 | Mint authority +60 · freeze authority +50 · extension critique +60 · extension à risque +25 · métadonnées modifiables +5 |
| Holders | 25 | 30 % × top 10 (10 % → 0, 30 % → 50, 70 % → 100) + 30 % × top 20 (15 % → 0, 45 % → 60, 80 % → 100) + 40 % × plus gros wallet (2 % → 0, 10 % → 60, 30 % → 100) |
| Clustering | 20 | max(uniformité, cluster). Uniformité : CV 0,1 → 100, 0,35 → 55, 0,7 → 0 (atténuée si le top 20 détient < 10 %). Cluster : 3 wallets → 35, 5 → 65, 10 → 100, pondéré par la part cumulée. Clones stricts : 3 → 80, ≥ 6 → 100 |
| Dusting | 10 | Ratio poussière/holders : 10 % → 0, 35 % → 50, 50 % → 75, 70 % → 100 (divisé par 2 si moins de 20 holders) |
| Réserve | 20 | *Bonding curve* : 0,5 SOL → 70, 10 SOL → 35, 85 SOL → 5 (+40 si les lamports ne couvrent pas la réserve déclarée). *Pool* : 50 % liquidité absolue (1 SOL → 100, 50 SOL → 35, 300 SOL → 5) + 50 % ratio réserve/mcap (1 % → 100, 7 % → 45, 25 % → 0). Aucune réserve trouvée → 65 |
| Créateur | 15 | Tokens déjà créés (1 → 20, 3 → 50, 5 → 70, 10 → 90, 20 → 100) + wallet jetable (< 15 tx) +15 + wallet de moins de 48 h +10 + créateur à 0 % +10 / > 10 % +25 / > 20 % +40 + wallet vidé (< 0,05 SOL) +10 |

### 2. Score global

```
score pondéré = Σ (poids × sous-score) / Σ poids des modules disponibles
score final   = max(score pondéré, plancher le plus élevé déclenché)
```

### 3. Planchers

Une moyenne pondérée peut diluer un signal grave (10 wallets clonés compensés par une bonne liquidité, par exemple). Les **planchers** garantissent qu'un pattern avéré place toujours le token au bon niveau :

| Condition | Plancher |
|---|---|
| Un wallet détient ≥ 50 % de la supply | 85 |
| ≥ 3 wallets **clonés** (soldes identiques à 0,1 % près) détenant ≥ 3 % | 80 |
| Un wallet ≥ 30 % **ou** top 10 ≥ 60 % (supply monopolisée) | 75 |
| Cluster de ≥ 5 wallets à ±0,1 pt détenant ≥ 10 % | 70 |
| Top 20 anormalement uniforme (CV < 0,15, n ≥ 10, top 20 ≥ 15 %) | 70 |
| Extension Token-2022 critique (permanent delegate, pause, gel par défaut…) | 70 |
| Pool AMM avec moins de 1 SOL de liquidité (liquidité retirée) | 70 |
| Freeze authority active | 65 |
| Mint authority active | 60 |
| Déployeur en série (≥ 10 tokens) | 60 |

### Pourquoi l'écart-type détecte le clustering

Une distribution organique suit une loi de puissance : quelques gros holders puis une longue traîne. Le **coefficient de variation** σ/μ du top 20 y est typiquement compris entre 0,6 et 1,2. Un opérateur qui répartit sa supply sur N wallets produit au contraire des soldes quasi identiques, donc un σ faible et un CV proche de 0.

L'outil combine deux mesures complémentaires :

- **les statistiques globales** (variance, écart-type, CV, Gini) sur tout le top 20 ;
- **la détection de groupes** : un wallet rejoint un groupe tant que sa part reste à ±0,1 point du plus gros wallet du groupe. Cette tolérance est plafonnée à 5 % relatifs, pour ne pas regrouper à tort les petites positions de la traîne.

---

## Architecture

```
src/
├── index.ts              # CLI : scan (arguments, mode watch, codes de sortie) et sous-commande stream
├── scanner.ts            # Orchestration parallèle des modules, isolation des erreurs
├── config.ts             # .env, options, masquage des clés d'API
├── constants.ts          # Programmes & adresses connus (Pump.fun, PumpSwap, Raydium, Orca, Meteora…)
├── types.ts              # Types partagés
├── rpc/client.ts         # Connection web3.js + limiteur de concurrence + retries exponentiels
├── analyzers/
│   ├── token.ts          # Mint, autorités, extensions Token-2022, métadonnées Metaplex / Token-2022
│   ├── holders.ts        # Top 20, agrégation par propriétaire, classification
│   ├── clustering.ts     # Variance / écart-type / CV / Gini + détection de groupes
│   ├── dusting.ts        # Recensement des holders et ratio de poussière
│   ├── pumpfun.ts        # Décodage de la bonding curve Pump.fun, prix, progression
│   ├── reserve.ts        # Réserve réelle : bonding curve, PumpSwap, Raydium AMM v4 / CPMM, repli générique
│   └── creator.ts        # Identification et historique du créateur
├── scoring/engine.ts     # Barème, planchers, score global
├── report/console.ts     # Rendu terminal + JSON
├── chains/
│   ├── registry.ts       # Les 19 blockchains du mode stream : clés, alias, DEX connus, wrapped natif
│   └── endpoints.ts      # Endpoints publics sans clé par chaîne (Chainlist + RPC officiels)
├── evm/                  # Mode stream sur les chaînes EVM
│   ├── cli.ts            # Sources (WebSocket / HTTP), client viem, rendu des événements
│   ├── engine.ts         # Nouvelles pools, devises de cotation, swaps, ACTIF, audits, alertes
│   ├── events.ts         # Décodage des logs Uniswap v2 / v3 / v4 et Solidly / Aerodrome
│   ├── sources.ts        # WebSocket en course (eth_subscribe) et relais HTTP eth_getLogs avec bascule
│   ├── audit.ts          # Audit ERC-20 : propriétaire, sélecteurs du bytecode, proxy, dev, liquidité, LP
│   └── score.ts          # Score de risque EVM (fonction pure)
├── stream/               # Mode temps réel
│   ├── cli.ts            # Commande stream : choix de la blockchain, puis Solana (sources, sorties, stats)
│   ├── cli-common.ts     # Options, filtres et webhook communs à toutes les chaînes
│   ├── live-ui.ts        # Tableau de bord live (terminal ou sortie redirigée), journal, JSONL
│   ├── engine.ts         # Moteur Solana : course multi-sources, suivi des lancements, T0 / T1 / T2 / ACTIF / alertes
│   ├── activity.ts       # Holders exacts, trades, volume, momentum, capitalisation, concentration
│   ├── dashboard.ts      # Classement des tokens actifs (tri par trades, volume, momentum, mcap)
│   ├── events.ts         # Décodage des événements Anchor Pump.fun depuis les logs
│   ├── fast-score.ts     # Score rapide (fonction pure) + statistiques de bundle
│   ├── reputation.ts     # Cache de réputation des créateurs (persisté)
│   ├── warmup.ts         # Préchauffage JIT du chemin critique
│   ├── synthetic.ts      # Transactions synthétiques (préchauffage, tests, démo, bench)
│   └── sources/          # WebSocket (logsSubscribe) et Yellowstone gRPC
└── utils/                # BigNumber (stats), formatage FR, couleurs ANSI
test/                     # Tests unitaires + bout en bout sur nœuds simulés (Solana et EVM)
scripts/                  # demo.ts, demo-stream.ts, demo-stream-evm.ts (démos hors-ligne), bench.ts (latence)
```

Tous les montants on-chain (u64) sont manipulés en `bigint`. Les pourcentages et les statistiques (moyenne, variance, écart-type, Gini) sont calculés en précision arbitraire avec **bignumber.js**, pour éviter toute perte de précision au-delà de 2^53.

Graphe d'exécution :

```
token ──┬── holders ──┬── clustering
        ├── dusting   │
        └── réserve ──┴── créateur (identité, puis historique)
```

---

## Choisir un endpoint RPC

L'endpoint public `api.mainnet-beta.solana.com` est **fortement limité** (≈ 100 requêtes / 10 s par IP) et refuse souvent les `getProgramAccounts` lourds. Le scanner fonctionne quand même : retries automatiques, et modules indisponibles signalés avec un indice de confiance réduit. Pour une analyse **complète et rapide**, utilisez un RPC dédié : Helius, Triton, QuickNode, Alchemy… Les offres gratuites suffisent généralement.

Sur les chaînes EVM, le mode stream fonctionne sans configuration grâce aux endpoints publics intégrés, mais ils sont limités en débit. Pour un usage continu, déclarez un endpoint dédié par chaîne dans `.env` : `RPC_URL_BASE=…`, `WS_URL_BASE=wss://…`. La clé de la chaîne est en majuscules : `RPC_URL_ROBINHOOD`, `WS_URL_BSC`… Voir [où trouver de meilleurs endpoints](#où-trouver-de-meilleurs-endpoints).

---

## Déploiement

| Usage | Recommandation |
|---|---|
| Analyses ponctuelles | **En local** : `npm run scan -- <MINT>`. Aucun coût, et votre clé RPC reste sur votre machine |
| Surveillance 24h/24 (`--watch`, alertes) | Un **petit VPS** (Hetzner, OVH, Scaleway… ≈ 5 €/mois) avec `systemd`, `pm2` ou Docker, situé près de votre fournisseur RPC (Francfort / US-East) |
| Service public (API, bot Telegram/Discord multi-utilisateurs) | Cloud managé (AWS Lambda + API Gateway, Fly.io, Railway…), en exploitant la sortie `--json` ou en important `scanToken()` |

La performance dépend avant tout de la **qualité de l'endpoint RPC**, bien plus que de l'hébergement.

---

## Limites connues

- **Heuristiques, pas certitudes.** Un wallet de CEX, un locker ou un contrat de vesting peut apparaître comme une « baleine ». Les comptes-programmes non identifiés sont signalés, mais pas exclus des calculs.
- **Top 20 = top 20 comptes de token** (`getTokenLargestAccounts`). Après exclusion de la bonding curve et des pools, l'échantillon de wallets peut contenir moins de 20 entrées.
- **Pools supportées** : PumpSwap, Raydium AMM v4 et Raydium CPMM, en paire **SOL** (WSOL). Repli générique pour les autres pools détectées dans le top holders (Orca, Meteora, Raydium CLMM…) dont le compte de pool détient directement son vault WSOL. Les pools cotées uniquement en USDC ne sont pas valorisées.
- **Historique du créateur** limité à `CREATOR_TX_SCAN_LIMIT` transactions : au-delà, le nombre de tokens créés est une borne basse, signalée comme telle.
- **Mode stream** : le commitment `processed` est le plus rapide mais une transaction peut, rarement, disparaître lors d'un fork ; le verdict T0 repose sur la réputation *observée* (cache vide au premier lancement, d'où l'intérêt de laisser tourner le flux) ; si Pump.fun modifie le format de ses événements, le décodeur ignore les messages illisibles au lieu de planter ; si les logs d'une création sont tronqués (limite de 10 Ko), elle est retrouvée via RPC avec un délai.
- Les bonding curves Pump.fun créées avant l'ajout du champ `creator` passent par la recherche de la transaction de création du mint (limitée à `MINT_HISTORY_MAX_PAGES` pages).
- **Mode stream EVM** :
  - Il est récent : il a été validé contre des nœuds simulés qui reproduisent les formats d'événements officiels, pas encore en conditions réelles sur chacune des 18 chaînes.
  - Les endpoints publics intégrés ne sont pas garantis : un fournisseur peut limiter ou fermer son accès gratuit à tout moment. La course entre WebSocket et la bascule HTTP limitent l'impact ; pour un suivi fiable, déclarez vos propres endpoints dans `.env`.
  - Les launchpads à bonding curve (four.meme sur BNB Chain, launchpads de Base ou de Robinhood Chain…) ne sont vus qu'au moment où le token **migre vers une pool DEX standard**. La phase de bonding curve n'est pas suivie.
  - Il n'y a **pas de simulation d'achat / vente**. Un honeypot dont le blocage est codé autrement (logique cachée dans `_transfer`, fonctions aux noms non standard) peut échapper à la recherche de sélecteurs.
  - Il n'y a **ni holders ni Top 10** : les obtenir demanderait un indexeur. La part du créateur est lue directement.
  - Sur les pools Uniswap v4, la liquidité n'est pas lue (pas de LP à brûler) et les hooks ne sont pas analysés.
  - La devise de cotation doit être le natif, le wrapped natif, une devise `--quote` ou une devise apprise. Les premières pools cotées dans un stablecoin passent inaperçues tant que celui-ci n'a pas été appris.
- **Scan ponctuel** : il reste propre à Solana (`npm run scan -- <MINT>`).

---

## Tests

```bash
npm test          # tests unitaires + bout en bout (RPC et WebSocket simulés, aucun réseau requis)
npm run typecheck
npm run bench     # latence du chemin critique du mode stream
```

Les tests de bout en bout démarrent un **faux nœud Solana JSON-RPC** en mémoire (`test/fixtures/mock-rpc.ts`) et exécutent le scanner complet via `@solana/web3.js` sur trois scénarios :

- un rug Pump.fun gradué sur PumpSwap : wallets clonés, dusting, liquidité minuscule ;
- une bonding curve saine ;
- une pool Raydium AMM v4 avec mint authority active.

Le mode stream est testé de la même façon, avec un faux nœud WebSocket : abonnement, reconnexion après coupure, verdicts T0 / T1 / T2 / alerte, course entre sources, logs tronqués, puis la commande complète lancée en sous-processus (sortie JSONL, arrêt sur SIGINT).

Le mode EVM s'appuie sur un **faux nœud JSON-RPC EVM** (`test/fixtures/evm.ts`). Il gère `eth_getLogs`, les appels ERC-20 et Multicall3, le bytecode et les transactions. Les tests couvrent :

- le registre des chaînes ;
- le décodage des logs v2 / v3 / v4 ;
- achats et ventes, apprentissage des devises, pools natives v4 ;
- l'audit (propriétaire, mint, blacklist, part du dev, LP brûlés) ;
- les alertes de vente du dev et de retrait de liquidité ;
- la bascule entre endpoints HTTP et le relais HTTP qui reprend sans trou quand les WebSocket tombent ;
- la commande `stream base` complète en sous-processus, y compris avec un WebSocket injoignable.

---

## Avertissement

Cet outil est une **aide à la décision** fondée sur des heuristiques on-chain. Il ne constitue **pas un conseil financier**. Un score VERT ne garantit pas l'absence de risque. Faites toujours vos propres recherches (DYOR).

## Licence

[MIT](LICENSE)
