/**
 * Score de risque d'un token EVM (fonction pure). Mêmes niveaux que le reste
 * de l'outil : VERT 0-30 · ORANGE 31-69 · ROUGE 70-100, avec des planchers
 * pour les capacités qui permettent un rug à coup sûr.
 */
import { levelFor } from '../scoring/engine.js';
import type { Finding, ScoreFloor } from '../types.js';
import { fmtNum, fmtPct, shortAddr } from '../utils/format.js';
import { clamp } from '../utils/math.js';
import type { FastVerdict } from '../stream/fast-score.js';
import type { EvmTokenAudit } from './audit.js';

export interface EvmScoreInput {
  audit?: EvmTokenAudit;
  /** Lancements du même créateur observés sur 24 h (token courant inclus). */
  creatorLaunches24h: number;
  /** Tokens précédents du créateur dont le dev a vendu pendant le suivi. */
  creatorDevSells: number;
  /** Part de la supply encore détenue par le créateur (dernière lecture). */
  currentDevPct?: number;
  devSold: boolean;
  liquidityPulled: boolean;
  /** Liquidité actuelle côté devise de cotation (unités UI). */
  liquidityQuote?: number;
}

export function computeEvmScore(s: EvmScoreInput): FastVerdict {
  const findings: Finding[] = [];
  const floors: ScoreFloor[] = [];
  let points = 0;
  const a = s.audit;

  if (!a) {
    findings.push({ severity: 'info', message: 'Audit du contrat en cours…' });
  } else {
    const ownerActive = a.owner !== null && !a.ownerRenounced;
    const caps = a.capabilities;
    const list = (names: readonly string[]) => names.map((n) => n.split('(')[0]).join(', ');

    if (a.codeSize === 0) {
      findings.push({ severity: 'critical', message: "Aucun code à l'adresse du token" });
      floors.push({ floor: 70, reason: 'Contrat absent' });
    }
    if (a.proxy === 'eip1967') {
      points += 40;
      findings.push({ severity: 'critical', message: 'Contrat modifiable (proxy EIP-1967) : son code peut être remplacé à tout moment' });
      floors.push({ floor: 65, reason: 'Proxy modifiable' });
    }

    if (caps.mint.length > 0) {
      if (ownerActive) {
        points += 40;
        findings.push({ severity: 'critical', message: `Fonction de mint (${list(caps.mint)}) et propriétaire actif : la supply peut être gonflée` });
        floors.push({ floor: 60, reason: 'Mint possible' });
      } else {
        findings.push({ severity: 'info', message: `Fonction de mint présente, propriétaire renoncé` });
      }
    }
    const blocking = [...caps.blacklist, ...caps.pause];
    if (blocking.length > 0) {
      if (ownerActive) {
        points += 35;
        findings.push({ severity: 'critical', message: `Blacklist / pause (${list(blocking)}) : le propriétaire peut bloquer les ventes (honeypot possible)` });
        floors.push({ floor: 65, reason: 'Ventes bloquables' });
      } else {
        findings.push({ severity: 'info', message: 'Fonctions de blacklist / pause présentes, propriétaire renoncé' });
      }
    }
    if (caps.fees.length > 0 && ownerActive) {
      points += 20;
      findings.push({ severity: 'warning', message: `Taxes modifiables par le propriétaire (${list(caps.fees)})` });
    }
    if (caps.limits.length > 0 && ownerActive) {
      points += 5;
      findings.push({ severity: 'info', message: `Limites de transaction / wallet modifiables (${list(caps.limits)})` });
    }
    if (ownerActive) {
      points += 10;
      findings.push({ severity: 'warning', message: `Propriétaire non renoncé (${shortAddr(a.owner!)})` });
    } else {
      findings.push({ severity: 'ok', message: a.owner === null ? 'Pas de propriétaire (pas de fonction owner)' : 'Propriété renoncée' });
    }

    const devPct = s.currentDevPct ?? a.devPct;
    if (devPct !== undefined) {
      if (devPct > 40) {
        points += 40;
        findings.push({ severity: 'critical', message: `Le créateur détient ${fmtPct(devPct)} de la supply` });
        floors.push({ floor: 75, reason: `Créateur à ${fmtPct(devPct)}` });
      } else if (devPct > 20) {
        points += 30;
        findings.push({ severity: 'critical', message: `Le créateur détient ${fmtPct(devPct)} de la supply` });
      } else if (devPct > 10) {
        points += 15;
        findings.push({ severity: 'warning', message: `Le créateur détient ${fmtPct(devPct)} de la supply` });
      } else {
        findings.push({ severity: 'ok', message: `Le créateur détient ${fmtPct(devPct)} de la supply` });
      }
    }
    if (a.creatorNonce !== undefined && a.creatorNonce < 5) {
      points += 10;
      findings.push({ severity: 'warning', message: `Wallet créateur neuf (${a.creatorNonce} transaction${a.creatorNonce > 1 ? 's' : ''})` });
    }

    if (a.lpBurnedPct !== undefined) {
      if (a.lpBurnedPct >= 95) {
        findings.push({ severity: 'ok', message: `LP brûlés à ${fmtPct(a.lpBurnedPct, 0)}` });
      } else if (a.lpBurnedPct < 50) {
        points += 15;
        findings.push({ severity: 'warning', message: `LP brûlés à ${fmtPct(a.lpBurnedPct, 0)} seulement : la liquidité peut être retirée` });
      }
    }
    const liquidity = s.liquidityQuote ?? a.liquidityQuote;
    if (liquidity !== undefined) {
      if (liquidity === 0) {
        points += 20;
        findings.push({ severity: 'warning', message: `Aucune liquidité en ${a.quote.symbol} dans la pool` });
      } else {
        findings.push({ severity: 'info', message: `Liquidité : ${fmtNum(liquidity, liquidity < 10 ? 3 : 1)} ${a.quote.symbol}` });
      }
    }
  }

  // Réputation du créateur (lancements observés par le flux).
  const n = s.creatorLaunches24h;
  if (n >= 3) {
    points += n >= 5 ? 60 : 40;
    findings.push({ severity: n >= 5 ? 'critical' : 'warning', message: `Créateur : ${n} lancements en 24 h (déployeur en série)` });
    if (n >= 10) floors.push({ floor: 70, reason: `${n} lancements en 24 h` });
  } else if (n === 2) {
    points += 20;
    findings.push({ severity: 'warning', message: 'Créateur : 2e lancement en 24 h' });
  }
  if (s.creatorDevSells >= 1) {
    points += s.creatorDevSells >= 3 ? 45 : 25;
    findings.push({ severity: s.creatorDevSells >= 3 ? 'critical' : 'warning', message: `Ce créateur a déjà vendu rapidement ${s.creatorDevSells} de ses tokens` });
    if (s.creatorDevSells >= 3) floors.push({ floor: 70, reason: 'Créateur récidiviste' });
  }

  if (s.devSold) {
    points += 40;
    findings.push({ severity: 'critical', message: 'Le dev a vendu ses tokens' });
    floors.push({ floor: 70, reason: 'Vente du dev' });
  }
  if (s.liquidityPulled) {
    findings.push({ severity: 'critical', message: 'Liquidité retirée de la pool (rug pull)' });
    floors.push({ floor: 90, reason: 'Liquidité retirée' });
  }

  const maxFloor = floors.reduce((acc, f) => Math.max(acc, f.floor), 0);
  const score = Math.round(clamp(Math.max(points, maxFloor)));
  return { score, level: levelFor(score), findings, floors };
}
