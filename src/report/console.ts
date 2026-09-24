/**
 * Rendu du diagnostic dans le terminal.
 */
import type { Finding, Holder, ModuleScore, RiskLevel, ScanResult, Severity } from '../types.js';
import {
  bar,
  c,
  colorForScore,
  fmtNum,
  fmtPct,
  fmtPrice,
  fmtSol,
  fmtTokenAmount,
  padEndVisible,
  padStartVisible,
  shortAddr,
  visibleLength,
} from '../utils/format.js';

const WIDTH = 78;

const ICONS: Record<Severity, string> = {
  critical: c.red('✖'),
  warning: c.yellow('▲'),
  ok: c.green('✔'),
  info: c.gray('•'),
};

const SEVERITY_ORDER: Record<Severity, number> = { critical: 0, warning: 1, info: 2, ok: 3 };

const LEVEL_STYLE: Record<RiskLevel, (text: string) => string> = {
  VERT: (t) => c.bold(c.green(t)),
  ORANGE: (t) => c.bold(c.yellow(t)),
  ROUGE: (t) => c.bold(c.red(t)),
};

const VERDICTS: Record<RiskLevel, string> = {
  VERT: 'Distribution saine et liquidité cohérente : aucun pattern de manipulation détecté.',
  ORANGE: "Signaux d'alerte (concentration, liquidité faible ou créateur suspect) : prudence.",
  ROUGE: 'Pattern de manipulation avéré (wallets clonés, supply monopolisée, autorités dangereuses).',
};

const KIND_LABELS: Record<Holder['kind'], string> = {
  wallet: 'Wallet',
  'bonding-curve': 'Bonding curve',
  'liquidity-pool': 'Pool',
  burn: 'Burn',
  program: 'Programme',
  creator: 'Créateur',
};

function rule(title = ''): string {
  if (!title) return c.gray('─'.repeat(WIDTH));
  return `${c.gray('──')} ${c.bold(title)} ${c.gray('─'.repeat(Math.max(2, WIDTH - title.length - 4)))}`;
}

function moduleHeader(module: ModuleScore): string {
  const left = `${c.gray('──')} ${c.bold(module.label)} `;
  let right: string;
  if (module.score === null) {
    right = c.gray('indisponible');
  } else {
    const color = colorForScore(module.score);
    right = `${color(bar(module.score, 10))} ${color(padStartVisible(fmtNum(module.score, 0), 3))}/100`;
  }
  const fill = WIDTH - visibleLength(left) - visibleLength(right) - 1;
  return `${left}${c.gray('─'.repeat(Math.max(2, fill)))} ${right}`;
}

function renderFindings(findings: Finding[], lines: string[]): void {
  const sorted = [...findings].sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
  for (const f of sorted) {
    const text = f.severity === 'info' ? c.gray(f.message) : f.message;
    lines.push(`   ${ICONS[f.severity]} ${text}`);
  }
}

function renderHoldersTable(result: ScanResult, lines: string[]): void {
  if (result.holders.status !== 'ok') return;
  const top = result.holders.data.top;
  if (top.length === 0) return;
  const maxPct = Math.max(...top.map((h) => h.pct), 1);
  const { decimals } = result.token;

  lines.push(c.gray('    #  Propriétaire      Part         Solde                Type'));
  top.forEach((h, i) => {
    const isProtocol = h.kind === 'bonding-curve' || h.kind === 'liquidity-pool' || h.kind === 'burn';
    const kind =
      h.kind === 'bonding-curve' || !h.label || h.kind === 'creator'
        ? h.label ?? KIND_LABELS[h.kind]
        : `${KIND_LABELS[h.kind]} · ${h.label}`;
    const kindColored = h.kind === 'creator' ? c.magenta(kind) : isProtocol ? c.cyan(kind) : c.gray(kind);
    const row = [
      padStartVisible(String(i + 1), 5),
      ' ',
      padEndVisible(shortAddr(h.owner, 6), 16),
      padStartVisible(fmtPct(h.pct), 9),
      ' ',
      c.gray(bar(h.pct, 10, maxPct)),
      ' ',
      padStartVisible(fmtTokenAmount(h.amount, decimals), 15),
      '  ',
      kindColored,
    ].join('');
    lines.push(isProtocol ? c.dim(row) : row);
  });
}

function renderClusters(result: ScanResult, lines: string[]): void {
  if (result.clustering.status !== 'ok') return;
  for (const cluster of result.clustering.data.clusters.slice(0, 3)) {
    const members = cluster.owners.slice(0, 6).map((o) => shortAddr(o)).join(', ');
    const more = cluster.owners.length > 6 ? ` +${cluster.owners.length - 6}` : '';
    lines.push(c.gray(`     ↳ ${cluster.strictClone ? 'clones' : 'cluster'} : ${members}${more}`));
  }
}

