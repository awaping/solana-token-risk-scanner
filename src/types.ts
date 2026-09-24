/**
 * Types partagés entre les analyseurs, le moteur de scoring et le rendu.
 *
 * Les montants on-chain (u64) sont manipulés en `bigint` (unités brutes) ;
 * les pourcentages et statistiques sont exprimés en `number` après calcul
 * en précision arbitraire via bignumber.js.
 */

export type ModuleId = 'authorities' | 'holders' | 'clustering' | 'dusting' | 'reserve' | 'creator';

export type Severity = 'info' | 'ok' | 'warning' | 'critical';

export interface Finding {
  severity: Severity;
  message: string;
}

/** Résultat brut d'un module : soit des données, soit la raison de l'échec. */
export type ModuleOutcome<T> = { status: 'ok'; data: T } | { status: 'unavailable'; reason: string };

// ---------------------------------------------------------------------------
// Token / autorités
// ---------------------------------------------------------------------------

export interface TokenInfo {
  mint: string;
  /** "SPL Token" ou "Token-2022". */
  programLabel: string;
  programId: string;
  decimals: number;
  /** Supply totale en unités brutes. */
  supply: bigint;
  name?: string;
  symbol?: string;
  mintAuthority: string | null;
  freezeAuthority: string | null;
  metadataUpdateAuthority?: string | null;
  metadataMutable?: boolean;
  /** Extensions Token-2022 détectées (noms lisibles). */
  extensions: string[];
  /** Extensions Token-2022 jugées dangereuses, avec explication. */
  dangerousExtensions: Array<{ name: string; detail: string; severity: Severity }>;
  /** Frais de transfert Token-2022 en points de base (si l'extension existe). */
  transferFeeBps?: number;
}

// ---------------------------------------------------------------------------
// Holders
// ---------------------------------------------------------------------------

export type HolderKind =
  | 'wallet'
  | 'bonding-curve'
  | 'liquidity-pool'
  | 'burn'
  | 'program'
  | 'creator';

export interface Holder {
  /** Propriétaire (wallet ou PDA) — les comptes d'un même propriétaire sont agrégés. */
  owner: string;
  tokenAccounts: string[];
  amount: bigint;
  /** Part de la supply totale en pourcentage (0-100). */
  pct: number;
  kind: HolderKind;
  /** Libellé lisible (ex : "PumpSwap", "Raydium AMM v4"). */
  label?: string;
}

export interface HoldersAnalysis {
  /** Top 20 agrégé par propriétaire, trié par solde décroissant. */
  top: Holder[];
  /** Holders "réels" : top 20 sans bonding curve / pools / burn. */
  wallets: Holder[];
  /** Somme des parts des 10 plus gros wallets (hors protocole). */
  top10Pct: number;
  /** Somme des parts des 20 plus gros wallets (hors protocole). */
  top20Pct: number;
  /** Part du plus gros wallet (hors protocole). */
  maxWalletPct: number;
  /** Part détenue par les comptes protocolaires (curve, pools) du top 20. */
  protocolPct: number;
  /** Part brûlée identifiée dans le top 20. */
  burnedPct: number;
  /** top20Pct rapporté à la supply circulante (hors protocole et burn). */
  top20CirculatingPct: number;
}

// ---------------------------------------------------------------------------
// Clustering
// ---------------------------------------------------------------------------

export interface WalletCluster {
  /** Wallets (propriétaires) appartenant au groupe. */
  owners: string[];
  /** Part moyenne détenue par chaque wallet du groupe (%). */
  avgPct: number;
  /** Écart maximal entre deux wallets du groupe (points de %). */
  spreadPct: number;
  /** Part cumulée du groupe (%). */
  totalPct: number;
  /** true si les soldes sont identiques à 0,1 % relatif près (clones stricts). */
  strictClone: boolean;
}

export interface ClusteringAnalysis {
  sampleSize: number;
  meanPct: number;
  variancePct: number;
  stdDevPct: number;
  /** Coefficient de variation σ/μ : proche de 0 = distribution uniforme. */
  coefficientOfVariation: number;
  /** Indice de Gini des soldes du top 20 (0 = parfaitement égal). */
  gini: number;
  clusters: WalletCluster[];
  /** Plus grand groupe détecté (null si aucun). */
  largestCluster: WalletCluster | null;
  /** Tolérance absolue utilisée (points de % de supply). */
  toleranceAbsPct: number;
}

// ---------------------------------------------------------------------------
// Dusting
// ---------------------------------------------------------------------------

