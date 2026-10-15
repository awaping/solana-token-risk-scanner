/**
 * src/assets/image.ts
 * ---------------------------------------------------------------------------
 * Generation de l'image du token.
 *
 * REGLE ABSOLUE : cette fonction ne rate JAMAIS. Un token sans image se
 * deploie quand meme ; un token qui arrive 3 secondes trop tard ne vaut rien.
 * Le timeout Fal.ai est donc court et le repli local est instantane.
 *
 * `sync_mode: true` cote Fal.ai retourne l'image en data URI dans la reponse
 * plutot qu'une URL a telecharger ensuite. Cela supprime un aller-retour
 * complet - sur un budget de 1500 ms, c'est la difference entre tenir et ne
 * pas tenir.
 *
 * Le repli est un avatar SVG procedural derive du ticker : deterministe (le
 * meme ticker donne toujours la meme image), genere en moins d'une
 * milliseconde, sans dependance ni reseau. Ce n'est pas joli, c'est
 * disponible.
 * ---------------------------------------------------------------------------
 */

import { createHash } from 'node:crypto';
import type { Logger } from 'pino';

import type { AssetsConfig } from '../core/config.ts';

export interface GeneratedImage {
  data: Buffer;
  contentType: string;
  fileName: string;
  source: 'fal' | 'fallback';
  latencyMs: number;
}

/** Plafond de taille. Au-dela, l'upload devient le goulot d'etranglement. */
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Repli procedural
// ---------------------------------------------------------------------------

/**
 * Avatar SVG deterministe derive du ticker.
 *
 * ponytail: SVG plutot que PNG. Encoder un PNG sans dependance demanderait
 * d'ecrire un encodeur deflate ; le SVG est une chaine de caracteres. Si un
 * consommateur refuse le SVG, la bonne reponse est d'ajouter `sharp` et de
 * rasteriser, pas de complexifier ce fichier.
 */
export function proceduralAvatar(symbol: string): Buffer {
  const hash = createHash('sha256').update(symbol).digest();
  const hue = (hash[0] as number) * 360 / 256;
  const hue2 = (hue + 40 + ((hash[1] as number) % 120)) % 360;
  const rings = 3 + ((hash[2] as number) % 3);

  const circles = Array.from({ length: rings }, (_, i) => {
    const byte = hash[3 + i] as number;
    const cx = 128 + (((byte % 64) - 32) * 1.5);
    const cy = 128 + ((((byte >> 3) % 64) - 32) * 1.5);
    const r = 30 + (byte % 55);
    const opacity = (0.18 + ((byte % 5) * 0.08)).toFixed(2);
    return `<circle cx="${cx.toFixed(0)}" cy="${cy.toFixed(0)}" r="${r}" fill="#fff" opacity="${opacity}"/>`;
  }).join('');

  // Le ticker est deja normalise en [A-Z0-9]{2,10} par l'analyzer, mais on
  // echappe malgre tout : cette chaine finit dans un document XML.
  const label = symbol.replace(/[^A-Z0-9]/g, '').slice(0, 10);
  const fontSize = label.length > 6 ? 40 : 56;

  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256">` +
    `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">` +
    `<stop offset="0%" stop-color="hsl(${hue.toFixed(0)},85%,58%)"/>` +
    `<stop offset="100%" stop-color="hsl(${hue2.toFixed(0)},85%,42%)"/>` +
    `</linearGradient></defs>` +
    `<rect width="256" height="256" fill="url(#g)"/>${circles}` +
    `<text x="128" y="128" text-anchor="middle" dominant-baseline="central" ` +
    `font-family="Arial,Helvetica,sans-serif" font-weight="bold" font-size="${fontSize}" ` +
    `fill="#fff" stroke="#000" stroke-width="2" paint-order="stroke">${label}</text></svg>`;

  return Buffer.from(svg, 'utf8');
}

function fallbackImage(symbol: string, startedAt: number): GeneratedImage {
  return {
    data: proceduralAvatar(symbol),
    contentType: 'image/svg+xml',
    fileName: `${symbol.toLowerCase()}.svg`,
    source: 'fallback',
    latencyMs: Date.now() - startedAt,
  };
}

// ---------------------------------------------------------------------------
// Fal.ai
// ---------------------------------------------------------------------------

/** `data:image/png;base64,....` -> Buffer + content type. */
function decodeDataUri(uri: string): { data: Buffer; contentType: string } | null {
  const m = /^data:([^;,]+);base64,(.+)$/s.exec(uri);
  if (!m) return null;
  const contentType = m[1] as string;
  if (!contentType.startsWith('image/')) return null;
  return { data: Buffer.from(m[2] as string, 'base64'), contentType };
}

/**
 * Genere l'image. Retourne toujours quelque chose.
 *
 * Aucune tentative de retry : le budget total est de `falTimeoutMs`, un second
 * essai le depasserait mecaniquement. Rater l'image coute une image moche ;
 * rater le slot coute le lancement.
 */
export async function generateImage(
  imagePrompt: string,
  symbol: string,
  cfg: AssetsConfig,
  logger: Logger,
): Promise<GeneratedImage> {
  const log = logger.child({ module: 'assets:image' });
  const startedAt = Date.now();

  if (!cfg.falKey) {
    log.debug('no FAL_KEY configured, using the procedural avatar');
    return fallbackImage(symbol, startedAt);
  }

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), cfg.falTimeoutMs);
  try {
    const res = await fetch(`https://fal.run/${cfg.falModel}`, {
      method: 'POST',
      signal: ac.signal,
      headers: {
        'content-type': 'application/json',
        authorization: `Key ${cfg.falKey}`,
      },
      body: JSON.stringify({
        prompt: imagePrompt,
        image_size: 'square',
        num_inference_steps: 4,
        num_images: 1,
        // Renvoie un data URI au lieu d'une URL hebergee : un aller-retour
        // de moins sur le chemin critique.
        sync_mode: true,
        enable_safety_checker: true,
      }),
    });

    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).slice(0, 200);
      throw new Error(`fal HTTP ${res.status}: ${detail}`);
    }

    const json = (await res.json()) as { images?: Array<{ url?: string; content_type?: string }> };
    const url = json.images?.[0]?.url;
    if (!url) throw new Error('fal returned no image');

    const decoded = decodeDataUri(url);
    if (!decoded) throw new Error('fal did not return a data URI (sync_mode ignored?)');
    if (decoded.data.length > MAX_IMAGE_BYTES) {
      throw new Error(`fal image is ${decoded.data.length} bytes, over the ${MAX_IMAGE_BYTES} cap`);
    }

    const ext = decoded.contentType.split('/')[1] ?? 'png';
    const latencyMs = Date.now() - startedAt;
    log.info({ latencyMs, bytes: decoded.data.length, contentType: decoded.contentType }, 'fal image ready');
    return {
      data: decoded.data,
      contentType: decoded.contentType,
      fileName: `${symbol.toLowerCase()}.${ext}`,
      source: 'fal',
      latencyMs,
    };
  } catch (err) {
    const latencyMs = Date.now() - startedAt;
    log.warn(
      { err, latencyMs, timeoutMs: cfg.falTimeoutMs, aborted: ac.signal.aborted },
      'fal image generation failed, falling back to the procedural avatar',
    );
    return fallbackImage(symbol, startedAt);
  } finally {
    clearTimeout(timer);
  }
}
