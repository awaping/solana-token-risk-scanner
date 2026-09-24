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
| **Stream** | `npm run stream` | Surveille **tous** les lancements Pump.fun en direct : verdict à la création, puis après la fenêtre de bundle | ~20–300 µs de calcul après réception |

---

## Sommaire

- [Modules d'analyse](#modules-danalyse)
- [Installation](#installation)
- [Utilisation](#utilisation)
- [Exemple de rapport](#exemple-de-rapport)
- [Mode stream (temps réel)](#mode-stream-temps-réel)
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

Dépendances d'exécution : `@solana/web3.js`, `@solana/spl-token` et `bignumber.js`, plus `ws` et `bs58` pour le mode stream. Les couleurs ANSI, les arguments CLI et le chargement du `.env` passent par Node.js natif.

> **Deux commandes, deux usages** : `npm run scan -- <MINT>` analyse **un** token donné ; `npm run stream` (sans adresse) surveille **tous** les nouveaux lancements. Avec npm, les options se placent après `--` : `npm run scan -- <MINT> --json`.

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

Le mode stream écoute **en continu** toutes les transactions du programme Pump.fun et rend un verdict sur chaque nouveau token **au moment même où sa création est reçue**. Aucune requête RPC n'est faite sur le chemin critique.

```bash
npm run stream                                  # WebSocket dérivé de SOLANA_RPC_URL
npm run stream -- --only vert                   # n'affiche que les lancements propres
npm run stream -- --jsonl > lancements.jsonl    # une ligne JSON par verdict (pour un bot)
npm run stream -- --webhook https://mon-bot/hook
npm run demo:stream                             # démo hors-ligne (faux nœud WebSocket)
npm run bench                                   # mesure de la latence du chemin critique
```

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
| `--ws <url>` | Endpoint WebSocket, répétable (défaut : `$SOLANA_WS_URL`, sinon dérivé de `$SOLANA_RPC_URL`) |
| `--grpc <url>` / `--grpc-token <jeton>` | Source Yellowstone gRPC (défaut : `$YELLOWSTONE_GRPC_URL` / `$YELLOWSTONE_GRPC_TOKEN`) |
| `--bundle-slots <n>` | Slots observés avant le verdict T1 (défaut 2 : création + slot suivant) |
| `--track <s>` | Durée de suivi des ventes du dev (défaut 300 s) |
| `--no-enrich` / `--enrich-tx <n>` | Désactive / dimensionne l'enrichissement RPC des créateurs (défaut 25 tx) |
| `--deep-scan <s>` | Lance le scan complet des tokens non ROUGE N secondes après leur création |
| `--only <niveaux>` | Filtre l'affichage : `vert`, `orange`, `rouge` ou une combinaison (`vert,orange`) |
| `--jsonl` | Une ligne JSON par verdict sur stdout ; les messages d'état vont sur stderr |
| `--webhook <url>` | POST JSON de chaque verdict affiché (bot Telegram / Discord / trading) |
| `--cache <fichier>` | Cache de réputation (défaut `.cache/creators.json`) |
| `--stats <s>` | Statistiques de débit, latence et course des sources (défaut 30 s) |
| `--no-warmup` | Saute le préchauffage JIT |

### Exemple (`npm run demo:stream`)

```text
  préchauffage JIT : 20 000 tx synthétiques en 970 ms
⚡ T0     VERT     0  HFROG   Honest Frog · DUs9…txAN · dev 8YXd…qXdp · slot 330000000 +0 slot · décision 240 µs
◆ T1     VERT     0  HFROG   bundle 2 slot(s) : 1 acheteur · 0,80 % supply · dev 1,50 %
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
├── stream/               # Mode temps réel
│   ├── cli.ts            # Commande stream : sources, sorties (console, JSONL, webhook), stats
│   ├── engine.ts         # Moteur : course multi-sources, suivi des lancements, T0 / T1 / T2 / alertes
│   ├── events.ts         # Décodage des événements Anchor Pump.fun depuis les logs
│   ├── fast-score.ts     # Score rapide (fonction pure) + statistiques de bundle
│   ├── reputation.ts     # Cache de réputation des créateurs (persisté)
│   ├── warmup.ts         # Préchauffage JIT du chemin critique
│   ├── synthetic.ts      # Transactions synthétiques (préchauffage, tests, démo, bench)
│   └── sources/          # WebSocket (logsSubscribe) et Yellowstone gRPC
└── utils/                # BigNumber (stats), formatage FR, couleurs ANSI
test/                     # Tests unitaires + bout en bout sur RPC simulé
scripts/                  # demo.ts, demo-stream.ts (démos hors-ligne), bench.ts (latence)
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

---

## Avertissement

Cet outil est une **aide à la décision** fondée sur des heuristiques on-chain. Il ne constitue **pas un conseil financier**. Un score VERT ne garantit pas l'absence de risque. Faites toujours vos propres recherches (DYOR).

## Licence

[MIT](LICENSE)
