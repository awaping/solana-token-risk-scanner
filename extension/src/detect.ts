/**
 * Détection du token regardé, sur n'importe quel site.
 *
 * C'est ce qui rend l'extension « globale » : plutôt qu'un scraper par site —
 * fragile, à réparer à chaque refonte de Padre ou d'Axiom — on cherche une
 * adresse Solana valide, d'abord dans l'URL, puis dans la page.
 *
 * Trois niveaux, du plus fiable au moins fiable :
 *
 *   1. Motif d'URL connu  — `pump.fun/coin/<mint>` : l'adresse EST le mint,
 *      aucune ambiguïté.
 *   2. Adresse en suffixe `pump` — convention des mints Pump.fun, très sûre.
 *   3. Toute adresse base58 plausible trouvée dans l'URL puis dans la page.
 *
 * Attention aux adresses de PAIRE : DexScreener et Photon mettent dans l'URL
 * l'adresse de la pool, pas celle du mint. On ne devine pas — le niveau 1 les
 * marque comme telles et l'appelant décide quoi en faire.
 */

/** Alphabet base58 de Bitcoin/Solana : ni 0, ni O, ni I, ni l. */
const BASE58 = '[1-9A-HJ-NP-Za-km-z]';
const ADDRESS_RE = new RegExp(`${BASE58}{32,44}`, 'g');

export type AddressKind = 'mint' | 'pair' | 'unknown';

export interface Detection {
  address: string;
  kind: AddressKind;
  /** D'où vient l'adresse, pour le diagnostic. */
  source: string;
}

interface SitePattern {
  host: RegExp;
  /** Groupe 1 = adresse. */
  path: RegExp;
  kind: AddressKind;
  label: string;
}

/**
 * Motifs d'URL des principaux terminaux memecoin.
 *
 * Cette liste n'est qu'une OPTIMISATION : un site absent d'ici reste couvert
 * par la recherche générique. Elle sert à lever l'ambiguïté mint/paire là où
 * elle existe, pas à autoriser les sites.
 */
const SITES: SitePattern[] = [
  { host: /(^|\.)pump\.fun$/, path: new RegExp(`/(?:coin|board)/(${BASE58}{32,44})`), kind: 'mint', label: 'pump.fun' },
  { host: /(^|\.)padre\.gg$/, path: new RegExp(`/trade/solana/(${BASE58}{32,44})`), kind: 'mint', label: 'Padre' },
  { host: /(^|\.)axiom\.trade$/, path: new RegExp(`/(?:meme|t)/(${BASE58}{32,44})`), kind: 'mint', label: 'Axiom' },
  { host: /(^|\.)gmgn\.ai$/, path: new RegExp(`/sol/token/(?:[\\w-]+_)?(${BASE58}{32,44})`), kind: 'mint', label: 'GMGN' },
  { host: /(^|\.)birdeye\.so$/, path: new RegExp(`/token/(${BASE58}{32,44})`), kind: 'mint', label: 'Birdeye' },
  { host: /(^|\.)solscan\.io$/, path: new RegExp(`/token/(${BASE58}{32,44})`), kind: 'mint', label: 'Solscan' },
  { host: /(^|\.)bullx\.io$/, path: new RegExp(`[?&]address=(${BASE58}{32,44})`), kind: 'mint', label: 'BullX' },
  // Ces deux-là exposent la PAIRE, pas le mint : marqué comme tel.
  { host: /(^|\.)dexscreener\.com$/, path: new RegExp(`/solana/(${BASE58}{32,44})`), kind: 'pair', label: 'DexScreener' },
  { host: /(^|\.)tinyastro\.io$/, path: new RegExp(`/lp/(${BASE58}{32,44})`), kind: 'pair', label: 'Photon' },
];

/**
 * Adresses à ignorer : programmes et comptes système omniprésents dans les
 * pages, qui ne sont jamais le token regardé.
 */
const IGNORED = new Set([
  'So11111111111111111111111111111111111111112', // Wrapped SOL
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
  'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
  '11111111111111111111111111111111',
  'ComputeBudget111111111111111111111111111111',
  'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s',
  '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P', // programme Pump.fun
  'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA',
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
]);

const isPlausible = (address: string): boolean =>
  address.length >= 32 && address.length <= 44 && !IGNORED.has(address);

/** Toutes les adresses plausibles d'un texte, dans l'ordre d'apparition, dédupliquées. */
export function extractAddresses(text: string): string[] {
  const seen = new Set<string>();
  for (const match of text.matchAll(ADDRESS_RE)) {
    const value = match[0];
    if (isPlausible(value)) seen.add(value);
  }
  return [...seen];
}

/**
 * Détecte le token de la page.
 *
 * `pageText` est optionnel : sans lui, seule l'URL est inspectée (c'est ce que
 * fait l'appel initial, avant que la page ait fini de se peindre).
 */
export function detectToken(url: string, pageText?: string): Detection | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const hostname = parsed.hostname.toLowerCase();
  const target = `${parsed.pathname}${parsed.search}`;

  // 1. Motif de site connu : la seule source qui distingue mint et paire.
  for (const site of SITES) {
    if (!site.host.test(hostname)) continue;
    const found = site.path.exec(target)?.[1];
    if (found && isPlausible(found)) {
      return { address: found, kind: site.kind, source: site.label };
    }
  }

  // 2. Suffixe `pump` : convention des mints Pump.fun, dans l'URL puis la page.
  const fromUrl = extractAddresses(target);
  const pumpInUrl = fromUrl.find((a) => a.endsWith('pump'));
  if (pumpInUrl) return { address: pumpInUrl, kind: 'mint', source: 'URL (suffixe pump)' };

  // 3. Repli générique. L'URL prime sur la page : elle désigne ce que
  //    l'utilisateur regarde, alors qu'une page liste des dizaines de tokens.
  if (fromUrl[0]) return { address: fromUrl[0], kind: 'unknown', source: 'URL' };

  if (pageText) {
    const fromPage = extractAddresses(pageText);
    const pumpInPage = fromPage.find((a) => a.endsWith('pump'));
    if (pumpInPage) return { address: pumpInPage, kind: 'mint', source: 'page (suffixe pump)' };
    // Sans suffixe ni motif connu, une adresse isolée dans une page est trop
    // incertaine pour déclencher un scan : on s'abstient plutôt que d'afficher
    // le score d'un token que l'utilisateur ne regarde pas.
  }
  return null;
}
