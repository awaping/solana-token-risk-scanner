/**
 * Instantané d'une analyse pour l'historique : chiffres clés + détail complet,
 * en types JSON simples (les BigInt deviennent du texte). Utilisé par le
 * service worker uniquement (il dépend des constantes du moteur).
 */
import { CONCENTRATION } from '../../src/constants.js';
import type { ScanResult } from '../../src/types.js';
import type { ScanSnapshot, ScanTrigger } from './history-store.js';

/**
 * `requestedAt` : moment où l'analyse a été demandée (ouverture de la page,
 * achat) ; l'âge du token est mesuré à cet instant, pas à la fin du scan.
 */
export function toSnapshot(result: ScanResult, at = Date.now(), options: { trigger?: ScanTrigger; requestedAt?: number } = {}): ScanSnapshot {
  const { token, risk } = result;
  const createdAt = result.tokenAge?.createdAt.getTime();
  const tokenAgeSec = createdAt === undefined ? undefined : Math.max(0, ((options.requestedAt ?? at) - createdAt) / 1000);
  const holders = result.holders.status === 'ok' ? result.holders.data : undefined;
  const clustering = result.clustering.status === 'ok' ? result.clustering.data : undefined;
  const dusting = result.dusting.status === 'ok' ? result.dusting.data : undefined;
  const reserve = result.reserve.status === 'ok' ? result.reserve.data : undefined;
  const creator = result.creator.status === 'ok' ? result.creator.data : undefined;
  const fresh = result.fresh?.status === 'ok' ? result.fresh.data : undefined;

  const whales = holders?.wallets.filter(
    (w) => w.kind !== 'creator' && w.kind !== 'program' && w.pct >= CONCENTRATION.WHALE_SUPPLY_PCT,
  ).length;

  const metrics: ScanSnapshot['point']['metrics'] = {
    ...(holders
      ? { top10Pct: holders.top10Pct, top20Pct: holders.top20Pct, maxWalletPct: holders.maxWalletPct, whales }
      : {}),
    ...(dusting ? { holders: dusting.totalHolders, dustRatio: dusting.dustRatio } : {}),
    ...(reserve
      ? {
          venue: reserve.venue,
          marketType: reserve.marketType,
          reserveSol: reserve.realReserveSol,
          marketCapSol: reserve.marketCapSol,
          priceSol: reserve.priceSol,
          ...(reserve.bondingCurveProgressPct !== undefined ? { curveProgressPct: reserve.bondingCurveProgressPct } : {}),
        }
      : {}),
    ...(creator
      ? {
          creatorHoldingPct: creator.holdingPct,
          creatorPreviousTokens: creator.previousTokensCreated,
          creatorSolBalance: creator.solBalance,
        }
      : {}),
    ...(clustering?.largestCluster ? { largestClusterSize: clustering.largestCluster.owners.length } : {}),
    ...(result.tokenAge ? { mintTxCount: result.tokenAge.transactions } : {}),
    ...(fresh ? { freshPct: fresh.freshPct, freshCount: fresh.fresh.length } : {}),
  };

  const alerts = risk.modules
    .flatMap((m) => m.findings)
    .filter((f): f is { severity: 'critical' | 'warning'; message: string } => f.severity === 'critical' || f.severity === 'warning')
    .map((f) => ({ severity: f.severity, message: f.message }));

  return {
    mint: result.mint,
    ...(token.name ? { name: token.name } : {}),
    ...(token.symbol ? { symbol: token.symbol } : {}),
    point: {
      at,
      ...(options.trigger ? { trigger: options.trigger } : {}),
      ...(tokenAgeSec !== undefined ? { tokenAgeSec } : {}),
      score: risk.score,
      level: risk.level,
      coverage: risk.confidence,
      modules: Object.fromEntries(risk.modules.map((m) => [m.id, m.score])),
      metrics,
      alerts,
    },
    detail: {
      at,
      token: {
        mint: token.mint,
        ...(token.name ? { name: token.name } : {}),
        ...(token.symbol ? { symbol: token.symbol } : {}),
        program: token.programLabel,
        decimals: token.decimals,
        supply: token.supply.toString(),
        ...(token.metadataUri ? { uri: token.metadataUri } : {}),
        mintAuthority: token.mintAuthority,
        freezeAuthority: token.freezeAuthority,
        dangerousExtensions: token.dangerousExtensions.map((e) => ({ name: e.name, detail: e.detail, severity: e.severity })),
      },
      modules: risk.modules.map((m) => ({
        id: m.id,
        label: m.label,
        weight: m.weight,
        score: m.score,
        findings: m.findings.map((f) => ({ severity: f.severity, message: f.message })),
        ...(m.unavailableReason ? { unavailableReason: m.unavailableReason } : {}),
      })),
      floors: risk.floors.map((f) => ({ floor: f.floor, reason: f.reason })),
      ...(holders
        ? { holders: holders.top.map((h) => ({ owner: h.owner, pct: h.pct, kind: h.kind, ...(h.label ? { label: h.label } : {}) })) }
        : {}),
      ...(reserve
        ? {
            reserve: {
              venue: reserve.venue,
              marketType: reserve.marketType,
              reserveSol: reserve.realReserveSol,
              marketCapSol: reserve.marketCapSol,
              priceSol: reserve.priceSol,
              ...(reserve.bondingCurveProgressPct !== undefined ? { curveProgressPct: reserve.bondingCurveProgressPct } : {}),
            },
          }
        : {}),
      ...(creator
        ? {
            creator: {
              address: creator.address,
              holdingPct: creator.holdingPct,
              previousTokensCreated: creator.previousTokensCreated,
              solBalance: creator.solBalance,
              signatureCount: creator.signatureCount,
              fullHistory: creator.fullHistory,
              ...(creator.walletAgeDays !== undefined ? { walletAgeDays: creator.walletAgeDays } : {}),
            },
          }
        : {}),
      ...(dusting ? { dusting: { totalHolders: dusting.totalHolders, dustHolders: dusting.dustHolders, dustRatio: dusting.dustRatio } } : {}),
      ...(result.tokenAge && createdAt !== undefined ? { tokenAge: { createdAt, exact: result.tokenAge.exact } } : {}),
      ...(result.resolvedFrom ? { resolvedFrom: { address: result.resolvedFrom.address, kind: result.resolvedFrom.kind } } : {}),
      durationMs: result.durationMs,
      rpcRequests: result.rpcRequests,
    },
  };
}
