# Solana Token Risk Scanner

Outil **open-source** en ligne de commande (Node.js / TypeScript) qui analyse en temps réel un token SPL Solana à partir de son **adresse de mint**. Il vise en priorité les tokens lancés via une bonding curve (**Pump.fun**) ou négociés sur une pool décentralisée (**PumpSwap**, **Raydium**…).

Il interroge directement la blockchain via `@solana/web3.js`, sans API tierce, et produit un **diagnostic de sécurité** avec un **score de risque global de 0 à 100** :

| Niveau | Score | Signification |
|---|---|---|
| 🟢 **VERT** | 0 – 30 | Distribution saine, liquidité cohérente |
| 🟠 **ORANGE** | 31 – 69 | Signaux d'alerte : forte concentration, liquidité faible, créateur suspect… |
| 🔴 **ROUGE** | 70 – 100 | Pattern de manipulation avéré : wallets clonés, supply monopolisée, autorités dangereuses… |

---

## Sommaire

- [Modules d'analyse](#modules-danalyse)
- [Installation](#installation)
- [Utilisation](#utilisation)
- [Exemple de rapport](#exemple-de-rapport)
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

Dépendances d'exécution : `@solana/web3.js`, `@solana/spl-token` et `bignumber.js`. Aucune autre : les couleurs ANSI, les arguments CLI et le chargement du `.env` passent par Node.js natif.

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
├── index.ts              # CLI (arguments, mode watch, codes de sortie)
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
└── utils/                # BigNumber (stats), formatage FR, couleurs ANSI
test/                     # Tests unitaires + bout en bout sur RPC simulé
scripts/demo.ts           # Démo hors-ligne
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
- Les bonding curves Pump.fun créées avant l'ajout du champ `creator` passent par la recherche de la transaction de création du mint (limitée à `MINT_HISTORY_MAX_PAGES` pages).

---

## Tests

```bash
npm test          # tests unitaires + bout en bout (RPC JSON simulé, aucun réseau requis)
npm run typecheck
```

Les tests de bout en bout démarrent un **faux nœud Solana JSON-RPC** en mémoire (`test/fixtures/mock-rpc.ts`) et exécutent le scanner complet via `@solana/web3.js` sur trois scénarios :

- un rug Pump.fun gradué sur PumpSwap : wallets clonés, dusting, liquidité minuscule ;
- une bonding curve saine ;
- une pool Raydium AMM v4 avec mint authority active.

---

## Avertissement

Cet outil est une **aide à la décision** fondée sur des heuristiques on-chain. Il ne constitue **pas un conseil financier**. Un score VERT ne garantit pas l'absence de risque. Faites toujours vos propres recherches (DYOR).

## Licence

[MIT](LICENSE)
