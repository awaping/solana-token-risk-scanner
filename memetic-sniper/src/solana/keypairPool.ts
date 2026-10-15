/**
 * src/solana/keypairPool.ts
 * ---------------------------------------------------------------------------
 * Pool de Keypair pre-generees pour les mints.
 *
 * Generer une paire ed25519 coute ~0.1 ms. Ce n'est presque rien - sauf que
 * "presque rien" se paie sur le chemin critique, ou chaque milliseconde est
 * du terrain cede au sniper d'en face. Le pool deplace ce cout hors du chemin
 * critique : `acquire()` est un `pop()` de tableau, donc O(1) et sans await.
 *
 * Le remplissage tourne en tache de fond et rend la main a la boucle
 * d'evenements entre chaque lot : un pool qui bloque l'event loop retarderait
 * le listener, ce qui reviendrait a deplacer le probleme au lieu de le
 * resoudre.
 * ---------------------------------------------------------------------------
 */

import { setImmediate as yieldToEventLoop } from 'node:timers/promises';
import { Keypair } from '@solana/web3.js';
import type { Logger } from 'pino';

export interface KeypairPoolConfig {
  /** Taille cible du buffer. 10-25 suffit largement. */
  targetSize: number;
  /**
   * Suffixe vanity optionnel pour l'adresse du mint (ex. "pump").
   *
   * Cout : ~58^n essais pour n caracteres, soit ~11 millions pour 4.
   * A ~20 000 cles/s sur un thread, c'est une dizaine de minutes PAR cle.
   * Au-dela de 2 caracteres, ce pool ne tiendra pas la cadence.
   */
  vanitySuffix?: string;
  /** Essais maximum avant d'abandonner le vanity sur une cle donnee. */
  vanityMaxAttempts?: number;
  /** Intervalle du filet de securite de remplissage. */
  refillIntervalMs?: number;
}

export interface KeypairPoolStats {
  available: number;
  targetSize: number;
  generated: number;
  consumed: number;
  /** Nombre de fois ou `acquire()` a trouve le pool vide. */
  starvations: number;
  vanityHits: number;
  vanityGiveUps: number;
}

/** Lots de generation. Assez gros pour amortir, assez petit pour rester fluide. */
const GENERATION_BATCH = 4;
/** Essais de vanity entre deux cessions a la boucle d'evenements. */
const VANITY_YIELD_EVERY = 2_000;

export class KeypairPool {
  private readonly pool: Keypair[] = [];
  private readonly log: Logger;
  private readonly cfg: Required<Omit<KeypairPoolConfig, 'vanitySuffix'>> &
    Pick<KeypairPoolConfig, 'vanitySuffix'>;

  private refilling = false;
  private stopped = true;
  private timer: NodeJS.Timeout | undefined;

  private generated = 0;
  private consumed = 0;
  private starvations = 0;
  private vanityHits = 0;
  private vanityGiveUps = 0;

  constructor(config: KeypairPoolConfig, logger: Logger) {
    if (!Number.isInteger(config.targetSize) || config.targetSize < 1) {
      throw new Error(`KeypairPool: targetSize must be a positive integer, got ${config.targetSize}`);
    }
    const suffix = config.vanitySuffix?.trim();
    if (suffix) {
      // Base58 exclut 0, O, I et l : un suffixe qui en contient ne sortira jamais.
      const invalid = [...suffix].filter((c) => !/[1-9A-HJ-NP-Za-km-z]/.test(c));
      if (invalid.length > 0) {
        throw new Error(`KeypairPool: vanitySuffix contains non-base58 characters: ${invalid.join('')}`);
      }
    }

    this.log = logger.child({ module: 'keypairPool' });
    this.cfg = {
      targetSize: config.targetSize,
      vanityMaxAttempts: config.vanityMaxAttempts ?? 500_000,
      refillIntervalMs: config.refillIntervalMs ?? 2_000,
      ...(suffix ? { vanitySuffix: suffix } : {}),
    };

    if (suffix && suffix.length > 2) {
      // ponytail: grinding mono-thread, plafonne par vanityMaxAttempts.
      // Si un suffixe long devient un vrai besoin, passer le grinding dans un
      // worker_threads pool (N coeurs) plutot que d'allonger le budget ici.
      this.log.warn(
        { vanitySuffix: suffix, expectedAttempts: Math.round(58 ** suffix.length) },
        'vanity suffix longer than 2 chars: single-threaded grinding will not keep up, ' +
          'the pool will fall back to plain keypairs',
      );
    }
  }

  /** Remplit le pool et arme le filet de securite. A appeler au boot. */
  async start(): Promise<void> {
    if (!this.stopped) return;
    this.stopped = false;
    await this.refill();
    this.timer = setInterval(() => {
      void this.refill();
    }, this.cfg.refillIntervalMs);
    // unref : ce timer ne doit pas maintenir le processus en vie a lui seul.
    this.timer.unref();
    this.log.info({ size: this.pool.length, target: this.cfg.targetSize }, 'keypair pool ready');
  }

