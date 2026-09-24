/**
 * Décodage des événements Anchor du programme Pump.fun directement depuis
 * les logs de transaction ("Program data: <base64>").
 *
 * C'est le cœur du chemin rapide : une création de token ou un achat est
 * connu dès la réception de la notification, SANS aucune requête RPC.
 *
 * Layouts (Borsh, après le discriminateur de 8 octets) :
 *   CreateEvent  { name: string, symbol: string, uri: string, mint, bonding_curve, user,
 *                  creator?, timestamp?: i64, virtual_token_reserves?: u64,
 *                  virtual_sol_reserves?: u64, real_token_reserves?: u64, token_total_supply?: u64 }
 *   TradeEvent   { mint, sol_amount: u64, token_amount: u64, is_buy: bool, user,
 *                  timestamp: i64, virtual_sol_reserves: u64, virtual_token_reserves: u64, ... }
 *   CompleteEvent{ user, mint, bonding_curve, timestamp: i64 }
 * Les champs ajoutés par les versions récentes du programme sont lus s'ils sont présents.
 */
import { createHash } from 'node:crypto';
import bs58 from 'bs58';
import { PUMP_FUN_PROGRAM_ID } from '../constants.js';

/** Discriminateur Anchor d'un événement : sha256("event:<Nom>")[0..8]. */
export function anchorEventDiscriminator(name: string): Buffer {
  return createHash('sha256').update(`event:${name}`).digest().subarray(0, 8);
}

const CREATE_DISC = anchorEventDiscriminator('CreateEvent');
const TRADE_DISC = anchorEventDiscriminator('TradeEvent');
const COMPLETE_DISC = anchorEventDiscriminator('CompleteEvent');
/** Préfixe des événements émis par self-CPI (`emit_cpi!`) dans les données d'instruction. */
export const ANCHOR_EVENT_IX_TAG = Buffer.from('e445a52e51cb9a1d', 'hex');

export interface CreateEvent {
  kind: 'create';
  /** Clé de recherche rapide du mint (base64 des 32 octets, sans encodage base58). */
  mintKey: string;
  name: string;
  symbol: string;
  uri: string;
  mint: string;
  bondingCurve: string;
  /** Signataire de la création (payeur). */
  user: string;
  /** Créateur déclaré (champ récent ; égal à `user` en pratique). */
  creator: string;
  timestamp?: number;
  tokenTotalSupply?: bigint;
}

export interface TradeEvent {
  kind: 'trade';
  /** Clé de recherche rapide du mint (base64 des 32 octets). */
  mintKey: string;
  /** Adresse base58 du mint (encodée à la demande). */
  mint: string;
  /** Clé de recherche rapide du wallet (base64 des 32 octets). */
  userKey: string;
  solAmount: bigint;
  tokenAmount: bigint;
  isBuy: boolean;
  user: string;
  timestamp: number;
  virtualSolReserves: bigint;
  virtualTokenReserves: bigint;
}

export interface CompleteEvent {
  kind: 'complete';
  user: string;
  mint: string;
  bondingCurve: string;
  timestamp: number;
}

export type PumpEvent = CreateEvent | TradeEvent | CompleteEvent;

const MAX_STRING = 512;

/** Lecteur Borsh minimal avec contrôle des bornes. */
class Reader {
  offset = 8;
  constructor(private readonly data: Buffer) {}
  remaining(): number {
    return this.data.length - this.offset;
  }
  private need(len: number) {
    if (this.offset + len > this.data.length) throw new RangeError('événement tronqué');
  }
  pubkey(): string {
    this.need(32);
    const key = bs58.encode(this.data.subarray(this.offset, this.offset + 32));
    this.offset += 32;
    return key;
  }
  /** Clé base64 des 32 octets suivants (≈ 10× plus rapide que base58), sans les consommer. */
  peekKey(): string {
    this.need(32);
    return this.data.toString('base64', this.offset, this.offset + 32);
  }
  string(): string {
    this.need(4);
    const len = this.data.readUInt32LE(this.offset);
    if (len > MAX_STRING) throw new RangeError('chaîne invalide');
    this.offset += 4;
    this.need(len);
    const value = this.data.toString('utf8', this.offset, this.offset + len);
    this.offset += len;
    return value;
  }
  u64(): bigint {
    this.need(8);
    const value = this.data.readBigUInt64LE(this.offset);
    this.offset += 8;
    return value;
  }
  i64(): number {
    this.need(8);
    const value = Number(this.data.readBigInt64LE(this.offset));
    this.offset += 8;
    return value;
  }
  bool(): boolean {
    this.need(1);
    return this.data.readUInt8(this.offset++) === 1;
  }
}

function decodeCreate(data: Buffer): CreateEvent {
  const r = new Reader(data);
  const name = r.string();
  const symbol = r.string();
  const uri = r.string();
  const mintKey = r.peekKey();
  const mint = r.pubkey();
  const bondingCurve = r.pubkey();
  const user = r.pubkey();
  const event: CreateEvent = { kind: 'create', mintKey, name, symbol, uri, mint, bondingCurve, user, creator: user };
  if (r.remaining() >= 32) event.creator = r.pubkey();
  if (r.remaining() >= 8) event.timestamp = r.i64();
  if (r.remaining() >= 32) {
    r.u64(); // virtual_token_reserves
    r.u64(); // virtual_sol_reserves
    r.u64(); // real_token_reserves
    event.tokenTotalSupply = r.u64();
  }
  return event;
}

