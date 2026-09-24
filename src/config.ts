/**
 * Configuration d'exécution : variables d'environnement (.env) + options CLI.
 */

export interface ScannerConfig {
  /** URL de l'endpoint RPC Solana. */
  rpcUrl: string;
  /** Requêtes RPC simultanées maximum. */
  concurrency: number;
  /** Tentatives en cas d'erreur transitoire (429, timeout, 5xx). */
  maxRetries: number;
  /** Transactions récentes du créateur inspectées. */
  creatorTxScanLimit: number;
  /** Pages de 1000 signatures parcourues pour retrouver la création du mint. */
  mintHistoryMaxPages: number;
  /** Active le recensement complet des holders (getProgramAccounts). */
  holderCensus: boolean;
  /** Adresse du créateur forcée par l'utilisateur (sinon auto-détectée). */
  creatorOverride?: string;
}

export const DEFAULT_RPC_URL = 'https://api.mainnet-beta.solana.com';

/** Charge le fichier .env s'il existe (API native Node >= 20.12). */
export function loadDotEnv(path = '.env'): void {
  try {
    process.loadEnvFile(path);
  } catch {
    // Pas de fichier .env : on se contente des variables déjà définies.
  }
}

function intFromEnv(name: string, fallback: number, min = 1): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value < min) {
    throw new Error(`Variable d'environnement ${name} invalide : "${raw}" (entier >= ${min} attendu)`);
  }
  return value;
}

function boolFromEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (raw === undefined || raw === '') return fallback;
  return !['0', 'false', 'no', 'off', 'non'].includes(raw);
}

/** Construit la configuration à partir des variables d'environnement. */
export function configFromEnv(): ScannerConfig {
  return {
    rpcUrl: process.env.SOLANA_RPC_URL?.trim() || DEFAULT_RPC_URL,
    concurrency: intFromEnv('RPC_CONCURRENCY', 4),
    maxRetries: intFromEnv('RPC_MAX_RETRIES', 5, 0),
    creatorTxScanLimit: intFromEnv('CREATOR_TX_SCAN_LIMIT', 100, 0),
    mintHistoryMaxPages: intFromEnv('MINT_HISTORY_MAX_PAGES', 5, 0),
    holderCensus: boolFromEnv('HOLDER_CENSUS', true),
  };
}

/** Masque la clé d'API éventuellement présente dans l'URL RPC avant affichage. */
export function maskRpcUrl(url: string): string {
  try {
    const parsed = new URL(url);
    for (const key of [...parsed.searchParams.keys()]) {
      parsed.searchParams.set(key, '***');
    }
    if (parsed.username || parsed.password) {
      parsed.username = '***';
      parsed.password = '';
    }
    // Certains fournisseurs placent la clé dans le chemin (/v2/<clé>).
    parsed.pathname = parsed.pathname.replace(/[A-Za-z0-9_-]{24,}/g, '***');
    return parsed.toString().replace(/%2A/g, '*');
  } catch {
    return url;
  }
}