  /** Arrete le remplissage et efface les cles restantes. */
  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    let drained = 0;
    for (const kp of this.pool.splice(0)) {
      wipeKeypair(kp);
      drained++;
    }
    this.log.info({ drained }, 'keypair pool stopped and wiped');
  }

  /**
   * Retire une keypair du pool. O(1), synchrone, sans allocation.
   *
   * Si le pool est vide (rafale de signaux, ou demarrage a chaud), on genere
   * a chaud : mieux vaut 0.1 ms de latence supplementaire que rater le
   * lancement. Le compteur `starvations` rend l'evenement visible - s'il monte,
   * c'est que `targetSize` est sous-dimensionne.
   */
  acquire(): Keypair {
    const kp = this.pool.pop();
    this.consumed++;

    if (!kp) {
      this.starvations++;
      this.log.warn({ starvations: this.starvations }, 'keypair pool empty, generating inline');
      void this.refill();
      this.generated++;
      return Keypair.generate();
    }

    // Relance le remplissage sans l'attendre : l'appelant continue vers le
    // build de la transaction pendant que le pool se recompose.
    void this.refill();
    return kp;
  }

  /**
   * Efface la cle secrete d'une keypair consommee.
   *
   * A appeler APRES l'atterrissage du bundle : la keypair du mint doit signer
   * la transaction, l'effacer trop tot rend le bundle insignable.
   */
  dispose(keypair: Keypair): void {
    wipeKeypair(keypair);
  }

  get size(): number {
    return this.pool.length;
  }

  get stats(): KeypairPoolStats {
    return {
      available: this.pool.length,
      targetSize: this.cfg.targetSize,
      generated: this.generated,
      consumed: this.consumed,
      starvations: this.starvations,
      vanityHits: this.vanityHits,
      vanityGiveUps: this.vanityGiveUps,
    };
  }

  // -------------------------------------------------------------------------
  // Remplissage
  // -------------------------------------------------------------------------

  /**
   * Complete le pool jusqu'a `targetSize`.
   * Reentrance protegee par un drapeau : `acquire()` appelle `refill()` a
   * chaque prise, sans quoi plusieurs remplissages concurrents se marcheraient
   * dessus et depasseraient la cible.
   */
  private async refill(): Promise<void> {
    if (this.refilling || this.stopped) return;
    this.refilling = true;
    try {
      while (!this.stopped && this.pool.length < this.cfg.targetSize) {
        const batch = Math.min(GENERATION_BATCH, this.cfg.targetSize - this.pool.length);
        for (let i = 0; i < batch; i++) {
          this.pool.push(await this.generateOne());
          this.generated++;
        }
        // Cession explicite : le listener et l'analyzer passent avant le
        // confort du pool.
        await yieldToEventLoop();
      }
    } catch (err) {
      // Un pool vide degrade la latence, il ne doit pas tuer le processus.
      this.log.error({ err }, 'keypair pool refill failed');
    } finally {
      this.refilling = false;
    }
  }

  private async generateOne(): Promise<Keypair> {
    const suffix = this.cfg.vanitySuffix;
    if (!suffix) return Keypair.generate();

    for (let attempt = 1; attempt <= this.cfg.vanityMaxAttempts; attempt++) {
      const kp = Keypair.generate();
      if (kp.publicKey.toBase58().endsWith(suffix)) {
        this.vanityHits++;
        this.log.debug({ attempt, address: kp.publicKey.toBase58() }, 'vanity mint found');
        return kp;
      }
      wipeKeypair(kp); // Cle rejetee : on ne la laisse pas trainer en memoire.
      if (attempt % VANITY_YIELD_EVERY === 0) await yieldToEventLoop();
      if (this.stopped) break;
    }

    this.vanityGiveUps++;
    this.log.warn(
      { suffix, maxAttempts: this.cfg.vanityMaxAttempts },
      'vanity grinding gave up, falling back to a plain keypair',
    );
    return Keypair.generate();
  }
}

/**
 * Efface la cle secrete en place.
 *
 * Subtilite non evidente de @solana/web3.js : le getter `keypair.secretKey`
 * retourne une COPIE fraiche a chaque acces (`new Uint8Array(...)`). Faire
 * `kp.secretKey.fill(0)` efface donc une copie jetable et ne touche pas au
 * secret. Le seul buffer qui compte est `_keypair.secretKey`, interne et non
 * typé - d'ou l'acces defensif ci-dessous.
 *
 * Limite assumee : JavaScript ne garantit rien sur les copies laissees par le
 * GC ou par une eventuelle serialisation anterieure. C'est une mesure de
 * defense en profondeur qui reduit la fenetre d'exposition d'un dump memoire,
 * pas une garantie d'effacement.
 */
export function wipeKeypair(keypair: Keypair): void {
  const internal = (keypair as unknown as { _keypair?: { secretKey?: Uint8Array } })._keypair;
  if (internal?.secretKey instanceof Uint8Array) {
    internal.secretKey.fill(0);
  }
}
