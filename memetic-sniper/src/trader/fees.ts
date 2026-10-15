/**
 * src/trader/fees.ts
 * ---------------------------------------------------------------------------
 * Recuperation des creator fees accumules sur le `creator_vault`.
 *
 * POURQUOI PAS DE BUNDLE JITO ICI, contrairement aux ventes :
 * un claim ne peut pas etre sandwiche - il ne deplace aucun prix, il vide un
 * vault vers son unique proprietaire legitime. Payer un tip Jito (0.001 SOL et
 * plus) sur une transaction qui en recupere parfois 0.01 mangerait une part
 * importante du gain. Transaction classique, donc.
 *
 * Le vault est partage par TOUS les tokens d'un meme createur : les seeds sont
 * `["creator-vault", creator]`, sans le mint. Un seul claim periodique suffit
 * pour l'ensemble du portefeuille, inutile d'en declencher un par token.
 * ---------------------------------------------------------------------------
 */

import {
  ComputeBudgetProgram,
  Keypair,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import type { Connection } from '@solana/web3.js';
import type { Logger } from 'pino';

import { buildCollectCreatorFeeInstruction, deriveCreatorVault } from '../solana/pumpfun.ts';

export interface FeeClaimConfig {
  /**
   * Seuil sous lequel on ne reclame pas.
   * Une transaction coute ~5000 lamports de frais de base plus la priority fee ;
   * reclamer 2000 lamports fait perdre de l'argent. Defaut : 0.005 SOL.
   */
  minClaimLamports: bigint;
  computeUnitLimit: number;
  computeUnitPriceMicroLamports: number;
}

export const DEFAULT_FEE_CLAIM_CONFIG: FeeClaimConfig = {
  minClaimLamports: 5_000_000n,
  computeUnitLimit: 60_000,
  computeUnitPriceMicroLamports: 50_000,
};

export type FeeClaimResult =
  | { status: 'claimed'; signature: string; vaultBefore: bigint; received: bigint }
  | { status: 'below-threshold'; vaultBefore: bigint }
  | { status: 'failed'; vaultBefore: bigint; error: string };

/** Lamports actuellement en attente dans le creator_vault. */
export async function creatorVaultBalance(
  connection: Connection,
  creator: Keypair | { publicKey: import('@solana/web3.js').PublicKey },
): Promise<bigint> {
  const vault = deriveCreatorVault(creator.publicKey);
  // Le vault peut ne pas exister tant qu'aucun frais n'a ete genere.
  const info = await connection.getAccountInfo(vault, 'confirmed');
  return info ? BigInt(info.lamports) : 0n;
}

/**
 * Reclame les frais accumules, si le montant justifie la transaction.
 *
 * Le montant reellement recu est mesure par la variation de solde du createur,
 * pas deduit du solde du vault : le programme peut retenir le minimum de rent
 * exempt sur le vault, et les frais de transaction se deduisent du meme solde.
 * Seule la difference observee dit ce qui a vraiment ete gagne.
 */
export async function claimCreatorFees(
  connection: Connection,
  creator: Keypair,
  logger: Logger,
  cfg: FeeClaimConfig = DEFAULT_FEE_CLAIM_CONFIG,
): Promise<FeeClaimResult> {
  const log = logger.child({ module: 'fees', creator: creator.publicKey.toBase58() });
  const vaultBefore = await creatorVaultBalance(connection, creator);

  if (vaultBefore < cfg.minClaimLamports) {
    log.debug(
      { vaultSol: Number(vaultBefore) / 1e9, thresholdSol: Number(cfg.minClaimLamports) / 1e9 },
      'creator fees below claim threshold',
    );
    return { status: 'below-threshold', vaultBefore };
  }

  try {
    const [solBefore, { blockhash, lastValidBlockHeight }] = await Promise.all([
      connection.getBalance(creator.publicKey, 'confirmed'),
      connection.getLatestBlockhash('confirmed'),
    ]);

    const message = new TransactionMessage({
      payerKey: creator.publicKey,
      recentBlockhash: blockhash,
      instructions: [
        ComputeBudgetProgram.setComputeUnitLimit({ units: cfg.computeUnitLimit }),
        ComputeBudgetProgram.setComputeUnitPrice({
          microLamports: cfg.computeUnitPriceMicroLamports,
        }),
        buildCollectCreatorFeeInstruction(creator.publicKey),
      ],
    }).compileToV0Message();

    const tx = new VersionedTransaction(message);
    tx.sign([creator]);

    const signature = await connection.sendTransaction(tx, { maxRetries: 3 });
    const confirmation = await connection.confirmTransaction(
      { signature, blockhash, lastValidBlockHeight },
      'confirmed',
    );
    if (confirmation.value.err) {
      throw new Error(`claim failed on-chain: ${JSON.stringify(confirmation.value.err)}`);
    }

    const solAfter = await connection.getBalance(creator.publicKey, 'confirmed');
    const received = BigInt(solAfter) - BigInt(solBefore);

    log.info(
      {
        signature,
        vaultBeforeSol: Number(vaultBefore) / 1e9,
        netReceivedSol: Number(received) / 1e9,
      },
      'creator fees claimed',
    );
    return { status: 'claimed', signature, vaultBefore, received };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    log.error({ err, vaultSol: Number(vaultBefore) / 1e9 }, 'creator fee claim failed');
    return { status: 'failed', vaultBefore, error };
  }
}

/**
 * Boucle de claim periodique. Retourne une fonction d'arret.
 *
 * Les erreurs sont avalees par `claimCreatorFees` (qui renvoie un statut) :
 * une reclamation ratee ne doit jamais interrompre la boucle ni le bot.
 */
export function startAutoClaim(
  connection: Connection,
  creator: Keypair,
  intervalMs: number,
  logger: Logger,
  cfg: FeeClaimConfig = DEFAULT_FEE_CLAIM_CONFIG,
): () => void {
  if (!(intervalMs > 0)) throw new Error('startAutoClaim: intervalMs must be > 0');
  let inFlight = false;

  const timer = setInterval(() => {
    if (inFlight) return; // Un claim lent ne doit pas en empiler un second.
    inFlight = true;
    void claimCreatorFees(connection, creator, logger, cfg).finally(() => {
      inFlight = false;
    });
  }, intervalMs);
  timer.unref();

  logger.info({ intervalMs }, 'creator fee auto-claim started');
  return () => clearInterval(timer);
}