/**
 * TradeEvent à décodage paresseux : l'immense majorité des trades concerne
 * des tokens non suivis, dont on n'a besoin que de la clé du mint. Les
 * adresses base58 (mint, user) ne sont calculées qu'à la première lecture.
 */
class LazyTradeEvent implements TradeEvent {
  readonly kind = 'trade' as const;
  readonly mintKey: string;
  readonly solAmount: bigint;
  readonly tokenAmount: bigint;
  readonly isBuy: boolean;
  readonly timestamp: number;
  readonly virtualSolReserves: bigint;
  readonly virtualTokenReserves: bigint;
  #mint?: string;
  #user?: string;
  #userKey?: string;

  constructor(private readonly data: Buffer) {
    if (data.length < 113) throw new RangeError('événement tronqué');
    this.mintKey = data.toString('base64', 8, 40);
    this.solAmount = data.readBigUInt64LE(40);
    this.tokenAmount = data.readBigUInt64LE(48);
    this.isBuy = data.readUInt8(56) === 1;
    this.timestamp = Number(data.readBigInt64LE(89));
    this.virtualSolReserves = data.readBigUInt64LE(97);
    this.virtualTokenReserves = data.readBigUInt64LE(105);
  }
  get mint(): string {
    return (this.#mint ??= bs58.encode(this.data.subarray(8, 40)));
  }
  get user(): string {
    return (this.#user ??= bs58.encode(this.data.subarray(57, 89)));
  }
  get userKey(): string {
    return (this.#userKey ??= this.data.toString('base64', 57, 89));
  }
}

function decodeTrade(data: Buffer): TradeEvent {
  return new LazyTradeEvent(data);
}

function decodeComplete(data: Buffer): CompleteEvent {
  const r = new Reader(data);
  return { kind: 'complete', user: r.pubkey(), mint: r.pubkey(), bondingCurve: r.pubkey(), timestamp: r.i64() };
}

/** Décode un événement Pump.fun (discriminateur + Borsh) ; null si inconnu ou invalide. */
export function decodePumpEvent(data: Buffer): PumpEvent | null {
  if (data.length < 8) return null;
  try {
    if (data.compare(CREATE_DISC, 0, 8, 0, 8) === 0) return decodeCreate(data);
    if (data.compare(TRADE_DISC, 0, 8, 0, 8) === 0) return decodeTrade(data);
    if (data.compare(COMPLETE_DISC, 0, 8, 0, 8) === 0) return decodeComplete(data);
  } catch {
    return null;
  }
  return null;
}

export interface ParsedLogs {
  events: PumpEvent[];
  /** Une instruction Create a été exécutée (même si son événement est illisible). */
  sawCreate: boolean;
  /** Les logs ont été tronqués par le runtime (limite de 10 Ko). */
  truncated: boolean;
}

const PUMP_ID = PUMP_FUN_PROGRAM_ID.toBase58();
const DATA_PREFIX = 'Program data: ';
const INVOKE_PREFIX = `Program ${PUMP_ID} invoke`;

/**
 * Extrait les événements Pump.fun d'une liste de logs. Une pile d'appels
 * attribue chaque ligne "Program data:" au programme en cours d'exécution :
 * seuls les événements émis par Pump.fun lui-même sont retenus (d'autres
 * programmes Anchor peuvent émettre un "TradeEvent" homonyme).
 */
export function parsePumpLogs(logs: readonly string[]): ParsedLogs {
  const events: PumpEvent[] = [];
  const stack: string[] = [];
  let sawCreate = false;
  let truncated = false;

  for (const line of logs) {
    if (line.startsWith(DATA_PREFIX)) {
      if (stack[stack.length - 1] !== PUMP_ID) continue;
      const event = decodePumpEvent(Buffer.from(line.slice(DATA_PREFIX.length), 'base64'));
      if (event) events.push(event);
    } else if (line.startsWith('Program log: ')) {
      if (line.startsWith('Instruction: Create', 13) && stack[stack.length - 1] === PUMP_ID) sawCreate = true;
    } else if (line.startsWith('Program ')) {
      // "Program <id> invoke [n]" | "Program <id> success" | "Program <id> failed: ..."
      const space = line.indexOf(' ', 8);
      if (space === -1) continue;
      const programId = line.slice(8, space);
      if (programId.endsWith(':')) continue; // "Program return:", "Program consumption:"...
      const rest = line.slice(space + 1);
      if (rest.startsWith('invoke')) stack.push(programId);
      else if (rest.startsWith('success') || rest.startsWith('failed')) stack.pop();
    } else if (line === 'Log truncated') {
      truncated = true;
    }
  }
  return { events, sawCreate, truncated };
}

/** Vrai si les logs mentionnent un appel au programme Pump.fun (pré-filtre rapide). */
export const mentionsPump = (logs: readonly string[]): boolean => logs.some((l) => l.startsWith(INVOKE_PREFIX));
