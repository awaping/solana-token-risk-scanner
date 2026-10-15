/**
 * src/listener/normalize.ts
 * ---------------------------------------------------------------------------
 * Frontiere de confiance du bot.
 *
 * Tout ce qui entre ici vient d'un tiers - API Twitter ou relais WebSocket
 * externe - et finit par declencher une depense on-chain. Rien n'est suppose :
 * chaque payload est valide par un schema avant d'etre converti en
 * `TweetSignal`, et un payload qui ne colle pas est rejete, jamais "reparé".
 *
 * Les deux formats supportes :
 *   - Twitter API v2 : `{ data: {...}, includes: { media: [...], users: [...] } }`
 *   - Relais generique : objet plat, conventions variables selon le
 *     fournisseur, d'ou un schema tolerant sur les noms de champs.
 * ---------------------------------------------------------------------------
 */

import { z } from 'zod';

import type { TweetSignal } from '../agent/analyzer.ts';

// ---------------------------------------------------------------------------
// Twitter API v2
// ---------------------------------------------------------------------------

const TwitterV2Schema = z.object({
  data: z.object({
    id: z.string().min(1),
    text: z.string(),
    author_id: z.string().min(1).optional(),
    created_at: z.string().optional(),
    referenced_tweets: z
      .array(z.object({ type: z.enum(['retweeted', 'quoted', 'replied_to']), id: z.string() }))
      .optional(),
    attachments: z.object({ media_keys: z.array(z.string()).optional() }).optional(),
  }),
  includes: z
    .object({
      media: z
        .array(
          z.object({
            media_key: z.string(),
            type: z.string(),
            url: z.string().optional(),
            preview_image_url: z.string().optional(),
          }),
        )
        .optional(),
      users: z.array(z.object({ id: z.string(), username: z.string() })).optional(),
    })
    .optional(),
});

// ---------------------------------------------------------------------------
// Relais generique
// ---------------------------------------------------------------------------

const RelaySchema = z.object({
  // Les relais n'ont aucune convention commune sur le nom de l'identifiant.
  id: z.union([z.string(), z.number()]).optional(),
  tweet_id: z.union([z.string(), z.number()]).optional(),
  tweetId: z.union([z.string(), z.number()]).optional(),

  text: z.string().optional(),
  full_text: z.string().optional(),
  content: z.string().optional(),

  author_id: z.union([z.string(), z.number()]).optional(),
  authorId: z.union([z.string(), z.number()]).optional(),
  user_id: z.union([z.string(), z.number()]).optional(),

  username: z.string().optional(),
  handle: z.string().optional(),
  screen_name: z.string().optional(),

  created_at: z.union([z.string(), z.number()]).optional(),
  timestamp: z.union([z.string(), z.number()]).optional(),

  media: z.array(z.union([z.string(), z.object({ url: z.string().optional() })])).optional(),
  images: z.array(z.string()).optional(),
  photos: z.array(z.string()).optional(),

  is_retweet: z.boolean().optional(),
  isRetweet: z.boolean().optional(),
  is_reply: z.boolean().optional(),
  isReply: z.boolean().optional(),
  in_reply_to_status_id: z.union([z.string(), z.number(), z.null()]).optional(),
});

// ---------------------------------------------------------------------------

const first = <T>(...values: Array<T | undefined | null>): T | undefined =>
  values.find((v) => v !== undefined && v !== null) as T | undefined;

/**
 * Convertit un horodatage heterogene en epoch ms.
 * Un nombre a 10 chiffres est une date en SECONDES : la convertir comme des
 * millisecondes la placerait en 1970 et le tweet serait juge perime.
 */
function toEpochMs(value: string | number | undefined): number {
  if (value === undefined) return Date.now();
  if (typeof value === 'number') return value < 1e12 ? value * 1000 : value;
  const asNumber = Number(value);
  if (Number.isFinite(asNumber) && value.trim() !== '') {
    return asNumber < 1e12 ? asNumber * 1000 : asNumber;
  }
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? Date.now() : parsed;
}

/** Ne garde que les URLs http(s) : un media local ou un data URI n'a rien a faire ici. */
function cleanImageUrls(urls: Array<string | undefined>): string[] {
  return urls.filter((u): u is string => typeof u === 'string' && /^https?:\/\//.test(u));
}

export interface NormalizeOptions {
  /** Si fourni, un auteur hors liste fait rejeter le payload. */
  whitelistUserIds?: string[];
}

/**
 * Normalise un payload brut. Retourne `null` si inexploitable - jamais
 * d'exception : un relais qui envoie un keepalive ou un message de controle ne
 * doit pas faire tomber le listener.
 */
export function normalizeTweet(payload: unknown, opts: NormalizeOptions = {}): TweetSignal | null {
  const signal = normalizeTwitterV2(payload) ?? normalizeRelay(payload);
  if (!signal) return null;

  if (opts.whitelistUserIds && opts.whitelistUserIds.length > 0) {
    // Filtre par ID numerique, jamais par handle : un handle abandonne peut
    // etre re-enregistre par un tiers, l'ID ne change jamais.
    if (!opts.whitelistUserIds.includes(signal.authorId)) return null;
  }
  return signal;
}

function normalizeTwitterV2(payload: unknown): TweetSignal | null {
  const parsed = TwitterV2Schema.safeParse(payload);
  if (!parsed.success) return null;
  const { data, includes } = parsed.data;

  const refs = data.referenced_tweets ?? [];
  const mediaByKey = new Map((includes?.media ?? []).map((m) => [m.media_key, m]));
  const imageUrls = cleanImageUrls(
    (data.attachments?.media_keys ?? []).map((key) => {
      const media = mediaByKey.get(key);
      if (!media) return undefined;
      // Les videos n'ont pas d'`url` ; leur vignette fait l'affaire.
      return media.type === 'photo' ? media.url : media.preview_image_url;
    }),
  );

  const authorId = data.author_id ?? '';
  const handle = includes?.users?.find((u) => u.id === authorId)?.username ?? 'unknown';

  return {
    id: data.id,
    authorId,
    authorHandle: handle,
    text: data.text,
    imageUrls,
    createdAt: toEpochMs(data.created_at),
    isRetweet: refs.some((r) => r.type === 'retweeted'),
    isReply: refs.some((r) => r.type === 'replied_to'),
  };
}

function normalizeRelay(payload: unknown): TweetSignal | null {
  const parsed = RelaySchema.safeParse(payload);
  if (!parsed.success) return null;
  const p = parsed.data;

  const rawId = first(p.id, p.tweet_id, p.tweetId);
  const text = first(p.text, p.full_text, p.content);
  if (rawId === undefined || text === undefined) return null;

  const rawAuthor = first(p.author_id, p.authorId, p.user_id);
  const media = (p.media ?? []).map((m) => (typeof m === 'string' ? m : m.url));

  return {
    id: String(rawId),
    authorId: rawAuthor === undefined ? '' : String(rawAuthor),
    authorHandle: first(p.username, p.handle, p.screen_name) ?? 'unknown',
    text,
    imageUrls: cleanImageUrls([...media, ...(p.images ?? []), ...(p.photos ?? [])]),
    createdAt: toEpochMs(first(p.created_at, p.timestamp)),
    isRetweet: first(p.is_retweet, p.isRetweet) ?? false,
    isReply:
      first(p.is_reply, p.isReply) ??
      (p.in_reply_to_status_id !== undefined && p.in_reply_to_status_id !== null),
  };
}