export interface DustingAnalysis {
  /** Nombre de propriétaires distincts avec un solde > 0. */
  totalHolders: number;
  /** Propriétaires dont le solde < seuil de poussière. */
  dustHolders: number;
  /** Comptes de token vides (solde 0) encore ouverts. */
  emptyAccounts: number;
  /** dustHolders / totalHolders. */
  dustRatio: number;
  /** Holders "significatifs" (hors poussière). */
  effectiveHolders: number;
  /** Seuil de poussière en % de supply (0.001 par défaut). */
  dustThresholdPct: number;
  /** Seuil de poussière en unités brutes. */
  dustThresholdRaw: bigint;
}

// ---------------------------------------------------------------------------
// Réserve / liquidité
// ---------------------------------------------------------------------------

export interface BondingCurveState {
  address: string;
  virtualTokenReserves: bigint;
  virtualSolReserves: bigint;
  realTokenReserves: bigint;
  realSolReserves: bigint;
  tokenTotalSupply: bigint;
  complete: boolean;
  creator: string | null;
  /** Lamports réellement détenus par le compte (rent incluse). */
  lamports: bigint;
  /** Lamports disponibles une fois la rent exemption déduite. */
  backingLamports: bigint;
}

export interface PoolReserve {
  venue: string;
  address: string;
  tokenVault: string;
  solVault: string;
  tokenReserve: bigint;
  solReserveLamports: bigint;
}

export interface ReserveAnalysis {
  /** Type de marché principal. */
  marketType: 'bonding-curve' | 'amm-pool' | 'none';
  venue: string;
  bondingCurve?: BondingCurveState;
  /** Progression de la bonding curve Pump.fun (0-100). */
  bondingCurveProgressPct?: number;
  pools: PoolReserve[];
  /** SOL réellement détenus dans la réserve principale. */
  realReserveSol: number;
  /** SOL cumulés sur toutes les réserves trouvées. */
  totalReserveSol: number;
  /** Prix spot en SOL par token (unité UI). */
  priceSol: number;
  /** Capitalisation théorique (prix × supply totale) en SOL. */
  marketCapSol: number;
  /** realReserveSol / marketCapSol. */
  reserveToMcapRatio: number;
  /** Écart (%) entre les lamports réels et la réserve déclarée par la curve. */
  reserveDiscrepancyPct?: number;
  /** Recherches de pool qui ont échoué (RPC restrictif, timeout...). */
  searchErrors: string[];
}

// ---------------------------------------------------------------------------
// Créateur
// ---------------------------------------------------------------------------

export interface CreatorAnalysis {
  address: string;
  /** Méthode d'identification du créateur. */
  source: 'override' | 'pump.fun bonding curve' | 'mint creation tx' | 'mint authority';
  solBalance: number;
  /** Part de la supply du token analysé encore détenue par le créateur (%). */
  holdingPct: number;
  /** Mints créés dans la fenêtre inspectée (token analysé inclus). */
  createdMints: string[];
  /** Tokens créés précédemment (hors token analysé). */
  previousTokensCreated: number;
  /** Transactions inspectées. */
  txScanned: number;
  /** true si l'historique complet du wallet tient dans la fenêtre inspectée. */
  fullHistory: boolean;
  /** Nombre de signatures observées (borne basse si fullHistory = false). */
  signatureCount: number;
  /** Âge du wallet en jours (si l'historique complet est connu). */
  walletAgeDays?: number;
  /** Horodatage de la plus ancienne activité observée. */
  oldestActivity?: Date;
}

// ---------------------------------------------------------------------------
// Rapport
// ---------------------------------------------------------------------------

export interface ModuleScore {
  id: ModuleId;
  label: string;
  weight: number;
  /** Sous-score de dangerosité 0-100, null si le module est indisponible. */
  score: number | null;
  findings: Finding[];
  unavailableReason?: string;
}

export type RiskLevel = 'VERT' | 'ORANGE' | 'ROUGE';

export interface ScoreFloor {
  floor: number;
  reason: string;
}

export interface RiskScore {
  score: number;
  level: RiskLevel;
  /** Score pondéré avant application des planchers. */
  weightedScore: number;
  /** Part du poids total effectivement évaluée (0-1). */
  confidence: number;
  modules: ModuleScore[];
  floors: ScoreFloor[];
}

export interface ScanResult {
  mint: string;
  generatedAt: Date;
  durationMs: number;
  rpcEndpoint: string;
  /** Requêtes RPC émises pendant l'analyse (retries inclus). */
  rpcRequests: number;
  token: TokenInfo;
  holders: ModuleOutcome<HoldersAnalysis>;
  clustering: ModuleOutcome<ClusteringAnalysis>;
  dusting: ModuleOutcome<DustingAnalysis>;
  reserve: ModuleOutcome<ReserveAnalysis>;
  creator: ModuleOutcome<CreatorAnalysis>;
  risk: RiskScore;
}