function renderReserveDetails(result: ScanResult, lines: string[]): void {
  if (result.reserve.status !== 'ok') return;
  const r = result.reserve.data;
  if (r.marketType === 'none') return;
  lines.push(c.gray(`     Prix spot : ${fmtPrice(r.priceSol)} par token`));
  if (r.bondingCurve && r.marketType === 'bonding-curve') {
    const progress = r.bondingCurveProgressPct ?? 0;
    lines.push(c.gray(`     Progression vers la graduation : ${bar(progress, 20)} ${fmtPct(progress, 1)}`));
  }
  for (const pool of r.pools.slice(0, 3)) {
    lines.push(
      c.gray(`     ↳ ${pool.venue} ${shortAddr(pool.address)} : ${fmtSol(Number(pool.solReserveLamports) / 1e9)}`),
    );
  }
}

/** Rendu complet du rapport (retourne une chaîne multi-lignes). */
export function renderReport(result: ScanResult): string {
  const { token, risk } = result;
  const lines: string[] = [];
  const levelColor = LEVEL_STYLE[risk.level];

  lines.push('');
  lines.push(c.bold(c.cyan('╔' + '═'.repeat(WIDTH - 2) + '╗')));
  lines.push(
    c.bold(c.cyan('║')) +
      padEndVisible(c.bold('  SOLANA TOKEN RISK SCANNER — diagnostic de sécurité on-chain'), WIDTH - 2) +
      c.bold(c.cyan('║')),
  );
  lines.push(c.bold(c.cyan('╚' + '═'.repeat(WIDTH - 2) + '╝')));

  const name = token.name ? `${token.name}${token.symbol ? ` (${token.symbol})` : ''}` : c.gray('inconnu');
  lines.push(`  Token       ${c.bold(name)}`);
  lines.push(`  Mint        ${token.mint}`);
  lines.push(
    `  Programme   ${token.programLabel} · ${token.decimals} décimales · supply ${fmtTokenAmount(token.supply, token.decimals)}`,
  );
  if (result.reserve.status === 'ok') lines.push(`  Marché      ${result.reserve.data.venue}`);
  lines.push('');

  // Score global
  lines.push(rule('SCORE DE RISQUE GLOBAL'));
  const scoreColor = colorForScore(risk.score);
  lines.push(
    `  ${levelColor(`${risk.score} / 100`)}  ${levelColor(`[${risk.level}]`)}  ${scoreColor(bar(risk.score, 40))}`,
  );
  lines.push(`  ${VERDICTS[risk.level]}`);
  const available = risk.modules.filter((m) => m.score !== null).length;
  const confidence = `Confiance ${fmtPct(risk.confidence * 100, 0)} (${available}/${risk.modules.length} modules)`;
  const floorInfo =
    risk.floors.length > 0 && risk.floors[0]!.floor > risk.weightedScore
      ? ` · score pondéré ${fmtNum(risk.weightedScore, 1)} relevé au plancher ${risk.floors[0]!.floor}`
      : ` · score pondéré ${fmtNum(risk.weightedScore, 1)}`;
  lines.push(c.gray(`  ${confidence}${floorInfo}`));
  lines.push('');

  // Détail par module
  for (const module of risk.modules) {
    lines.push(moduleHeader(module));
    if (module.score === null) {
      lines.push(`   ${c.gray('○')} ${c.gray(module.unavailableReason ?? 'module indisponible')}`);
      lines.push('');
      continue;
    }
    if (module.id === 'holders') renderHoldersTable(result, lines);
    renderFindings(module.findings, lines);
    if (module.id === 'clustering') renderClusters(result, lines);
    if (module.id === 'reserve') renderReserveDetails(result, lines);
    lines.push('');
  }

  // Résumé des indicateurs critiques
  lines.push(rule('INDICATEURS CRITIQUES'));
  const alerts = risk.modules
    .flatMap((m) => m.findings.map((f) => ({ ...f, module: m.label })))
    .filter((f) => f.severity === 'critical' || f.severity === 'warning')
    .sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);

  if (alerts.length === 0) {
    lines.push(`   ${ICONS.ok} Aucun indicateur critique ou d'alerte`);
  } else {
    for (const alert of alerts) {
      lines.push(`   ${ICONS[alert.severity]} ${alert.message} ${c.gray(`[${alert.module}]`)}`);
    }
  }
  if (risk.floors.length > 0) {
    lines.push('');
    lines.push(c.gray('   Planchers de score déclenchés :'));
    for (const floor of risk.floors) lines.push(c.gray(`     ≥ ${floor.floor} : ${floor.reason}`));
  }

  lines.push('');
  lines.push(rule());
  lines.push(
    c.gray(
      `  Analyse en ${fmtNum(result.durationMs / 1000, 1)} s · ${fmtNum(result.rpcRequests)} requêtes RPC · ${result.rpcEndpoint} · ${result.generatedAt.toISOString()}`,
    ),
  );
  lines.push(c.gray("  Outil d'aide à la décision fondé sur des heuristiques on-chain — pas un conseil financier."));
  lines.push('');
  return lines.join('\n');
}

/** Sérialisation JSON (bigint → string, Date → ISO). */
export function renderJson(result: ScanResult): string {
  return JSON.stringify(result, (_key, value) => (typeof value === 'bigint' ? value.toString() : value), 2);
}
