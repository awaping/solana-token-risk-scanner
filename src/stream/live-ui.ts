/**
 * Affichage du mode stream, commun à toutes les blockchains :
 *
 *   dashboard  tableau live redessiné en place (terminal) ; hors terminal,
 *              événements au fil de l'eau et classement périodique
 *   journal    une ligne par événement (--all)
 *   jsonl      JSON sur stdout, messages d'état sur stderr (--jsonl)
 */
import type { RiskLevel } from '../types.js';
import { c, fmtNum, truncateVisible } from '../utils/format.js';
import { disableQuickEdit, restoreQuickEdit } from '../utils/windows-console.js';
import { fmtAge, renderBoard, SORT_LABELS, type BoardRow, type SortKey } from './dashboard.js';
import type { StatusHandler } from './sources/types.js';

export type OutputMode = 'dashboard' | 'journal' | 'jsonl';

export interface LiveUiOptions {
  mode: OutputMode;
  /** Sortie sur un terminal interactif (redessin en place). */
  live: boolean;
  refreshS: number;
  statsS: number;
  top: number;
  sort: SortKey;
  only?: ReadonlySet<RiskLevel>;
  minTrades: number;
  /** Titre affiché en tête du tableau de bord. */
  title: string;
  /** Ligne de statistiques du tableau de bord (débit, latence, sources…). */
  statsLine: () => string;
  /** Résumé périodique (journal / jsonl) et final. */
  summaryLine: () => string;
  /** Lignes du classement (tokens actifs triés). */
  board: (limit: number) => BoardRow[];
}

export const clock = (withMs = true): string => {
  const d = new Date();
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  const base = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  return withMs ? `${base}.${pad(d.getMilliseconds(), 3)}` : base;
};

export class LiveUi {
  private readonly events: string[] = [];
  private started = Date.now();
  private refreshTimer?: NodeJS.Timeout;
  private statsTimer?: NodeJS.Timeout;
  private freezeTimer?: NodeJS.Timeout;
  private lastBeat = Date.now();
  private drawing = false;

  constructor(private readonly opts: LiveUiOptions) {}

  /** Ajoute une ligne au journal d'événements du tableau de bord. */
  pushEvent(line: string): void {
    if (this.opts.mode === 'dashboard' && !this.opts.live) console.log(line);
    this.events.unshift(line);
    if (this.events.length > 30) this.events.pop();
  }

  /** Message informatif, routé selon le mode de sortie. */
  log(line: string): void {
    if (this.opts.mode === 'dashboard') this.pushEvent(line);
    else if (this.opts.mode === 'jsonl') process.stderr.write(`${line}\n`);
    else console.log(line);
  }

  /** Messages d'état des sources et du moteur. */
  readonly status: StatusHandler = (source, message, level) => {
    const line = `${c.gray(clock())} ${level === 'warn' ? c.yellow('!') : c.green('●')} ${c.gray(`[${source}]`)} ${message}`;
    if (this.drawing) this.pushEvent(line);
    else process.stderr.write(`${line}\n`);
  };

  boardBlock(maxRows: number): string[] {
    const { sort, only, minTrades } = this.opts;
    const rows = this.opts.board(maxRows);
    const title =
      c.bold(`CLASSEMENT PAR ${SORT_LABELS[sort].toUpperCase()}`) +
      c.gray(
        ` — tokens actifs (≥ ${minTrades} trades)${only ? ` · risque : ${[...only].join(', ')}` : ''} · lancements sans activité masqués`,
      );
    return [
      title,
      ...(rows.length > 0
        ? renderBoard(rows, sort)
        : [c.gray('  Aucun token actif pour le moment : un lancement apparaît ici dès qu’il franchit le seuil.')]),
    ];
  }

  private frame(): string[] {
    const height = process.stdout.rows ?? 40;
    const eventsShown = Math.min(8, Math.max(3, Math.floor(height / 5)));
    const boardRows = Math.max(3, Math.min(this.opts.top, height - eventsShown - 9));
    return [
      `${c.bold(this.opts.title)}  ${c.gray(`${clock(false)} · en ligne depuis ${fmtAge(Date.now() - this.started)} · Ctrl+C pour quitter`)}`,
      this.opts.statsLine(),
      '',
      ...this.boardBlock(boardRows),
      '',
      c.bold('DERNIERS ÉVÉNEMENTS'),
      ...(this.events.length > 0 ? this.events.slice(0, eventsShown) : [c.gray('  (aucun pour le moment)')]),
    ];
  }

  private draw(): void {
    const width = Math.max(40, (process.stdout.columns ?? 200) - 1);
    const lines = this.frame().map((line) => `${truncateVisible(line, width)}\x1b[K`);
    process.stdout.write(`\x1b[H${lines.join('\n')}\x1b[J`);
  }

  /** Démarre le rafraîchissement du tableau ou les statistiques périodiques. */
  start(): void {
    this.started = Date.now();
    const { mode, live, refreshS, statsS, top } = this.opts;
    disableQuickEdit();
    this.watchFreezes();
    if (mode === 'dashboard' && live) {
      process.stdout.write('\x1b[?25l\x1b[2J');
      this.drawing = true;
      this.draw();
      this.refreshTimer = setInterval(() => this.draw(), refreshS * 1_000);
    } else if (mode === 'dashboard') {
      this.refreshTimer = setInterval(() => console.log(['', ...this.boardBlock(top), ''].join('\n')), refreshS * 1_000);
    } else if (statsS > 0) {
      this.statsTimer = setInterval(() => this.log(this.opts.summaryLine()), statsS * 1_000);
    }
  }

  /**
   * Détecte les gels du programme : un minuteur d'une seconde qui se réveille
   * avec plusieurs secondes de retard signifie que plus rien ne s'exécutait
   * (console Windows en mode sélection, mise en veille de la machine…).
   */
  private watchFreezes(): void {
    this.lastBeat = Date.now();
    this.freezeTimer = setInterval(() => {
      const now = Date.now();
      const gapS = (now - this.lastBeat) / 1000;
      this.lastBeat = now;
      if (gapS < 5) return;
      const hint =
        process.platform === 'win32'
          ? ' : un clic dans la fenêtre met la console Windows en pause (Échap pour reprendre)'
          : ' (mise en veille, terminal suspendu…)';
      this.log(c.yellow(`${c.gray(clock())} ! programme figé pendant ${fmtNum(gapS, 0)} s${hint} ; le flux reprend`));
    }, 1_000);
    this.freezeTimer.unref();
  }

  /** Arrêt : restaure le terminal, affiche le classement final et le résumé. */
  finish(): void {
    clearInterval(this.refreshTimer);
    clearInterval(this.statsTimer);
    clearInterval(this.freezeTimer);
    restoreQuickEdit();
    if (this.drawing) process.stdout.write('\x1b[?25h\x1b[2J\x1b[H');
    this.drawing = false;
    if (this.opts.mode === 'dashboard') console.log(['', ...this.boardBlock(this.opts.top), ''].join('\n'));
    const summary = this.opts.summaryLine();
    if (this.opts.mode === 'jsonl') process.stderr.write(`${summary}\n`);
    else console.log(summary);
  }
}
