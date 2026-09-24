/**
 * Activité d'un token suivi par le flux : holders, trades, volume, momentum,
 * capitalisation et progression de la bonding curve.
 *
 * Tout est reconstruit à partir des TradeEvent reçus depuis la création : le
 * flux voit chaque achat et chaque vente dès le premier bloc, les soldes par
 * wallet (et donc le nombre de holders) sont exacts sans aucune requête RPC.
 */
import { PUMP_FUN } from '../constants.js';

const MINUTE_MS = 60_000;
const MAX_RECENT = 5_000;
/** Écart constant entre réserves virtuelles et réelles de tokens sur la curve Pump.fun. */
const VIRTUAL_TOKEN_OFFSET = PUMP_FUN.INITIAL_VIRTUAL_TOKEN_RESERVES - PUMP_FUN.INITIAL_REAL_TOKEN_RESERVES;

export interface ActivityState {
  trades: number;
  buys: number;
  sells: number;
  volumeLamports: bigint;
  holders: number;
  /** Solde observé par wallet (clé brute base64 → montant). */
  balances: Map<string, bigint>;
  /** Horodatages (ms) des trades récents, pour le momentum. */
  recent: number[];
  lastTradeAt: number;
  /** Dernières réserves virtuelles publiées (prix spot). */
  virtualSol: bigint;
  virtualToken: bigint;
}

export interface TradeInput {
  userKey: string;
  isBuy: boolean;
  solAmount: bigint;
  tokenAmount: bigint;
  virtualSolReserves: bigint;
  virtualTokenReserves: bigint;
}

export function newActivity(): ActivityState {
  return {
    trades: 0,
    buys: 0,
    sells: 0,
    volumeLamports: 0n,
    holders: 0,
    balances: new Map(),
    recent: [],
    lastTradeAt: 0,
    virtualSol: PUMP_FUN.INITIAL_VIRTUAL_SOL_RESERVES,
    virtualToken: PUMP_FUN.INITIAL_VIRTUAL_TOKEN_RESERVES,
  };
}

/** Applique un trade (O(1) amorti). */
export function applyTrade(a: ActivityState, t: TradeInput, now: number): void {
  a.trades++;
  if (t.isBuy) a.buys++;
  else a.sells++;
  a.volumeLamports += t.solAmount;
  a.lastTradeAt = now;
  if (t.virtualTokenReserves > 0n) {
    a.virtualSol = t.virtualSolReserves;
    a.virtualToken = t.virtualTokenReserves;
  }

  const previous = a.balances.get(t.userKey) ?? 0n;
  let next = t.isBuy ? previous + t.tokenAmount : previous - t.tokenAmount;
  if (next < 0n) next = 0n; // tokens reçus hors curve (transfert) : solde inconnu, borné à 0
  if (previous === 0n && next > 0n) a.holders++;
  else if (previous > 0n && next === 0n) a.holders--;
  if (next === 0n) a.balances.delete(t.userKey);
  else a.balances.set(t.userKey, next);

  a.recent.push(now);
  if (a.recent.length > MAX_RECENT || a.recent[0]! < now - MINUTE_MS) trimRecent(a, now);
}

function trimRecent(a: ActivityState, now: number): void {
  let i = 0;
  while (i < a.recent.length && a.recent[i]! < now - MINUTE_MS) i++;
  if (a.recent.length - i > MAX_RECENT) i = a.recent.length - MAX_RECENT;
  if (i > 0) a.recent.splice(0, i);
}

/** Nombre de trades sur la dernière minute. */
export function tradesLastMinute(a: ActivityState, now: number): number {
  trimRecent(a, now);
  return a.recent.length;
}

export interface MarketMetrics {
  priceSol: number;
  marketCapSol: number;
  /** Progression de la bonding curve vers la graduation (0-100). */
  progressPct: number;
  volumeSol: number;
}

export function marketMetrics(a: ActivityState, supply: bigint): MarketMetrics {
  const vSol = Number(a.virtualSol) / 1e9;
  const vTok = Number(a.virtualToken);
  const priceSol = vTok > 0 ? (vSol * 1e6) / vTok : 0;
  const realToken = a.virtualToken - VIRTUAL_TOKEN_OFFSET;
  const sold = PUMP_FUN.INITIAL_REAL_TOKEN_RESERVES - (realToken > 0n ? realToken : 0n);
  const progressPct = Math.min(100, Math.max(0, (Number(sold) / Number(PUMP_FUN.INITIAL_REAL_TOKEN_RESERVES)) * 100));
  return {
    priceSol,
    marketCapSol: priceSol * (Number(supply) / 1e6),
    progressPct,
    volumeSol: Number(a.volumeLamports) / 1e9,
  };
}

export interface Concentration {
  holders: number;
  /** Part de la supply totale détenue par le plus gros wallet (%). */
  top1Pct: number;
  /** Part de la supply totale détenue par les 10 plus gros wallets (%). */
  top10Pct: number;
  top1IsDev: boolean;
  /** Part détenue par le(s) wallet(s) du dev (%). */
  devPct: number;
}

/** Concentration réelle calculée sur les soldes observés (O(n log n)). */
export function concentration(a: ActivityState, supply: bigint, devKeys: ReadonlySet<string>): Concentration {
  const toPct = (amount: bigint) => (supply === 0n ? 0 : Number((amount * 100_000_000n) / supply) / 1_000_000);
  const entries = [...a.balances.entries()].sort((x, y) => (y[1] > x[1] ? 1 : y[1] < x[1] ? -1 : 0));
  let top10 = 0n;
  for (let i = 0; i < Math.min(10, entries.length); i++) top10 += entries[i]![1];
  let dev = 0n;
  for (const key of devKeys) dev += a.balances.get(key) ?? 0n;
  const top = entries[0];
  return {
    holders: a.holders,
    top1Pct: top ? toPct(top[1]) : 0,
    top10Pct: toPct(top10),
    top1IsDev: top ? devKeys.has(top[0]) : false,
    devPct: toPct(dev),
  };
}
