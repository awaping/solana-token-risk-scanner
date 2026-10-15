/**
 * Classification des pannes RPC, sans aucune dépendance à l'API chrome.
 *
 * Séparé de background.ts parce que ce dernier enregistre ses écouteurs de
 * messages au chargement : l'importer depuis un test exigerait de simuler
 * tout l'environnement d'extension pour tester trois fonctions pures.
 */


/** Endpoints publics connus pour refuser les requêtes d'origine navigateur. */
const BROWSER_HOSTILE = [/(^|\.)api\.(mainnet-beta|devnet|testnet)\.solana\.com$/];

export function isBrowserHostile(url: string): boolean {
  try {
    return BROWSER_HOSTILE.some((pattern) => pattern.test(new URL(url).hostname));
  } catch {
    return false;
  }
}

/** Erreur dont le message est destiné à l'utilisateur, avec action associée. */
export class ConfigError extends Error {
  readonly action = 'options' as const;
}

/**
 * Traduit une panne RPC en phrase actionnable.
 *
 * Un « 403 : {"jsonrpc":"2.0","error":…} » brut n'apprend rien : il faut dire
 * que c'est l'endpoint qui refuse, et quoi faire.
 */
export function explainRpcError(error: unknown, rpcUrl: string): Error {
  const message = error instanceof Error ? error.message : String(error);
  const host = (() => {
    try {
      return new URL(rpcUrl).hostname;
    } catch {
      return rpcUrl;
    }
  })();

  if (/\b403\b|forbidden/i.test(message)) {
    return new ConfigError(
      isBrowserHostile(rpcUrl)
        ? `${host} refuse les requêtes venant d'un navigateur (403). Cet endpoint public ne fonctionne que depuis un serveur — configure un RPC privé (Helius, Triton, QuickNode).`
        : `${host} a refusé la requête (403). Vérifie que ta clé d'API est valide et qu'elle autorise les origines navigateur.`,
    );
  }
  if (/\b401\b|unauthorized/i.test(message)) {
    return new ConfigError(`${host} : clé d'API invalide ou absente (401).`);
  }
  if (/\b429\b|rate.?limit|too many/i.test(message)) {
    return new Error(`${host} limite le débit (429). Réessaie, ou passe sur un RPC moins sollicité.`);
  }
  if (/failed to fetch|networkerror|load failed/i.test(message)) {
    return new Error(`${host} injoignable. Vérifie l'URL et ta connexion.`);
  }
  return error instanceof Error ? error : new Error(message);
}
