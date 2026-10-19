/**
 * Page « Historique des analyses » : tous les tokens analysés, et pour chacun
 * l'évolution de sa note (courbe + tableau de chaque analyse) et le détail
 * complet de la dernière analyse. Lecture seule, depuis chrome.storage.local ;
 * se met à jour en direct quand une analyse ou une actualisation arrive.
 */
import { formatAge } from '../../src/utils/age.js';
import { chromeLocalStore } from './chrome-store.js';
import { HistoryStore, type CoinHistory, type CoinSummary, type Level, type PaperSummary, type ScanPoint, type ScanTrigger } from './history-store.js';
import { coinOutcome, compareGroups, ENTRY_METRICS, GROUPS, paperTotals, type ComparisonResult, type CoinOutcome, type MarketOutcome } from './paper-analysis.js';
import { formatAmount, formatPct, type PaperAmount } from './paper.js';
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

function download(name: string, data: unknown, type = 'application/json'): void {
  const text = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = h('a', { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

const stamp = () => new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');

/** Préférences d'affichage de ce navigateur (filtres) ; sans stockage, valeurs par défaut. */
const prefs = {
  get(key: string, fallback: boolean): boolean {
    try {
      const value = localStorage.getItem(`history:${key}`);
      return value === null ? fallback : value === '1';
    } catch {
      return fallback;
    }
  },
  set(key: string, value: boolean): void {
    try {
      localStorage.setItem(`history:${key}`, value ? '1' : '0');
    } catch {
      // stockage indisponible (navigation privée) : le filtre vaut pour cette page seulement
    }
  },
};

function option(key: string, label: string, fallback: boolean, onChange: (checked: boolean) => void): HTMLElement {
  const input = h('input', { type: 'checkbox' }) as HTMLInputElement;
  input.checked = prefs.get(key, fallback);
  input.addEventListener('change', () => {
    prefs.set(key, input.checked);
    onChange(input.checked);
  });
  return h('label', { class: 'opt' }, input, label);
}

/** Montant paper ; signé et coloré (gain vert, perte rouge) pour un PnL. */
function money(amount: PaperAmount | undefined, signed = false): HTMLElement | string {
  if (!amount) return '–';
  if (!signed) return formatAmount(amount);
  return h('span', { class: amount.value > 0 ? 'gain' : amount.value < 0 ? 'loss' : 'flat' }, formatAmount(amount, true));
}

const pctSpan = (value: number) => h('span', { class: value > 0 ? 'gain' : value < 0 ? 'loss' : 'flat' }, formatPct(value));

/** Sommes par unité : « +1,2 SOL · −45 $ ». */
function sums(values: Record<string, number>, signed = false): HTMLElement {
  const entries = Object.entries(values);
  if (entries.length === 0) return h('span', { class: 'muted' }, '–');
  const box = h('span', {});
  entries.forEach(([unit, value], i) => {
    if (i) box.append(' · ');
    box.append(money({ value, unit: unit as PaperAmount['unit'] }, signed));
  });
  return box;
}

const MARKET_LABEL: Record<MarketOutcome, string> = { run: 'run', rug: 'rug', neutre: 'neutre', 'en cours': 'suivi en cours', inconnu: 'issue inconnue' };

function marketTag(market: MarketOutcome, peakX?: number, thenRug?: boolean): HTMLElement {
  const text = market === 'run' ? `run ×${nf(peakX, 1)}${thenRug ? ' puis rug' : ''}` : MARKET_LABEL[market];
  return h('span', { class: `tag ${market === 'run' ? 'run' : market === 'rug' ? 'rug' : ''}`, title: 'Capitalisation après l’achat : run = ×2 ou plus, rug = −70 % ou plus' }, text);
}

const TRIGGER_LABEL: Record<ScanTrigger, string> = { ouverture: 'ouverture', actualisation: 'actualisation', entrée: 'achat (IN)', suivi: 'suivi auto' };
const age = (seconds: number | undefined) => (seconds === undefined ? '–' : formatAge(seconds));

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
function scoreChart(scans: ScanPoint[], markers: Array<{ at: number; label: string; color: string }> = []): HTMLElement {
  const box = h('div', { class: 'chart' });
  const draw = () => {
    box.replaceChildren();
    const width = Math.max(320, box.clientWidth || 700);
    const height = 220;
    const m = { top: 10, right: 72, bottom: 26, left: 34 };
    const plotW = width - m.left - m.right;
    const plotH = height - m.top - m.bottom;
    const times = [...scans.map((p) => p.at), ...markers.map((mk) => mk.at)];
    const t0 = Math.min(...times);
    const t1 = Math.max(...times);
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

    // Achat et vente paper : repères verticaux, pour lire la note au moment du IN et du OUT.
    for (const marker of markers) {
      svg.append(s('line', { x1: x(marker.at), x2: x(marker.at), y1: m.top, y2: m.top + plotH, stroke: marker.color, 'stroke-width': 1.5, 'stroke-dasharray': '4 3' }));
      const text = s('text', { x: x(marker.at) + 4, y: m.top + 12, fill: marker.color, 'font-size': 11, 'font-weight': 700 });
      text.textContent = marker.label;
      svg.append(text);
    }
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
        h('div', { class: 'muted' }, `Couverture ${Math.round(point.coverage * 100)} %${point.trigger ? ` · ${TRIGGER_LABEL[point.trigger]}` : ''}${point.tokenAgeSec !== undefined ? ` · âge ${formatAge(point.tokenAgeSec)}` : ''}`),
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
  const analysis = h('a', { class: 'btn primary', href: '#analyse' }, 'Paper trading & analyse ›');

  let hideDead = prefs.get('hide-dead', true);
  let onlyPaper = prefs.get('only-paper', false);
  const dead = coins.filter((c) => c.deadAtOpen).length;
  const traded = coins.filter((c) => c.paper).length;

  const body = h('tbody');
  const fill = () => {
    const q = query.trim().toLowerCase();
    const rows = coins
      .filter((c) => !q || [c.symbol, c.name, c.mint].some((v) => v?.toLowerCase().includes(q)))
      .filter((c) => !(hideDead && c.deadAtOpen))
      .filter((c) => !onlyPaper || c.paper);
    body.replaceChildren(...rows.map(row));
    if (rows.length === 0) body.append(h('tr', {}, h('td', { colspan: '8', class: 'muted' }, coins.length ? 'Aucun token ne correspond aux filtres.' : '')));
  };
  search.addEventListener('input', () => {
    query = search.value;
    fill();
  });

  // Mise à jour en direct pendant une saisie dans le filtre : on rend le focus au champ.
  const typing = document.activeElement instanceof HTMLInputElement && document.activeElement.type === 'search';
  app.replaceChildren(
    h('header', {}, h('h1', {}, 'Historique des analyses'), h('span', { class: 'sub' }, `${coins.length} token(s) suivis`), h('span', { class: 'spacer' }), analysis, search, exportAll, clear),
    coins.length === 0
      ? h('div', { class: 'empty' }, "Aucune analyse enregistrée pour l'instant. Ouvre un token sur pump.fun, Axiom, GMGN… : chaque analyse et chaque actualisation apparaîtront ici.")
      : h(
          'div',
          {},
          h(
            'div',
            { class: 'links', style: 'margin:0 0 10px;gap:18px' },
            option('hide-dead', `Masquer les coins déjà rug à l'ouverture (${dead})`, true, (v) => ((hideDead = v), fill())),
            option('only-paper', `Seulement mes trades paper (${traded})`, false, (v) => ((onlyPaper = v), fill())),
          ),
          h(
            'div',
            { class: 'table-wrap' },
            h(
              'table',
              {},
              h('thead', {}, h('tr', {}, ...['Token', 'Note', 'Évolution', 'Tendance', 'Paper', 'Analyses', 'Dernière', 'Première'].map((t, i) => h('th', { class: i === 5 ? 'num' : '' }, t)))),
              body,
            ),
          ),
        ),
  );
  fill();
  if (typing) {
    search.focus();
    search.setSelectionRange(search.value.length, search.value.length);
  }
}

function paperCell(p: PaperSummary | undefined): HTMLElement {
  if (!p) return h('span', { class: 'muted' }, '–');
  return h(
    'span',
    {},
    p.bought ? `IN ${formatAmount(p.bought)} · ` : '',
    p.pnl ? money(p.pnl, true) : p.pnlPct !== undefined ? pctSpan(p.pnlPct) : '',
    p.open ? h('span', { class: 'muted' }, ' · ouvert') : '',
  );
}

function row(coin: CoinSummary): HTMLElement {
  const tr = h(
    'tr',
    { class: 'click', title: coin.mint },
    h(
      'td',
      {},
      h('strong', {}, coin.symbol || short(coin.mint)),
      ' ',
      h('span', { class: 'muted' }, coin.name ?? ''),
      coin.deadAtOpen ? ' ' : '',
      coin.deadAtOpen ? h('span', { class: 'tag dead', title: coin.deadAtOpen }, 'déjà rug') : '',
      coin.paper && (coin.paper.market === 'run' || coin.paper.market === 'rug') ? ' ' : '',
      coin.paper && (coin.paper.market === 'run' || coin.paper.market === 'rug') ? marketTag(coin.paper.market, coin.paper.peakX) : '',
    ),
    h('td', {}, badge(coin.lastLevel, coin.lastScore)),
    h('td', {}, `${coin.firstScore} → ${coin.lastScore} (`, delta(coin.lastScore, coin.firstScore), ')'),
    h('td', {}, sparkline(coin.trend)),
    h('td', {}, paperCell(coin.paper)),
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
    ...(coin.deadAtOpen
      ? [h('div', { class: 'notice dead', style: 'margin:8px 0 0' }, `Déjà rug à l'ouverture (${dateTime(coin.deadAtOpen.at)}) — ${coin.deadAtOpen.reason}. Ignoré dans les statistiques paper.`)]
      : []),
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
      tile(
        "Âge du token à l'ouverture",
        first.tokenAgeSec === undefined ? '–' : `${coin.createdExact === false ? '> ' : ''}${formatAge(first.tokenAgeSec)}`,
        coin.createdAt === undefined ? 'date de création inconnue' : `${coin.createdExact === false ? 'créé avant le' : 'créé le'} ${dateTime(coin.createdAt)}`,
      ),
    ),
    ...paperSection(coin),
    h('h2', {}, 'Note de risque dans le temps'),
    h('div', { class: 'card' }, scoreChart(scans, paperMarkers(coin))),
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
  const headers = ['Date', 'Origine', 'Âge du token', 'Note', 'Évol.', 'Couverture', 'Top 10', 'Plus gros', 'Baleines', 'Holders', 'Réserve (SOL)', 'MCap (SOL)', 'Courbe', 'Créateur', 'Alertes'];
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
      h('td', { class: p.trigger === 'entrée' ? '' : 'muted' }, p.trigger ? TRIGGER_LABEL[p.trigger] : '–'),
      h('td', { class: 'num' }, age(p.tokenAgeSec)),
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
// Paper trading
// ---------------------------------------------------------------------------

function paperMarkers(coin: CoinHistory): Array<{ at: number; label: string; color: string }> {
  return (coin.paper?.trades ?? []).map((t) => ({ at: t.at, label: t.kind === 'achat' ? 'IN' : 'OUT', color: t.kind === 'achat' ? 'var(--vert)' : 'var(--orange)' }));
}

/** Position DryFlip du token : montants, âges du token au IN et au OUT, issue, analyse d'achat. */
function paperSection(coin: CoinHistory): HTMLElement[] {
  const paper = coin.paper;
  const outcome = coinOutcome(coin);
  if (!paper || !outcome) return [];
  const latest = paper.latest;
  const buy = outcome.firstBuy;
  const trades = h(
    'div',
    { class: 'table-wrap' },
    h(
      'table',
      {},
      h('thead', {}, h('tr', {}, ...['Date', 'Opération', 'Âge du token', 'Investi (cumul)', 'Vendu (cumul)', 'PnL', 'Note à cet instant', 'Heure'].map((t) => h('th', {}, t)))),
      h(
        'tbody',
        {},
        ...[...paper.trades].reverse().map((t) =>
          h(
            'tr',
            {},
            h('td', {}, dateTime(t.at)),
            h('td', {}, t.kind === 'achat' ? 'Achat (IN)' : t.closes ? 'Vente totale (OUT)' : 'Vente partielle'),
            h('td', { class: 'num' }, age(t.tokenAgeSec)),
            h('td', { class: 'num' }, money(t.bought)),
            h('td', { class: 'num' }, money(t.sold)),
            h('td', { class: 'num' }, t.pnl ? money(t.pnl, true) : t.pnlPct !== undefined ? pctSpan(t.pnlPct) : '–'),
            h('td', {}, t.scan ? badge(t.scan.level, t.scan.score) : h('span', { class: 'muted' }, t.kind === 'achat' ? 'analyse précédente' : '–')),
            h('td', { class: 'muted' }, t.observed ? 'vue en direct' : '1re lecture (déjà ouverte)'),
          ),
        ),
      ),
    ),
  );

  // Données d'achat comparées à la dernière analyse : ce qui a changé depuis le IN.
  const entry = outcome.entry;
  const now = coin.scans[coin.scans.length - 1]!;
  const compare =
    entry && now.at > entry.at
      ? h(
          'div',
          { class: 'table-wrap', style: 'margin-top:10px' },
          h(
            'table',
            {},
            h('thead', {}, h('tr', {}, h('th', {}, 'Donnée'), h('th', { class: 'num' }, `À l'achat${outcome.entryExact ? '' : ' (analyse précédente)'}`), h('th', { class: 'num' }, `Dernière analyse (${timeAgo(now.at)})`))),
            h(
              'tbody',
              {},
              ...ENTRY_METRICS.filter((m) => m.key !== 'age' && m.key !== 'coverage').map((m) => {
                const a = m.get(entry, outcome);
                const b = m.get(now, outcome);
                return a === undefined && b === undefined ? null : h('tr', {}, h('td', {}, m.label), h('td', { class: 'num' }, nf(a, m.digits)), h('td', { class: 'num' }, nf(b, m.digits)));
              }),
            ),
          ),
        )
      : null;

  const followNote =
    outcome.market === 'en cours'
      ? 'ré-analyses automatiques à 5 min, 15 min, 1 h, 4 h et 24 h après l’achat'
      : outcome.lastX !== undefined
        ? `capitalisation : max ×${nf(outcome.peakX, 2)} · dernière ×${nf(outcome.lastX, 2)}`
        : 'pas de capitalisation mesurée';
  return [
    h('h2', {}, 'Paper trading (DryFlip)'),
    h(
      'div',
      { class: 'tiles' },
      tile('Investi (IN)', money(latest.bought), latest.sold?.value ? `vendu ${formatAmount(latest.sold)}` : outcome.open ? 'position ouverte' : 'position soldée'),
      tile('PnL', latest.pnl ? money(latest.pnl, true) : outcome.pnl ? money(outcome.pnl, true) : '–', latest.pnlPct !== undefined ? formatPct(latest.pnlPct) : outcome.open ? 'en direct' : 'final'),
      tile('Issue du token', marketTag(outcome.market, outcome.peakX, outcome.thenRug), followNote),
      tile('Âge du token au IN', age(outcome.entryAgeSec), buy ? (buy.observed ? `achat vu en direct · ${dateTime(buy.at)}` : 'position déjà ouverte à l’ouverture : heure de la 1re lecture') : '–'),
      tile('Âge du token au OUT', age(outcome.exitAgeSec), outcome.holdSec !== undefined ? `détenu ${formatAge(outcome.holdSec)}` : outcome.open ? 'pas encore vendu' : '–'),
      tile('Note au IN', entry ? badge(entry.level, entry.score) : '–', outcome.entryExact ? 'analyse lancée par l’achat' : 'dernière analyse avant l’achat'),
    ),
    h('h2', {}, 'Opérations'),
    trades,
    ...(compare ? [h('h2', {}, 'Depuis l’achat'), compare] : []),
  ];
}

/** Solde DryFlip dans le temps : une courbe, avec ses extrêmes. */
function balanceChart(points: Array<{ at: number; balance: PaperAmount }>): HTMLElement {
  const box = h('div', { class: 'chart' });
  const draw = () => {
    const width = Math.max(280, box.clientWidth || 700);
    const height = 90;
    const values = points.map((p) => p.balance.value);
    const lo = Math.min(...values);
    const hi = Math.max(...values);
    const t0 = points[0]!.at;
    const t1 = points[points.length - 1]!.at;
    const x = (at: number) => 8 + (t1 === t0 ? 0 : ((at - t0) / (t1 - t0)) * (width - 124));
    const y = (v: number) => 10 + (hi === lo ? 35 : ((hi - v) / (hi - lo)) * 70);
    const svg = s('svg', { width, height, viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-label': 'Solde DryFlip dans le temps' });
    svg.append(s('polyline', { points: points.map((p) => `${x(p.at)},${y(p.balance.value)}`).join(' '), fill: 'none', stroke: 'var(--series)', 'stroke-width': 2, 'stroke-linejoin': 'round' }));
    const unit = points[0]!.balance.unit;
    for (const [v, label] of [[hi, 'max'], [lo, 'min']] as const) {
      const text = s('text', { x: width - 8, y: y(v) + 4, fill: 'var(--muted)', 'font-size': 11, 'text-anchor': 'end' });
      text.textContent = `${label} ${formatAmount({ value: v, unit })}`;
      svg.append(text);
    }
    box.replaceChildren(svg);
  };
  requestAnimationFrame(draw);
  new ResizeObserver(() => draw()).observe(box);
  return box;
}

/** Valeur d'une donnée d'achat (l'âge en durée lisible). */
const metricValue = (key: string, value: number | undefined, digits: number) => (key === 'age' ? age(value) : nf(value, digits));

function comparisonBlock(result: ComparisonResult): HTMLElement {
  const groups = GROUPS[result.by];
  if (result.a === 0 || result.b === 0) {
    return h('div', { class: 'notice' }, `Il faut au moins un token dans chaque groupe (${groups.aLabel.toLowerCase()} : ${result.a}, ${groups.bLabel.toLowerCase()} : ${result.b}). La comparaison se remplit au fil des trades et des ré-analyses automatiques.`);
  }
  const small = Math.min(result.a, result.b) < 10;
  const bar = (share: number) => h('span', { class: 'share' }, `${Math.round(share * 100)} %`, h('i', { style: `width:${Math.max(2, share * 60)}px` }));
  return h(
    'div',
    {},
    h(
      'div',
      { class: 'notice' },
      `${groups.aLabel} : ${result.a} token(s) · ${groups.bLabel} : ${result.b} token(s).`,
      small ? " Échantillon encore petit : tendances indicatives, les écarts deviennent parlants à partir d'une dizaine de tokens par groupe." : '',
    ),
    h(
      'div',
      { class: 'grid2' },
      h(
        'div',
        { class: 'table-wrap' },
        h(
          'table',
          {},
          h('thead', {}, h('tr', {}, h('th', {}, 'Médiane à l’achat'), h('th', { class: 'num', title: groups.aLabel }, `${groups.aShort} (${result.a})`), h('th', { class: 'num', title: groups.bLabel }, `${groups.bShort} (${result.b})`))),
          h(
            'tbody',
            {},
            ...result.rows
              .filter((r) => r.na + r.nb > 0)
              .map((r) =>
                h(
                  'tr',
                  {},
                  h('td', {}, r.label),
                  h('td', { class: 'num' }, metricValue(r.key, r.a, r.digits), r.na < result.a ? h('span', { class: 'muted' }, ` · n=${r.na}`) : ''),
                  h('td', { class: 'num' }, metricValue(r.key, r.b, r.digits), r.nb < result.b ? h('span', { class: 'muted' }, ` · n=${r.nb}`) : ''),
                ),
              ),
          ),
        ),
      ),
      h(
        'div',
        { class: 'table-wrap' },
        h(
          'table',
          {},
          h('thead', {}, h('tr', {}, h('th', {}, 'Alerte présente à l’achat'), h('th', { class: 'num', title: groups.aLabel }, groups.aShort), h('th', { class: 'num', title: groups.bLabel }, groups.bShort))),
          h(
            'tbody',
            {},
            ...(result.alerts.length
              ? result.alerts.map((a) => h('tr', {}, h('td', { class: 'wrap' }, a.label), h('td', { class: 'num' }, bar(a.a)), h('td', { class: 'num' }, bar(a.b))))
              : [h('tr', {}, h('td', { colspan: '3', class: 'muted' }, 'Aucune alerte relevée à l’achat dans ces groupes.'))]),
          ),
        ),
      ),
    ),
  );
}

/** Une ligne par trade, pour un tableur (séparateur « ; », décimales à virgule). */
function tradesCsv(rows: Array<{ coin: CoinHistory; outcome: CoinOutcome }>): string {
  const num = (v: number | undefined) => (v === undefined || !Number.isFinite(v) ? '' : String(Math.round(v * 1e6) / 1e6).replace('.', ','));
  const head = ['mint', 'symbole', 'achat', 'achat_vu_en_direct', 'age_au_in_s', 'age_au_out_s', 'detenu_s', 'note_au_in', 'niveau_au_in', 'investi', 'unite', 'pnl', 'pnl_pct', 'resultat', 'issue', 'cap_max_x', 'cap_derniere_x', 'deja_rug', ...ENTRY_METRICS.filter((m) => m.key !== 'score' && m.key !== 'age').map((m) => m.key)];
  const lines = rows.map(({ coin, outcome: o }) => {
    const e = o.entry;
    const cells = [
      coin.mint,
      coin.symbol ?? '',
      o.firstBuy ? new Date(o.firstBuy.at).toISOString() : '',
      o.firstBuy ? (o.firstBuy.observed ? 'oui' : 'non') : '',
      num(o.entryAgeSec),
      num(o.exitAgeSec),
      num(o.holdSec),
      num(e?.score),
      e?.level ?? '',
      num(coin.paper?.latest.bought?.value),
      coin.paper?.latest.bought?.unit ?? '',
      num(o.pnl?.value),
      num(o.pnlPct),
      o.result ?? '',
      o.market,
      num(o.peakX),
      num(o.lastX),
      coin.deadAtOpen ? 'oui' : 'non',
      ...ENTRY_METRICS.filter((m) => m.key !== 'score' && m.key !== 'age').map((m) => (e ? num(m.get(e, o)) : '')),
    ];
    return cells.map((c) => (/[;"\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(';');
  });
  return [head.join(';'), ...lines].join('\n');
}

async function renderAnalysis(): Promise<void> {
  const summaries = await store.list();
  const includeDead = !prefs.get('hide-dead', true);
  const traded = summaries.filter((c) => c.paper);
  const excluded = traded.filter((c) => c.deadAtOpen).length;
  const counted = traded.filter((c) => includeDead || !c.deadAtOpen);
  const [coins, wallet, followUps] = await Promise.all([store.getMany(counted.map((c) => c.mint)), store.wallet(), store.followUps()]);
  const now = Date.now();
  const rows = coins
    .map((coin) => ({ coin, outcome: coinOutcome(coin, now)! }))
    .filter((r) => r.outcome)
    .sort((a, b) => (b.outcome.firstBuy?.at ?? b.coin.paper!.firstAt) - (a.outcome.firstBuy?.at ?? a.coin.paper!.firstAt));
  const totals = paperTotals(summaries, { includeDead });
  const all = totals[0]!;

  const exportCsv = h('button', {}, 'Exporter les trades (CSV)');
  exportCsv.addEventListener('click', () => download(`trades-paper-${stamp()}.csv`, `﻿${tradesCsv(rows)}`, 'text/csv;charset=utf-8'));
  const header = h(
    'header',
    {},
    h('h1', {}, 'Paper trading & analyse'),
    h('span', { class: 'sub' }, `${counted.length} token(s) tradé(s)${excluded && !includeDead ? ` · ${excluded} déjà rug à l'ouverture exclu(s)` : ''}`),
    h('span', { class: 'spacer' }),
    option('hide-dead', "Exclure les coins déjà rug à l'ouverture", true, () => void route()),
    exportCsv,
  );
  const back = h('p', {}, h('a', { href: '#' }, '‹ Tous les tokens'));
  if (traded.length === 0) {
    app.replaceChildren(
      back,
      header,
      h(
        'div',
        { class: 'empty', style: 'text-align:left;line-height:1.7' },
        'Aucun trade paper enregistré pour l’instant. Avec DryFlip installé, ouvre un token sur Axiom, GMGN ou Padre : le panneau lit ta position (IN, PnL, solde). ',
        'À chaque achat, le token est analysé à cet instant précis (âge du token compris), puis ré-analysé à 5 min, 15 min, 1 h, 4 h et 24 h pour savoir s’il a run ou rug. ',
        'Cette page compare alors ce qui distinguait, au moment de l’achat, les tokens qui ont run de ceux qui ont rug, et tes trades gagnants des perdants.',
      ),
    );
    return;
  }

  const rate = all.gains + all.pertes ? Math.round((all.gains / (all.gains + all.pertes)) * 100) : undefined;
  const balance = wallet?.latest.balance;
  const balanceTrend = wallet && wallet.points.length > 1 ? balanceChart(wallet.points) : null;

  const levelRows = totals.map((t) =>
    h(
      'tr',
      {},
      h('td', {}, t.level === 'tous' ? h('strong', {}, 'Tous') : badge(t.level)),
      h('td', { class: 'num' }, String(t.coins)),
      h('td', { class: 'num' }, String(t.gains)),
      h('td', { class: 'num' }, String(t.pertes)),
      h('td', { class: 'num' }, t.gains + t.pertes ? `${Math.round((t.gains / (t.gains + t.pertes)) * 100)} %` : '–'),
      h('td', { class: 'num' }, sums(t.bought)),
      h('td', { class: 'num' }, sums(t.pnl, true)),
      h('td', { class: 'num' }, String(t.markets.run)),
      h('td', { class: 'num' }, String(t.markets.rug)),
    ),
  );

  const tradeRows = rows.map(({ coin, outcome: o }) => {
    const tr = h(
      'tr',
      { class: 'click', title: coin.mint },
      h('td', {}, h('strong', {}, coin.symbol || short(coin.mint)), coin.deadAtOpen ? ' ' : '', coin.deadAtOpen ? h('span', { class: 'tag dead', title: coin.deadAtOpen.reason }, 'déjà rug') : ''),
      h('td', {}, o.firstBuy ? dateTime(o.firstBuy.at) : '–'),
      h('td', { class: 'num' }, age(o.entryAgeSec), o.firstBuy && !o.firstBuy.observed ? h('span', { class: 'muted', title: 'position déjà ouverte à l’ouverture de la page' }, ' *') : ''),
      h('td', {}, o.entry ? badge(o.entry.level, o.entry.score) : '–'),
      h('td', { class: 'num' }, money(coin.paper!.latest.bought)),
      h('td', { class: 'num' }, o.pnl ? money(o.pnl, true) : o.pnlPct !== undefined ? pctSpan(o.pnlPct) : '–'),
      h('td', { class: 'num' }, age(o.exitAgeSec)),
      h('td', { class: 'num' }, o.holdSec === undefined ? (o.open ? h('span', { class: 'muted' }, 'ouvert') : '–') : formatAge(o.holdSec)),
      h('td', {}, marketTag(o.market, o.peakX, o.thenRug)),
    );
    tr.addEventListener('click', () => {
      location.hash = encodeURIComponent(coin.mint);
    });
    return tr;
  });

  app.replaceChildren(
    back,
    header,
    h(
      'div',
      { class: 'tiles' },
      tile('Solde DryFlip', balance ? formatAmount(balance) : '–', wallet ? `lu ${timeAgo(wallet.latest.at)}` : 'carte flottante DryFlip non vue'),
      tile('PnL total', sums(all.pnl, true), `${all.coins} token(s) · ${all.open} position(s) ouverte(s)`),
      tile('Réussite', rate === undefined ? '–' : `${rate} %`, `${all.gains} gagnant(s) · ${all.pertes} perdant(s)`),
      tile('Investi au total', sums(all.bought), 'cumul des montants IN'),
      tile('Issue des tokens', h('span', {}, h('span', { class: 'gain' }, `${all.markets.run} run`), ' · ', h('span', { class: 'loss' }, `${all.markets.rug} rug`)), `${all.markets.neutre} neutre(s) · ${all.markets['en cours']} en cours`),
      tile('Ré-analyses programmées', String(followUps.length), followUps.length ? `prochaine ${timeAgo(Math.min(...followUps.map((f) => f.due)), now).replace('il y a', 'dans').replace("à l'instant", 'maintenant')}` : 'aucune en attente'),
    ),
    ...(balanceTrend ? [h('div', { class: 'card', style: 'margin-top:10px' }, h('div', { class: 'muted' }, `Solde DryFlip dans le temps (${wallet!.points.length} relevés)`), balanceTrend)] : []),
    h('h2', {}, 'Par note de risque au moment de l’achat'),
    h(
      'div',
      { class: 'table-wrap' },
      h(
        'table',
        {},
        h('thead', {}, h('tr', {}, ...['Note au IN', 'Tokens', 'Gagnants', 'Perdants', 'Réussite', 'Investi', 'PnL', 'Run', 'Rug'].map((t, i) => h('th', { class: i ? 'num' : '' }, t)))),
        h('tbody', {}, ...levelRows),
      ),
    ),
    h('h2', {}, 'Run vs rug : ce qui les distinguait au moment de l’achat'),
    comparisonBlock(compareGroups(coins, 'market', now, { includeDead })),
    h('h2', {}, 'Trades gagnants vs perdants'),
    comparisonBlock(compareGroups(coins, 'result', now, { includeDead })),
    h('h2', {}, 'Tous les trades'),
    h(
      'div',
      { class: 'table-wrap' },
      h(
        'table',
        {},
        h('thead', {}, h('tr', {}, ...['Token', 'Achat', 'Âge au IN', 'Note au IN', 'IN', 'PnL', 'Âge au OUT', 'Détenu', 'Issue'].map((t) => h('th', {}, t)))),
        h('tbody', {}, ...tradeRows),
      ),
    ),
    h('p', { class: 'muted' }, '* position déjà ouverte à l’ouverture de la page : âge mesuré à la première lecture. Run = capitalisation ×2 ou plus après l’achat ; rug = −70 % ou plus (ou réserve vidée) ; neutre = ni l’un ni l’autre à 4 h.'),
  );
}

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------

async function route(): Promise<void> {
  const mint = decodeURIComponent(location.hash.slice(1));
  if (mint === 'analyse') {
    document.title = 'Paper trading & analyse';
    await renderAnalysis();
    return;
  }
  document.title = mint ? 'Historique · token' : 'Historique des analyses';
  if (mint) await renderCoin(mint);
  else await renderList();
}

addEventListener('hashchange', () => void route());
// Une analyse ou une actualisation depuis un onglet met la page à jour en direct
// (regroupé : une position DryFlip ouverte écrit toutes les quelques secondes).
let pending: ReturnType<typeof setTimeout> | undefined;
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  const mint = decodeURIComponent(location.hash.slice(1));
  const keys = Object.keys(changes);
  const relevant = mint === 'analyse' || (!mint ? keys.some((k) => k !== 'paper:wallet' && k !== 'paper:followups') : keys.some((k) => k.endsWith(mint)));
  if (!relevant || pending) return;
  pending = setTimeout(() => {
    pending = undefined;
    void route();
  }, 2_000);
});
void route();
