/**
 * Résultat transmis du service worker au panneau.
 *
 * chrome.runtime.sendMessage sérialise en JSON : un ScanResult complet y échoue
 * (« Could not serialize message ») à cause de ses BigInt (supply, soldes). On
 * ne transmet que ce que le panneau affiche, en types JSON simples. Module pur,
 * sans API chrome, pour être testé avec un vrai résultat de scan.
 */
import type { Finding, ScanResult } from '../../src/types.js';

export interface PanelResult {
  mint: string;
  token: { mint: string; name?: string; symbol?: string };
  /** Adresse de la page quand ce n'était pas le mint (bonding curve, pool…). */
  resolvedFrom?: { address: string; kind: string };
  risk: {
    score: number;
    level: 'VERT' | 'ORANGE' | 'ROUGE';
    confidence: number;
    modules: Array<{ label: string; score: number | null; findings: Finding[]; unavailableReason?: string }>;
  };
}

export function toPanelResult(result: ScanResult): PanelResult {
  const { risk, token } = result;
  return {
    mint: result.mint,
    token: {
      mint: result.mint,
      ...(token.name ? { name: token.name } : {}),
      ...(token.symbol ? { symbol: token.symbol } : {}),
    },
    ...(result.resolvedFrom ? { resolvedFrom: { address: result.resolvedFrom.address, kind: result.resolvedFrom.kind } } : {}),
    risk: {
      score: risk.score,
      level: risk.level,
      confidence: risk.confidence,
      modules: risk.modules.map((m) => ({
        label: m.label,
        score: m.score,
        findings: m.findings.map((f) => ({ severity: f.severity, message: f.message })),
        ...(m.unavailableReason ? { unavailableReason: m.unavailableReason } : {}),
      })),
    },
  };
}

/**
 * Raison lisible d'un module non analysé, pour le bandeau « Note incomplète ».
 * Le moteur formule ses raisons pour le terminal (« --no-census ») : on les
 * traduit en geste possible dans l'extension, sans accuser le RPC à tort.
 */
export function describeMissingModule(reason?: string): string {
  if (!reason) return 'indisponible';
  if (/recensement désactivé/i.test(reason)) {
    return 'recensement des holders désactivé dans les réglages (case « Recensement complet des holders »)';
  }
  if (/dépend du module holders/i.test(reason)) return "dépend de l'analyse des holders, elle-même indisponible";
  if (/\b429\b|too many|saturé|rate.?limit/i.test(reason)) return 'RPC saturé (429) : réessaie dans quelques secondes';
  if (/indexed|not supported|unsupported|excluded|method not found|-32601|-32010/i.test(reason)) {
    return 'ton RPC refuse cette méthode : il faut un fournisseur qui la supporte (Helius, Alchemy, QuickNode)';
  }
  return reason.length > 120 ? `${reason.slice(0, 117)}…` : reason;
}
