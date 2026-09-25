/**
 * Utilitaires communs aux commandes stream (Solana et EVM) : options,
 * filtres, rendu des phases et des constats, webhook.
 */
import type { Finding, RiskLevel } from '../types.js';
import { c } from '../utils/format.js';
import type { SortKey } from './dashboard.js';
import type { Phase } from './engine.js';
import type { OutputMode } from './live-ui.js';

export const PHASE_STYLE: Record<Phase, (t: string) => string> = {
  T0: (t) => c.bold(c.cyan(t)),
  T1: (t) => c.bold(c.blue(t)),
  T2: (t) => c.bold(c.magenta(t)),
  ACTIF: (t) => c.bold(c.green(t)),
  ALERTE: (t) => c.bold(c.red(t)),
};
export const PHASE_ICON: Record<Phase, string> = { T0: '⚡', T1: '◆', T2: '◇', ACTIF: '★', ALERTE: '⚠' };
export const ALL_PHASES: readonly Phase[] = ['T0', 'T1', 'T2', 'ACTIF', 'ALERTE'];

/** Options communes à toutes les blockchains, une fois analysées. */
export interface CommonStreamOptions {
  sort: SortKey;
  minTrades: number;
  top: number;
  trackSeconds: number;
  statsS: number;
  refreshS: number;
  only?: Set<RiskLevel>;
  phases?: Set<Phase>;
  mode: OutputMode;
  live: boolean;
  webhook?: string;
  cache?: string;
}

export const jsonReplacer = (_key: string, value: unknown) => (typeof value === 'bigint' ? value.toString() : value);

export function parseLevels(value: string | undefined): Set<RiskLevel> | undefined {
  if (!value) return undefined;
  const map: Record<string, RiskLevel> = { vert: 'VERT', green: 'VERT', orange: 'ORANGE', rouge: 'ROUGE', red: 'ROUGE' };
  const levels = new Set<RiskLevel>();
  for (const part of value.split(',')) {
    const level = map[part.trim().toLowerCase()];
    if (!level) throw new Error(`--only invalide : "${part}" (vert, orange, rouge)`);
    levels.add(level);
  }
  return levels;
}

export function parsePhases(value: string | undefined): Set<Phase> | undefined {
  if (!value) return undefined;
  const phases = new Set<Phase>();
  for (const part of value.split(',')) {
    const phase = part.trim().toUpperCase() as Phase;
    if (!ALL_PHASES.includes(phase)) throw new Error(`--phases invalide : "${part}" (t0, t1, t2, actif, alerte)`);
    phases.add(phase);
  }
  return phases;
}

export function intOption(value: string | undefined, name: string, fallback: number, min = 0): number {
  if (value === undefined) return fallback;
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || n < min) throw new Error(`--${name} invalide : "${value}" (entier >= ${min})`);
  return n;
}

/** Constats critiques et d'alerte non encore affichés pour ce token. */
export function renderFindings(findings: Finding[], alreadyShown: Set<string>): string[] {
  const lines: string[] = [];
  for (const f of findings) {
    if ((f.severity !== 'critical' && f.severity !== 'warning') || alreadyShown.has(f.message)) continue;
    alreadyShown.add(f.message);
    const icon = f.severity === 'critical' ? c.red('✖') : c.yellow('▲');
    lines.push(`${' '.repeat(22)}${icon} ${f.message}`);
  }
  return lines;
}

/** Envoi « fire and forget » d'un événement à un webhook. */
export function postWebhook(url: string | undefined, payload: unknown): void {
  if (!url) return;
  fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload, jsonReplacer),
    signal: AbortSignal.timeout(2_000),
  }).catch(() => undefined);
}

/**
 * Un événement est-il retenu pour la sortie courante ?
 * Tableau de bord : ACTIF (filtré par niveau de risque) et ALERTE sur un token
 * déjà échangé ; journal / JSONL : filtres --phases et --only.
 */
export function isSelected(
  opts: Pick<CommonStreamOptions, 'mode' | 'only' | 'phases'>,
  event: { phase: Phase; level: RiskLevel; tokenIsLive: boolean },
): boolean {
  const alertOnLiveToken = event.phase === 'ALERTE' && event.tokenIsLive;
  if (opts.mode === 'dashboard') {
    if (event.phase === 'ACTIF') return !opts.only || opts.only.has(event.level);
    return alertOnLiveToken;
  }
  if (opts.phases && !opts.phases.has(event.phase)) return false;
  return !opts.only || opts.only.has(event.level) || alertOnLiveToken;
}
