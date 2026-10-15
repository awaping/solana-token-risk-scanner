/**
 * src/assets/index.ts
 * ---------------------------------------------------------------------------
 * Chaine complete de preparation des assets : image puis publication.
 *
 * Sequentiel par necessite, pas par negligence : l'upload a besoin des octets
 * de l'image. Le seul parallelisme utile a ete deplace en amont, dans
 * l'orchestrateur, qui prepare le blockhash et le mint pendant que cette
 * chaine tourne.
 * ---------------------------------------------------------------------------
 */

import type { Logger } from 'pino';

import type { Analysis } from '../agent/analyzer.ts';
import type { AssetsConfig } from '../core/config.ts';
import { type GeneratedImage, generateImage } from './image.ts';
import { tweetUrl } from './metadata.ts';
import { type UploadResult, uploadAssets } from './upload.ts';

export * from './image.ts';
export * from './metadata.ts';
export * from './upload.ts';

export interface PreparedAssets {
  metadataUri: string;
  imageUri: string;
  image: GeneratedImage;
  upload: UploadResult;
  totalLatencyMs: number;
}

export async function prepareAssets(
  analysis: Analysis,
  tweet: { id: string; authorHandle: string },
  cfg: AssetsConfig,
  logger: Logger,
): Promise<PreparedAssets> {
  const startedAt = Date.now();

  const image = await generateImage(analysis.imagePrompt, analysis.symbol, cfg, logger);
  const upload = await uploadAssets(
    image,
    {
      name: analysis.name,
      symbol: analysis.symbol,
      description: analysis.description,
      // Tracabilite : le token pointe vers le tweet qui l'a declenche.
      twitter: tweetUrl(tweet.authorHandle, tweet.id),
    },
    cfg,
    logger,
  );

  const totalLatencyMs = Date.now() - startedAt;
  logger.info(
    {
      totalLatencyMs,
      imageMs: image.latencyMs,
      uploadMs: upload.latencyMs,
      imageSource: image.source,
      uploadSource: upload.source,
    },
    'assets ready',
  );
  return {
    metadataUri: upload.metadataUri,
    imageUri: upload.imageUri,
    image,
    upload,
    totalLatencyMs,
  };
}
