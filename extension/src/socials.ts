/**
 * Réseaux sociaux d'un token, lus dans son fichier de métadonnées (le JSON
 * pointé par l'URI on-chain : pump.fun y met `twitter`, `telegram`, `website`).
 *
 * Purement informatif : n'entre pas dans la note. Le contenu est choisi par le
 * créateur du token, donc non fiable : seuls des liens http(s) sont gardés, le
 * lien X est reconstruit à partir du pseudo, et rien n'est interprété comme du
 * HTML. Module pur, testable sans navigateur.
 */

export interface TwitterLink {
  /** Pseudo sans @, si le lien en contient un. */
  handle?: string;
  url: string;
  kind: 'profile' | 'tweet' | 'community' | 'link';
}

export interface Socials {
  twitter?: TwitterLink;
  telegram?: string;
  website?: string;
  description?: string;
}

/** Infos sur le dev affichées dans le panneau. */
export interface DevInfo {
  address: string;
  /** Pseudo pump.fun, s'il a pu être lu (service non officiel, au mieux). */
  username?: string;
}

const MAX_URL = 300;
const HANDLE = /^[A-Za-z0-9_]{1,15}$/;
/** Chemins de x.com qui ne sont pas des comptes. */
const RESERVED = new Set(['i', 'home', 'search', 'intent', 'share', 'hashtag', 'explore', 'messages', 'notifications', 'settings']);

/** Lien http(s) valide et de taille raisonnable, sinon undefined. */
export function safeUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  if (!text || text.length > MAX_URL) return undefined;
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(text) ? text : `https://${text}`);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

/** URI de métadonnées → URL téléchargeable (IPFS et Arweave via passerelle publique). */
export function resolveMetadataUri(uri: string | undefined): string | undefined {
  if (!uri) return undefined;
  const text = uri.trim();
  if (/^ipfs:\/\//i.test(text)) return safeUrl(`https://ipfs.io/ipfs/${text.replace(/^ipfs:\/\/(ipfs\/)?/i, '')}`);
  if (/^ar:\/\//i.test(text)) return safeUrl(`https://arweave.net/${text.slice(5)}`);
  return /^https?:\/\//i.test(text) ? safeUrl(text) : undefined;
}

/** Interprète la valeur `twitter` : pseudo, profil, tweet ou communauté X. */
export function parseTwitter(value: unknown): TwitterLink | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const text = value.trim();
  const bare = text.replace(/^@/, '');
  if (HANDLE.test(bare)) return { handle: bare, url: `https://x.com/${bare}`, kind: 'profile' };

  const url = safeUrl(text);
  if (!url) return undefined;
  const parsed = new URL(url);
  const host = parsed.hostname.replace(/^(www\.|mobile\.)/, '');
  if (host !== 'x.com' && host !== 'twitter.com') return { url, kind: 'link' };

  const [first, second] = parsed.pathname.split('/').filter(Boolean);
  if (first === 'i' && second === 'communities') return { url, kind: 'community' };
  if (!first || RESERVED.has(first.toLowerCase()) || !HANDLE.test(first)) return { url, kind: 'link' };
  if (second === 'status') return { handle: first, url, kind: 'tweet' };
  return { handle: first, url: `https://x.com/${first}`, kind: 'profile' };
}

/** Extrait les réseaux sociaux d'un JSON de métadonnées (format pump.fun ou Metaplex `extensions`). */
export function extractSocials(json: unknown): Socials {
  if (!json || typeof json !== 'object') return {};
  const root = json as Record<string, unknown>;
  const ext = root.extensions && typeof root.extensions === 'object' ? (root.extensions as Record<string, unknown>) : {};
  const pick = (key: string) => root[key] ?? ext[key];

  const twitter = parseTwitter(pick('twitter') ?? pick('x'));
  const telegramRaw = pick('telegram');
  const telegram = safeUrl(typeof telegramRaw === 'string' && !/[./]/.test(telegramRaw.trim()) ? `https://t.me/${telegramRaw.trim().replace(/^@/, '')}` : telegramRaw);
  const website = safeUrl(pick('website'));
  const description = typeof root.description === 'string' ? root.description.trim().slice(0, 280) : undefined;
  return {
    ...(twitter ? { twitter } : {}),
    ...(telegram ? { telegram } : {}),
    ...(website ? { website } : {}),
    ...(description ? { description } : {}),
  };
}

/** Libellé court d'un lien X pour le panneau. */
export function twitterLabel(link: TwitterLink): string {
  if (link.kind === 'community') return 'communauté X';
  if (link.kind === 'tweet') return `tweet de @${link.handle}`;
  if (link.kind === 'profile') return `@${link.handle}`;
  return 'lien X';
}

/** Pseudo pump.fun lu dans la réponse de son service de profils (non officiel : au mieux). */
export function pumpUsername(json: unknown): string | undefined {
  if (!json || typeof json !== 'object') return undefined;
  const username = (json as Record<string, unknown>).username;
  return typeof username === 'string' && /^[\w.-]{1,32}$/.test(username) ? username : undefined;
}

/** Identifiant de contenu IPFS (CIDv0 « Qm… » ou CIDv1 « baf… »). */
const CID = /^(Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{50,})$/;

/**
 * Même fichier via la passerelle IPFS publique, quand l'hébergeur d'origine est
 * une passerelle IPFS (chemin /ipfs/<cid> ou sous-domaine <cid>.ipfs.…) : elle
 * est autorisée par l'extension et sert le contenu à l'identique.
 */
export function ipfsFallback(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    if (parsed.hostname === 'ipfs.io') return undefined;
    const [sub] = parsed.hostname.split('.');
    if (sub && CID.test(sub) && parsed.hostname.includes('.ipfs.')) return `https://ipfs.io/ipfs/${sub}${parsed.pathname === '/' ? '' : parsed.pathname}`;
    const match = /\/ipfs\/([^/?#]+)(\/[^?#]*)?/.exec(parsed.pathname);
    if (match && CID.test(match[1]!)) return `https://ipfs.io/ipfs/${match[1]}${match[2] ?? ''}`;
  } catch {
    // URL illisible
  }
  return undefined;
}

/** Adresses à essayer pour lire les métadonnées : l'originale, puis la passerelle IPFS publique. */
export function metadataCandidates(uri: string | undefined): string[] {
  const primary = resolveMetadataUri(uri);
  if (!primary) return [];
  const fallback = ipfsFallback(primary);
  return fallback && fallback !== primary ? [primary, fallback] : [primary];
}
