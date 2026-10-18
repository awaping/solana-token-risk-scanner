/**
 * Page « Historique des analyses » : tous les tokens analysés, et pour chacun
 * l'évolution de sa note (courbe + tableau de chaque analyse) et le détail
 * complet de la dernière analyse. Lecture seule, depuis chrome.storage.local ;
 * se met à jour en direct quand une analyse ou une actualisation arrive.
 */
import { chromeLocalStore } from './chrome-store.js';
import { HistoryStore, type CoinHistory, type CoinSummary, type Level, type ScanPoint } from './history-store.js';
import { safeUrl, twitterLabel, type TwitterLink } from './socials.js';

const store = new HistoryStore(chromeLocalStore());
const app = document.getElementById('app')!;
const SVG = 'http://www.w3.org/2000/svg';

// ---------------------------------------------------------------------------
// Utilitaires d'affichage
// ---------------------------------------------------------------------------

type Child = Node | string | null | undefined | false;

function h(tag: string, attrs: Record<string, string> = {}, ...children: Child[]): HTMLElement {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === 'class') node.className = value;
    else node.setAttribute(key, value);
  }
  for (const child of children) if (child !== null && child !== undefined && child !== false) node.append(child);
  return node;
}

function s(tag: string, attrs: Record<string, string | number> = {}): SVGElement {
  const node = document.createElementNS(SVG, tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
  return node;
}

const nf = (value: number | undefined, digits = 1) =>
  value === undefined || !Number.isFinite(value) ? '–' : value.toLocaleString('fr-FR', { maximumFractionDigits: digits, minimumFractionDigits: 0 });
const pct = (value: number | undefined) => (value === undefined ? '–' : `${nf(value, 1)} %`);
const short = (address: string) => `${address.slice(0, 4)}…${address.slice(-4)}`;
const levelClass = (level: Level) => (level === 'ROUGE' ? 'b-rouge' : level === 'ORANGE' ? 'b-orange' : 'b-vert');
const badge = (level: Level, score?: number) => h('span', { class: `badge ${levelClass(level)}` }, score === undefined ? level : `${score} · ${level}`);

function dateTime(at: number): string {
  return new Date(at).toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function timeAgo(at: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 60) return "à l'instant";
  if (s < 3600) return `il y a ${Math.round(s / 60)} min`;
  if (s < 86_400) return `il y a ${Math.round(s / 3600)} h`;
  return `il y a ${Math.round(s / 86_400)} j`;
}

/** Variation de note : rouge si le risque monte, vert s'il baisse. */
function delta(now: number, before: number): HTMLElement {
  const diff = now - before;
  if (diff === 0) return h('span', { class: 'flat' }, '±0');
  return h('span', { class: diff > 0 ? 'up' : 'down' }, diff > 0 ? `+${diff}` : String(diff));
}

function download(name: string, data: unknown): void {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  const a = h('a', { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

const stamp = () => new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');

// ---------------------------------------------------------------------------
// Graphiques
// ---------------------------------------------------------------------------

/** Mini-courbe des notes successives (liste des tokens). */
function sparkline(scores: number[]): SVGElement {
  const width = 84;
  const height = 22;
  const svg = s('svg', { width, height, viewBox: `0 0 ${width} ${height}`, role: 'img' });
  const title = s('title');
  title.textContent = `Notes successives : ${scores.join(' → ')}`;
  svg.append(title);
  const x = (i: number) => (scores.length === 1 ? width / 2 : 2 + (i * (width - 4)) / (scores.length - 1));
  const y = (score: number) => 2 + ((100 - score) * (height - 4)) / 100;
  if (scores.length > 1) {
    svg.append(s('polyline', { points: scores.map((v, i) => `${x(i)},${y(v)}`).join(' '), fill: 'none', stroke: 'var(--series)', 'stroke-width': 1.5, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
  }
  const last = scores.length - 1;
  svg.append(s('circle', { cx: x(last), cy: y(scores[last]!), r: 2.5, fill: 'var(--series)' }));
  return svg;
}

const BANDS: Array<{ from: number; to: number; label: Level; color: string }> = [
  { from: 0, to: 30, label: 'VERT', color: 'var(--vert)' },
  { from: 30, to: 70, label: 'ORANGE', color: 'var(--orange)' },
  { from: 70, to: 100, label: 'ROUGE', color: 'var(--rouge)' },
];

/**
 * Courbe de la note dans le temps, sur fond des trois zones de risque. Une seule
 * série (le titre la nomme) ; survol : réticule + infobulle avec la note exacte.
 */
function scoreChart(scans: ScanPoint[]): HTMLElement {
  const box = h('div', { class: 'chart' });
  const draw = () => {
    box.replaceChildren();
    const width = Math.max(320, box.clientWidth || 700);
    const height = 220;
    const m = { top: 10, right: 72, bottom: 26, left: 34 };
    const plotW = width - m.left - m.right;
    const plotH = height - m.top - m.bottom;
    const t0 = scans[0]!.at;
    const t1 = scans[scans.length - 1]!.at;
    const x = (at: number) => m.left + (t1 === t0 ? plotW / 2 : ((at - t0) / (t1 - t0)) * plotW);
    const y = (score: number) => m.top + ((100 - score) / 100) * plotH;

    const svg = s('svg', { width, height, viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-label': 'Note de risque dans le temps' });
    for (const band of BANDS) {
      svg.append(s('rect', { x: m.left, y: y(band.to), width: plotW, height: y(band.from) - y(band.to), fill: band.color, 'fill-opacity': 0.07 }));
      const label = s('text', { x: m.left + plotW + 18, y: (y(band.from) + y(band.to)) / 2 + 4, fill: 'var(--muted)', 'font-size': 11 });
      label.textContent = band.label;
      svg.append(s('rect', { x: m.left + plotW + 8, y: (y(band.from) + y(band.to)) / 2 - 4, width: 7, height: 7, rx: 2, fill: band.color }));
      svg.append(label);
    }
    for (const tick of [0, 30, 70, 100]) {
      svg.append(s('line', { x1: m.left, x2: m.left + plotW, y1: y(tick), y2: y(tick), stroke: 'var(--border)', 'stroke-dasharray': tick === 0 || tick === 100 ? '' : '3 3' }));
      const text = s('text', { x: m.left - 6, y: y(tick) + 4, fill: 'var(--muted)', 'font-size': 11, 'text-anchor': 'end' });
      text.textContent = String(tick);
      svg.append(text);
    }
    const timeLabels = t1 === t0 ? [t0] : [t0, t1];
    timeLabels.forEach((at, i) => {
      const text = s('text', { x: x(at), y: height - 8, fill: 'var(--muted)', 'font-size': 11, 'text-anchor': timeLabels.length === 1 ? 'middle' : i === 0 ? 'start' : 'end' });
      text.textContent = dateTime(at);
      svg.append(text);
    });

    if (scans.length > 1) {
      svg.append(s('polyline', { points: scans.map((p) => `${x(p.at)},${y(p.score)}`).join(' '), fill: 'none', stroke: 'var(--series)', 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
    }
    for (const point of scans) {
      svg.append(s('circle', { cx: x(point.at), cy: y(point.score), r: 4, fill: 'var(--series)', stroke: 'var(--panel)', 'stroke-width': 2 }));
    }

    // Survol : la zone de détection couvre toute la largeur, pas seulement les points.
    const cross = s('line', { y1: m.top, y2: m.top + plotH, stroke: 'var(--text-2)', 'stroke-width': 1, visibility: 'hidden' });
    const focus = s('circle', { r: 6, fill: 'var(--series)', stroke: 'var(--text)', 'stroke-width': 2, visibility: 'hidden' });
    const hit = s('rect', { x: m.left, y: m.top, width: plotW, height: plotH, fill: 'transparent' });
    svg.append(cross, focus, hit);
    const tip = h('div', { class: 'tip' });
    tip.style.visibility = 'hidden';
    hit.addEventListener('mousemove', (event) => {
      const rect = svg.getBoundingClientRect();
      const px = ((event as MouseEvent).clientX - rect.left) * (width / rect.width);
      let index = 0;
      scans.forEach((p, i) => {
        if (Math.abs(x(p.at) - px) < Math.abs(x(scans[index]!.at) - px)) index = i;
      });
      const point = scans[index]!;
      const cx = x(point.at);
      cross.setAttribute('x1', String(cx));
      cross.setAttribute('x2', String(cx));
      focus.setAttribute('cx', String(cx));
      focus.setAttribute('cy', String(y(point.score)));
      cross.setAttribute('visibility', 'visible');
      focus.setAttribute('visibility', 'visible');
      const previous = scans[index - 1];
      tip.replaceChildren(
        h('div', { class: 'muted' }, dateTime(point.at)),
        h('div', {}, `Note ${point.score} · ${point.level}`, previous ? ' (' : '', previous ? delta(point.score, previous.score) : '', previous ? ')' : ''),
        h('div', { class: 'muted' }, `Couverture ${Math.round(point.coverage * 100)} %`),
      );
      tip.style.visibility = 'visible';
      const left = (cx / width) * rect.width;
      tip.style.left = `${Math.min(rect.width - 170, Math.max(0, left + 12))}px`;
      tip.style.top = `${(y(point.score) / height) * rect.height - 10}px`;
    });
    hit.addEventListener('mouseleave', () => {
      cross.setAttribute('visibility', 'hidden');
      focus.setAttribute('visibility', 'hidden');
      tip.style.visibility = 'hidden';
    });
    box.append(svg, tip);
  };
  requestAnimationFrame(draw);
  new ResizeObserver(() => draw()).observe(box);
  return box;
}

// ---------------------------------------------------------------------------
// Vues
// ---------------------------------------------------------------------------

let query = '';

async function renderList(): Promise<void> {
  const coins = await store.list();
  const search = h('input', { type: 'search', placeholder: 'Filtrer : symbole, nom ou adresse', value: query }) as HTMLInputElement;
  const exportAll = h('button', {}, 'Exporter tout (JSON)');
  exportAll.addEventListener('click', async () => download(`historique-analyses-${stamp()}.json`, await store.exportAll()));
  const clear = h('button', { class: 'danger' }, 'Tout effacer');
  clear.addEventListener('click', async () => {
    if (confirm(`Effacer l'historique de ${coins.length} token(s) ? Cette action est définitive.`)) {
      await store.clear();
      void route();
    }
  });

  const body = h('tbody');
  const fill = () => {
    const q = query.trim().toLowerCase();
    const rows = coins.filter((c) => !q || [c.symbol, c.name, c.mint].some((v) => v?.toLowerCase().includes(q)));
    body.replaceChildren(...rows.map(row));
    if (rows.length === 0) body.append(h('tr', {}, h('td', { colspan: '7', class: 'muted' }, coins.length ? 'Aucun token ne correspond au filtre.' : '')));
  };
  search.addEventListener('input', () => {
    query = search.value;
    fill();
  });

  // Mise à jour en direct pendant une saisie dans le filtre : on rend le focus au champ.
  const typing = document.activeElement instanceof HTMLInputElement && document.activeElement.type === 'search';
  app.replaceChildren(
    h('header', {}, h('h1', {}, 'Historique des analyses'), h('span', { class: 'sub' }, `${coins.length} token(s) suivis`), h('span', { class: 'spacer' }), search, exportAll, clear),
    coins.length === 0
      ? h('div', { class: 'empty' }, "Aucune analyse enregistrée pour l'instant. Ouvre un token sur pump.fun, Axiom, GMGN… : chaque analyse et chaque actualisation apparaîtront ici.")
      : h(
          'div',
          { class: 'table-wrap' },
          h(
            'table',
            {},
            h('thead', {}, h('tr', {}, ...['Token', 'Note', 'Évolution', 'Tendance', 'Analyses', 'Dernière', 'Première'].map((t, i) => h('th', { class: i === 4 ? 'num' : '' }, t)))),
            body,
          ),
        ),
  );
  fill();
  if (typing) {
    search.focus();
    search.setSelectionRange(search.value.length, search.value.length);
  }
}

function row(coin: CoinSummary): HTMLElement {
  const tr = h(
    'tr',
    { class: 'click', title: coin.mint },
    h('td', {}, h('strong', {}, coin.symbol || short(coin.mint)), ' ', h('span', { class: 'muted' }, coin.name ?? '')),
    h('td', {}, badge(coin.lastLevel, coin.lastScore)),
    h('td', {}, `${coin.firstScore} → ${coin.lastScore} (`, delta(coin.lastScore, coin.firstScore), ')'),
    h('td', {}, sparkline(coin.trend)),
    h('td', { class: 'num' }, String(coin.count)),
    h('td', {}, timeAgo(coin.lastSeen)),
    h('td', { class: 'muted' }, dateTime(coin.firstSeen)),
  );
  tr.addEventListener('click', () => {
    location.hash = encodeURIComponent(coin.mint);
  });
  return tr;
}

const SEVERITY_ICON: Record<string, string> = { critical: '✖', warning: '▲', info: '•', ok: '✔' };

async function renderCoin(mint: string): Promise<void> {
  const coin = await store.get(mint);
  if (!coin) {
    app.replaceChildren(h('p', {}, h('a', { href: '#' }, '‹ Tous les tokens')), h('div', { class: 'empty' }, 'Ce token ne figure pas (ou plus) dans l’historique.'));
    return;
  }
  const scans = coin.scans;
  const first = scans[0]!;
  const last = scans[scans.length - 1]!;
  const d = coin.latest;

  const exportOne = h('button', {}, 'Exporter ce token (JSON)');
  exportOne.addEventListener('click', () => download(`historique-${coin.symbol ?? short(coin.mint)}-${stamp()}.json`, coin));
  const remove = h('button', { class: 'danger' }, "Retirer de l'historique");
  remove.addEventListener('click', async () => {
    if (confirm(`Retirer ${coin.symbol ?? coin.mint} de l'historique ?`)) {
      await store.remove(coin.mint);
      location.hash = '';
    }
  });
  const copy = h('button', {}, 'Copier l’adresse');
  copy.addEventListener('click', () => void navigator.clipboard.writeText(coin.mint).then(() => (copy.textContent = 'Copiée ✔')));

  app.replaceChildren(
    h('p', {}, h('a', { href: '#' }, '‹ Tous les tokens')),
    h('header', {}, h('h1', {}, coin.symbol || short(coin.mint)), h('span', { class: 'sub' }, coin.name ?? ''), h('span', { class: 'spacer' }), copy, exportOne, remove),
    h('div', { class: 'mono muted' }, coin.mint),
    h(
      'div',
      { class: 'links', style: 'margin:6px 0 14px' },
      h('a', { href: `https://pump.fun/coin/${coin.mint}`, target: '_blank', rel: 'noreferrer' }, 'pump.fun'),
      h('a', { href: `https://solscan.io/token/${coin.mint}`, target: '_blank', rel: 'noreferrer' }, 'Solscan'),
      h('a', { href: `https://dexscreener.com/solana/${coin.mint}`, target: '_blank', rel: 'noreferrer' }, 'DexScreener'),
    ),
    ...[socialsBlock(coin)].filter((node): node is HTMLElement => node !== null),
    h(
      'div',
      { class: 'tiles' },
      tile('Note actuelle', badge(last.level, last.score), timeAgo(last.at)),
      tile('Première note', badge(first.level, first.score), dateTime(first.at)),
      tile('Variation depuis la 1re analyse', delta(last.score, first.score), `min ${Math.min(...scans.map((p) => p.score))} · max ${Math.max(...scans.map((p) => p.score))}`),
      tile('Analyses enregistrées', String(scans.length), `suivi depuis ${timeAgo(first.at)}`),
    ),
    h('h2', {}, 'Note de risque dans le temps'),
    h('div', { class: 'card' }, scoreChart(scans)),
    h('h2', {}, 'Chaque analyse'),
    scansTable(scans),
    h('h2', {}, `Dernière analyse en détail · ${dateTime(d.at)}`),
    h(
      'div',
      { class: 'grid2' },
      h('div', { class: 'card' }, ...d.modules.map(moduleBlock), d.floors.length ? h('div', { class: 'muted' }, `Plancher appliqué : ${d.floors[0]!.floor} — ${d.floors[0]!.reason}`) : null),
      h(
        'div',
        {},
        holdersBlock(coin),
        h('h2', {}, 'Marché, créateur, token'),
        h('div', { class: 'card' }, factsBlock(coin)),
      ),
    ),
    h('h2', {}, 'Données brutes'),
    h('details', {}, h('summary', {}, 'Afficher le JSON complet de ce token'), h('pre', {}, JSON.stringify(coin, null, 2))),
  );
}

/** Lien externe http(s) uniquement (le contenu des métadonnées vient du créateur du token). */
function external(url: string | undefined, label: string): HTMLElement | null {
  const href = safeUrl(url);
  return href ? h('a', { href, target: '_blank', rel: 'noreferrer noopener' }, label) : null;
}

/** Dev et réseaux sociaux déclarés par le token (informatif, hors note). */
function socialsBlock(coin: CoinHistory): HTMLElement | null {
  const s = coin.socials;
  if (!s) return null;
  const items: Array<HTMLElement | null> = [
    s.dev
      ? h('span', {}, 'Dev : ', external(`https://pump.fun/profile/${s.dev.address}`, s.dev.username ? `@${s.dev.username}` : short(s.dev.address)), ' (', external(`https://solscan.io/account/${s.dev.address}`, 'Solscan'), ')')
      : null,
    s.twitter ? h('span', {}, 'X : ', external(s.twitter.url, twitterLabel(s.twitter as TwitterLink))) : null,
    external(s.telegram, 'Telegram'),
    s.website ? external(s.website, new URL(s.website).hostname.replace(/^www\./, '')) : null,
  ];
  const present = items.filter((i): i is HTMLElement => i !== null);
  return h(
    'div',
    { class: 'card', style: 'margin:0 0 14px' },
    h(
      'div',
      { class: 'links' },
      ...(present.length
        ? present
        : [h('span', { class: 'muted' }, s.blocked ? `Réseaux non lus : hébergeur ${s.blocked} non autorisé (réglages de l'extension)` : 'Aucun réseau social déclaré par le token')]),
    ),
    s.description ? h('div', { class: 'muted', style: 'margin-top:6px;white-space:normal' }, s.description) : null,
  );
}

function tile(label: string, value: Node | string, note: string): HTMLElement {
  return h('div', { class: 'tile' }, h('div', { class: 'k' }, label), h('div', { class: 'v' }, value), h('div', { class: 'k' }, note));
}

function scansTable(scans: ScanPoint[]): HTMLElement {
  const headers = ['Date', 'Note', 'Évol.', 'Couverture', 'Top 10', 'Plus gros', 'Baleines', 'Holders', 'Réserve (SOL)', 'MCap (SOL)', 'Courbe', 'Créateur', 'Alertes'];
  const rows = [...scans].reverse().map((p, i, all) => {
    const before = all[i + 1];
    const m = p.metrics;
    const alerts = p.alerts.length
      ? h('details', {}, h('summary', {}, `${p.alerts.length}`), ...p.alerts.map((a) => h('div', { class: `sev-${a.severity}` }, `${SEVERITY_ICON[a.severity]} ${a.message}`)))
      : h('span', { class: 'muted' }, '0');
    return h(
      'tr',
      {},
      h('td', {}, dateTime(p.at)),
      h('td', {}, badge(p.level, p.score)),
      h('td', {}, before ? delta(p.score, before.score) : h('span', { class: 'muted' }, '1re')),
      h('td', { class: 'num' }, `${Math.round(p.coverage * 100)} %`),
      h('td', { class: 'num' }, pct(m.top10Pct)),
      h('td', { class: 'num' }, pct(m.maxWalletPct)),
      h('td', { class: 'num' }, m.whales === undefined ? '–' : String(m.whales)),
      h('td', { class: 'num' }, m.holders === undefined ? '–' : nf(m.holders, 0)),
      h('td', { class: 'num' }, nf(m.reserveSol, 2)),
      h('td', { class: 'num' }, nf(m.marketCapSol, 1)),
      h('td', { class: 'num' }, m.curveProgressPct === undefined ? (m.venue ?? '–') : pct(m.curveProgressPct)),
      h('td', { class: 'num' }, pct(m.creatorHoldingPct)),
      h('td', { style: 'white-space:normal;min-width:120px' }, alerts),
    );
  });
  return h('div', { class: 'table-wrap' }, h('table', {}, h('thead', {}, h('tr', {}, ...headers.map((t) => h('th', {}, t)))), h('tbody', {}, ...rows)));
}

function moduleBlock(module: CoinHistory['latest']['modules'][number]): HTMLElement {
  return h(
    'div',
    { class: 'module' },
    h('div', { class: 'title' }, h('span', {}, module.label), h('span', { class: 'muted' }, module.score === null ? 'non analysé' : `${Math.round(module.score)}/100`)),
    module.score === null && module.unavailableReason ? h('div', { class: 'muted' }, module.unavailableReason) : null,
    ...module.findings.map((f) => h('div', { class: 'finding' }, h('span', { class: `ico sev-${f.severity}` }, SEVERITY_ICON[f.severity] ?? '•'), h('span', {}, f.message))),
  );
}

function holdersBlock(coin: CoinHistory): HTMLElement {
  const holders = coin.latest.holders;
  if (!holders?.length) return h('div', { class: 'card muted' }, 'Holders non disponibles pour cette analyse.');
  return h(
    'div',
    { class: 'table-wrap' },
    h(
      'table',
      {},
      h('thead', {}, h('tr', {}, h('th', {}, '#'), h('th', {}, 'Propriétaire'), h('th', {}, 'Type'), h('th', { class: 'num' }, 'Part'))),
      h(
        'tbody',
        {},
        ...holders.map((holder, i) =>
          h(
            'tr',
            {},
            h('td', { class: 'muted' }, String(i + 1)),
            h('td', { class: 'mono' }, h('a', { href: `https://solscan.io/account/${holder.owner}`, target: '_blank', rel: 'noreferrer' }, short(holder.owner))),
            h('td', {}, holder.label ?? holder.kind),
            h('td', { class: 'num' }, pct(holder.pct)),
          ),
        ),
      ),
    ),
  );
}

function factsBlock(coin: CoinHistory): HTMLElement {
  const d = coin.latest;
  const entries: Array<[string, string]> = [];
  if (d.reserve) {
    entries.push(['Marché', d.reserve.venue]);
    entries.push(['Réserve réelle', `${nf(d.reserve.reserveSol, 3)} SOL`]);
    entries.push(['Capitalisation', `${nf(d.reserve.marketCapSol, 1)} SOL`]);
    if (d.reserve.curveProgressPct !== undefined) entries.push(['Bonding curve', pct(d.reserve.curveProgressPct)]);
  }
  if (d.creator) {
    entries.push(['Créateur', d.creator.address]);
    entries.push(['Part du créateur', pct(d.creator.holdingPct)]);
    entries.push(['Autres tokens créés', String(d.creator.previousTokensCreated)]);
    entries.push(['Solde du créateur', `${nf(d.creator.solBalance, 3)} SOL`]);
    entries.push(['Transactions du créateur', `${d.creator.signatureCount}${d.creator.fullHistory ? '' : ' (ou plus)'}`]);
    if (d.creator.walletAgeDays !== undefined) {
      const days = d.creator.walletAgeDays;
      entries.push(['Âge du wallet créateur', days < 2 ? `${nf(days * 24, 1)} h` : `${nf(days, 0)} j`]);
    }
  }
  if (d.dusting) entries.push(['Holders recensés', `${nf(d.dusting.totalHolders, 0)} (poussière ${pct(d.dusting.dustRatio * 100)})`]);
  entries.push(['Programme', `${d.token.program} · ${d.token.decimals} décimales`]);
  entries.push(['Mint authority', d.token.mintAuthority ?? 'révoquée']);
  entries.push(['Freeze authority', d.token.freezeAuthority ?? 'révoquée']);
  if (d.resolvedFrom) entries.push(['Adresse de la page', `${d.resolvedFrom.address} (${d.resolvedFrom.kind})`]);
  entries.push(['Durée de l’analyse', `${nf(d.durationMs / 1000, 1)} s · ${d.rpcRequests} requêtes RPC`]);
  return h('dl', {}, ...entries.flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, v)]));
}

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------

async function route(): Promise<void> {
  const mint = decodeURIComponent(location.hash.slice(1));
  document.title = mint ? 'Historique · token' : 'Historique des analyses';
  if (mint) await renderCoin(mint);
  else await renderList();
}

addEventListener('hashchange', () => void route());
// Une analyse ou une actualisation depuis un onglet met la page à jour en direct.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  const mint = decodeURIComponent(location.hash.slice(1));
  if (!mint || Object.keys(changes).some((k) => k.endsWith(mint))) void route();
});
void route();
