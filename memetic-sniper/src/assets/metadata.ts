/**
 * src/assets/metadata.ts
 * ---------------------------------------------------------------------------
 * Document de metadonnees hors chaine, au format attendu par Pump.fun et lu
 * par les explorateurs et les wallets.
 *
 * Le champ `createdOn: "https://pump.fun"` n'est pas decoratif : c'est lui que
 * l'interface de pump.fun utilise pour reconnaitre un token comme etant des
 * siens. Un token cree par le programme mais sans ce marqueur s'affiche de
 * facon degradee.
 *
 * `name` et `symbol` sont re-verifies ici contre les bornes Metaplex bien
 * qu'ils l'aient deja ete dans l'analyzer. C'est volontaire : les deux modules
 * sont a des bouts opposes du pipeline, et cette redondance coute zero tandis
 * qu'une metadonnee hors bornes fait echouer `create` on-chain.
 * ---------------------------------------------------------------------------
 */

export interface TokenMetadataDocument {
  name: string;
  symbol: string;
  description: string;
  image: string;
  showName: true;
  createdOn: 'https://pump.fun';
  twitter?: string;
  telegram?: string;
  website?: string;
}

export interface MetadataInput {
  name: string;
  symbol: string;
  description: string;
  /** URI de l'image deja uploadee. Vide au moment du fast path pump.fun. */
  image?: string;
  /** Lien vers le tweet a l'origine du lancement. */
  twitter?: string;
  telegram?: string;
  website?: string;
}

const LIMITS = { name: 32, symbol: 10, description: 500 } as const;

function assertWithinLimits(field: keyof typeof LIMITS, value: string): void {
  const len = Buffer.byteLength(value, 'utf8');
  if (len === 0) throw new Error(`metadata.${field} is empty`);
  if (len > LIMITS[field]) {
    throw new Error(`metadata.${field} is ${len} bytes, limit is ${LIMITS[field]}`);
  }
}

export function buildMetadata(input: MetadataInput): TokenMetadataDocument {
  assertWithinLimits('name', input.name);
  assertWithinLimits('symbol', input.symbol);
  assertWithinLimits('description', input.description);

  return {
    name: input.name,
    symbol: input.symbol,
    description: input.description,
    image: input.image ?? '',
    showName: true,
    createdOn: 'https://pump.fun',
    ...(input.twitter ? { twitter: input.twitter } : {}),
    ...(input.telegram ? { telegram: input.telegram } : {}),
    ...(input.website ? { website: input.website } : {}),
  };
}

/** URL canonique d'un tweet, a partir du handle et de l'id. */
export function tweetUrl(authorHandle: string, tweetId: string): string {
  return `https://x.com/${authorHandle}/status/${tweetId}`;
}
