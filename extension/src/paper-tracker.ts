/**
 * Suivi, seconde par seconde, de la position DryFlip sur la page d'un token :
 * décide quand une opération a eu lieu, à quelle heure, et quoi enregistrer.
 * Module pur (horloge injectée), testé sans navigateur.
 *
 * Trois pièges du terrain :
 *  - juste après une navigation, le widget peut encore montrer le token
 *    précédent : les premières secondes sont ignorées ;
 *  - au chargement, DryFlip peut afficher un instant « 0 » avant la position
 *    déjà ouverte : un achat n'est « vu en direct » qu'après un état vide stable ;
 *  - après une vente totale, DryFlip peut simplement retirer la position : sa
 *    disparition vaut sortie, avec le dernier PnL affiché.
 */
import { positionKey, tradeKey, type DryFlipScan, type PaperPosition, type PaperWallet } from './paper.js';

export const STALE_MS = 2_500;
export const EMPTY_STABLE_MS = 3_000;
export const ABSENT_AFTER_MS = 6_000;
export const SEND_EVERY_MS = 30_000;
export const WALLET_EVERY_MS = 10_000;
/** Position absente 5 lectures de suite : vendue (pas un simple re-rendu du widget). */
const VANISH_TICKS = 5;

export type PaperStatus = 'recherche' | 'absent' | 'iframe' | 'vide' | 'position';

export interface PaperView {
  status: PaperStatus;
  position?: PaperPosition;
  wallet?: PaperWallet;
}

export interface PaperSend {
  at: number;
  /** Opération vue en direct (heure exacte). */
  observed: boolean;
  position?: PaperPosition;
  /** La position a disparu du widget : vente totale. */
  vanished?: boolean;
  wallet?: PaperWallet;
}

export class PaperTracker {
  /** Mint analysé (connu une fois le scan terminé) : rien n'est envoyé avant. */
  mint?: string;
  private emptySince?: number;
  private sawEmpty = false;
  private pending?: { key: string; at: number };
  private lastTrade?: string;
  private lastKey?: string;
  private lastSentAt = 0;
  private lastPosition?: PaperPosition;
  private missing = 0;
  private walletSentAt = 0;
  private walletValue?: number;

  constructor(
    readonly address: string,
    private readonly since: number,
    /** Dernière position lue sur le token précédent : la revoir ici, c'est un widget pas encore rafraîchi. */
    private readonly staleKey?: string,
  ) {}

  /** Clé de la dernière position vue, transmise au suivi du token suivant. */
  get key(): string | undefined {
    return this.lastKey ?? this.pending?.key;
  }

  tick(scan: DryFlipScan, now: number): { view: PaperView; send?: PaperSend } {
    const elapsed = now - this.since;
    const { position, wallet } = scan.reading;
    if (!scan.found || (scan.framed && !position && !wallet)) {
      return { view: { status: scan.framed ? 'iframe' : elapsed >= ABSENT_AFTER_MS ? 'absent' : 'recherche' } };
    }
    if (elapsed < STALE_MS || (position && this.staleKey && positionKey(position) === this.staleKey && elapsed < STALE_MS * 3 && !this.lastTrade)) {
      return { view: { status: 'recherche' } };
    }
    const view: PaperView = { status: position ? 'position' : 'vide', ...(position ? { position } : {}), ...(wallet ? { wallet } : {}) };
    let send: PaperSend | undefined;

    if (!position) {
      this.emptySince ??= now;
      if (now - this.emptySince >= EMPTY_STABLE_MS) this.sawEmpty = true;
      // Position revendue en totalité puis retirée du widget.
      if (this.lastPosition && this.mint && ++this.missing >= VANISH_TICKS) {
        send = { at: now, observed: true, position: this.lastPosition, vanished: true };
        this.lastPosition = undefined;
        this.lastTrade = undefined;
        this.lastKey = undefined;
        this.lastSentAt = now;
      }
    } else {
      this.emptySince = undefined;
      this.missing = 0;
      const trade = tradeKey(position);
      const key = positionKey(position);
      if (!this.mint) {
        if (this.pending?.key !== trade) this.pending = { key: trade, at: now };
      } else if (trade !== this.lastTrade) {
        const at = this.pending?.key === trade ? this.pending.at : now;
        send = { at, observed: this.sawEmpty || this.lastTrade !== undefined, position };
        this.lastTrade = trade;
        this.lastKey = key;
        this.lastSentAt = now;
        this.pending = undefined;
      } else if (key !== this.lastKey && now - this.lastSentAt >= SEND_EVERY_MS) {
        send = { at: now, observed: true, position };
        this.lastKey = key;
        this.lastSentAt = now;
      }
      this.lastPosition = position;
    }

    const balance = wallet?.balance?.value;
    if (wallet && balance !== undefined && (this.walletValue === undefined || (balance !== this.walletValue && now - this.walletSentAt >= WALLET_EVERY_MS))) {
      send = { ...(send ?? { at: now, observed: true }), wallet };
      this.walletSentAt = now;
      this.walletValue = balance;
    }
    return { view, ...(send ? { send } : {}) };
  }
}
