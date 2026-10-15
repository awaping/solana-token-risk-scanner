/**
 * src/assets/upload.ts
 * ---------------------------------------------------------------------------
 * Publication de l'image et du document de metadonnees.
 *
 * DEUX CHEMINS, dans cet ordre :
 *
 *   1. FAST PATH - POST multipart vers l'API interne de Pump.fun.
 *      Un seul appel envoie l'image ET les champs de metadonnees, et retourne
 *      directement le `metadataUri`. ~300 ms. C'est le chemin par defaut parce
 *      que c'est le seul qui tient dans le budget de latence d'un snipe.
 *
 *      Contrepartie assumee : c'est une API interne, non documentee et non
 *      versionnee. Elle peut changer de forme sans preavis - d'ou le repli.
 *
 *   2. FALLBACK - Irys / Arweave.
 *      Deux uploads sequentiels (l'URI de l'image doit exister avant d'ecrire
 *      le JSON qui la reference), donc nettement plus lent, et payant. Mais
 *      permanent et sous notre controle.
 *
 * Le chargement du SDK Irys est fait a la demande (`import()` dynamique) : il
 * tire une dependance lourde, inutile a charger au demarrage sur le chemin
 * nominal.
 * ---------------------------------------------------------------------------
 */

import type { Logger } from 'pino';

import type { AssetsConfig } from '../core/config.ts';
import type { GeneratedImage } from './image.ts';
import { type MetadataInput, buildMetadata } from './metadata.ts';

export interface UploadResult {
  /** URI du document JSON, passe tel quel a l'instruction `create`. */
  metadataUri: string;
  imageUri: string;
  source: 'pump-ipfs' | 'irys';
  latencyMs: number;
}

/** Bornes Metaplex : l'URI part on-chain, elle doit tenir en 200 octets. */
const MAX_URI_BYTES = 200;

function assertUriFits(uri: string): void {
  const len = Buffer.byteLength(uri, 'utf8');
  if (len > MAX_URI_BYTES) {
    throw new Error(`metadata URI is ${len} bytes, Metaplex allows ${MAX_URI_BYTES}: ${uri}`);
  }
}

// ---------------------------------------------------------------------------
// Fast path : pump.fun
// ---------------------------------------------------------------------------

async function uploadViaPumpIpfs(
  image: GeneratedImage,
  input: MetadataInput,
  cfg: AssetsConfig,
  log: Logger,
): Promise<UploadResult> {
  const startedAt = Date.now();

  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(image.data)], { type: image.contentType }), image.fileName);
  form.append('name', input.name);
  form.append('symbol', input.symbol);
  form.append('description', input.description);
  form.append('twitter', input.twitter ?? '');
  form.append('telegram', input.telegram ?? '');
  form.append('website', input.website ?? '');
  form.append('showName', 'true');

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), cfg.pumpIpfsTimeoutMs);
  try {
    // Pas de content-type explicite : fetch doit poser lui-meme le boundary
    // multipart. Le forcer a la main casse silencieusement le parsing serveur.
    const res = await fetch(cfg.pumpIpfsUrl, { method: 'POST', body: form, signal: ac.signal });
    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).slice(0, 200);
      throw new Error(`pump ipfs HTTP ${res.status}: ${detail}`);
    }

    const json = (await res.json()) as {
      metadataUri?: string;
      metadata?: { image?: string };
    };
    if (!json.metadataUri) throw new Error('pump ipfs returned no metadataUri');
    assertUriFits(json.metadataUri);

    const latencyMs = Date.now() - startedAt;
    log.info({ latencyMs, metadataUri: json.metadataUri }, 'metadata uploaded via pump.fun fast path');
    return {
      metadataUri: json.metadataUri,
      imageUri: json.metadata?.image ?? '',
      source: 'pump-ipfs',
      latencyMs,
    };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Fallback : Irys / Arweave
// ---------------------------------------------------------------------------

async function uploadViaIrys(
  image: GeneratedImage,
  input: MetadataInput,
  cfg: AssetsConfig,
  log: Logger,
): Promise<UploadResult> {
  if (!cfg.irysPrivateKey) throw new Error('IRYS_PRIVATE_KEY is not set, no fallback available');
  const startedAt = Date.now();

  // Import dynamique : le SDK Irys est lourd et inutile sur le chemin nominal.
  const { Uploader } = await import('@irys/upload');
  const { Solana } = await import('@irys/upload-solana');
  const uploader = await Uploader(Solana).withWallet(cfg.irysPrivateKey).withRpc(cfg.irysRpcUrl);

  // Sequentiel par necessite : le JSON reference l'URI de l'image, elle doit
  // donc exister avant d'ecrire le JSON.
  const imageReceipt = await uploader.upload(image.data, {
    tags: [{ name: 'Content-Type', value: image.contentType }],
  });
  const imageUri = `https://gateway.irys.xyz/${imageReceipt.id}`;

  const document = buildMetadata({ ...input, image: imageUri });
  const jsonReceipt = await uploader.upload(Buffer.from(JSON.stringify(document), 'utf8'), {
    tags: [{ name: 'Content-Type', value: 'application/json' }],
  });
  const metadataUri = `https://gateway.irys.xyz/${jsonReceipt.id}`;
  assertUriFits(metadataUri);

  const latencyMs = Date.now() - startedAt;
  log.info({ latencyMs, metadataUri, imageUri }, 'metadata uploaded via Irys fallback');
  return { metadataUri, imageUri, source: 'irys', latencyMs };
}

// ---------------------------------------------------------------------------

/**
 * Publie image + metadonnees et retourne l'URI a mettre on-chain.
 *
 * Contrairement a `generateImage`, cette fonction PEUT echouer : sans URI, il
 * n'y a pas de token a creer. Un echec des deux chemins annule le lancement,
 * ce qui est la bonne issue - mieux vaut ne pas deployer que deployer un token
 * dont les metadonnees pointent dans le vide.
 */
export async function uploadAssets(
  image: GeneratedImage,
  input: MetadataInput,
  cfg: AssetsConfig,
  logger: Logger,
): Promise<UploadResult> {
  const log = logger.child({ module: 'assets:upload' });
  try {
    return await uploadViaPumpIpfs(image, input, cfg, log);
  } catch (err) {
    log.warn({ err }, 'pump.fun fast path failed, trying Irys');
    try {
      return await uploadViaIrys(image, input, cfg, log);
    } catch (fallbackErr) {
      log.error({ err, fallbackErr }, 'every upload path failed - launch aborted');
      throw new Error(
        `asset upload failed on both paths: pump="${err instanceof Error ? err.message : err}" ` +
          `irys="${fallbackErr instanceof Error ? fallbackErr.message : fallbackErr}"`,
      );
    }
  }
}
