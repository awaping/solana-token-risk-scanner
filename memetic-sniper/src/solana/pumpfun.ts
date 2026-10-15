/**
 * src/solana/pumpfun.ts
 * ---------------------------------------------------------------------------
 * Instructions Pump.fun, derivation des PDA et mathematiques de bonding curve.
 *
 * SOURCE DE VERITE
 * Les tables `CREATE_ACCOUNTS` / `BUY_ACCOUNTS` ci-dessous sont une
 * transcription litterale de l'IDL officiel :
 *   https://github.com/pump-fun/pump-public-docs/blob/main/idl/pump.json
 * Verifie le 2026-09-17. Le programme evolue : quand il evolue, on corrige
 * CES TABLES et rien d'autre. Le builder resout chaque compte par son NOM ;
 * ajouter une ligne a la table sans fournir la cle correspondante leve une
 * erreur explicite au lieu de produire une transaction silencieusement fausse.
 *
 * POURQUOI `create` / `buy` ET PAS `create_v2` / `buy_v2`
 * Les variantes v2 acceptent un quote mint arbitraire et tirent 30+ comptes.
 * Pour un lancement SOL classique, v1 fait le meme travail avec moitie moins
 * de surface et reste supportee. Passer a v2 = ajouter deux tables ici.
 *
 * DISCRIMINANTS
 * Calcules au chargement par sha256("global:<nom>")[0..8], la regle Anchor.
 * Verifie : create=[24,30,200,40,5,28,7,119], buy=[102,6,61,18,1,218,235,234].
 * Aucun nombre magique a resaisir.
 * ---------------------------------------------------------------------------
 */

import { createHash } from 'node:crypto';
import {
  AddressLookupTableAccount,
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import type { Blockhash, Connection } from '@solana/web3.js';
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';

// ---------------------------------------------------------------------------
// Adresses de programmes
// ---------------------------------------------------------------------------

export const PUMP_PROGRAM_ID = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
/** Programme de frais introduit avec les creator fees. */
export const PUMP_FEE_PROGRAM_ID = new PublicKey('pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ');
export const MPL_TOKEN_METADATA_PROGRAM_ID = new PublicKey(
  'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s',
);

/** Limite dure d'un paquet Solana. Une tx plus grosse est rejetee par le reseau. */
export const MAX_TX_BYTES = 1232;

// ---------------------------------------------------------------------------
// Parametres par defaut de la courbe
//
// Valeurs de bootstrap du programme. Elles sont TOUJOURS relues depuis le
// compte `global` on-chain via `fetchGlobal()` ; ces constantes ne servent que
// de repli hors-ligne (tests, simulation sans RPC).
// ---------------------------------------------------------------------------
export const DEFAULT_GLOBAL_PARAMS = {
  initialVirtualTokenReserves: 1_073_000_000_000_000n, // 1.073e9 tokens * 1e6
  initialVirtualSolReserves: 30_000_000_000n, // 30 SOL
  initialRealTokenReserves: 793_100_000_000_000n, // 793.1e6 tokens * 1e6
  tokenTotalSupply: 1_000_000_000_000_000n, // 1e9 tokens * 1e6
  // 95 bps = 0.95 %, releve on-chain le 2026-09-17. Le "1 %" repete partout
  // dans les tutoriels est faux : raison de plus pour ne jamais se fier a
  // cette constante ailleurs qu'en repli hors-ligne.
  feeBasisPoints: 95n,
} as const;

/** Decimales des tokens Pump.fun. Fixe par le programme. */
export const PUMP_TOKEN_DECIMALS = 6;

// ---------------------------------------------------------------------------
// Discriminants Anchor
// ---------------------------------------------------------------------------

function anchorDiscriminator(name: string): Buffer {
  return createHash('sha256').update(`global:${name}`).digest().subarray(0, 8);
}

const IX_CREATE = anchorDiscriminator('create');
const IX_BUY = anchorDiscriminator('buy');
const IX_SELL = anchorDiscriminator('sell');
const IX_COLLECT_CREATOR_FEE = anchorDiscriminator('collect_creator_fee');

// ---------------------------------------------------------------------------
// Derivation de PDA — memoisee
//
// `findProgramAddressSync` fait une verification de courbe ed25519 par bump
// teste : quelques centaines de microsecondes. Multiplie par 6 PDA sur le
// chemin critique du snipe, ca se voit. Les PDA statiques sont calcules une
// fois ; ceux qui dependent d'une cle passent par un cache borne.
// ---------------------------------------------------------------------------

/** Cache FIFO borne : un bot qui tourne des jours ne doit pas fuir de memoire. */
class BoundedCache<V> {
  private readonly map = new Map<string, V>();
  private readonly maxSize: number;
  // Champ explicite plutot qu'une parameter property : le mode strip-only de
  // Node (qui fait tourner ce projet sans etape de build) ne les supporte pas.
  constructor(maxSize: number) {
    this.maxSize = maxSize;
  }
  get(key: string, compute: () => V): V {
    const hit = this.map.get(key);
    if (hit !== undefined) return hit;
    const value = compute();
    if (this.map.size >= this.maxSize) {
      // Map preserve l'ordre d'insertion : la premiere cle est la plus ancienne.
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
    this.map.set(key, value);
    return value;
  }
}

const pdaCache = new BoundedCache<PublicKey>(2000);

function derive(seeds: Array<Buffer | Uint8Array>, programId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(seeds, programId)[0];
}

/** PDA `["global"]`. Statique : calcule une seule fois au chargement. */
export const GLOBAL_PDA = derive([Buffer.from('global')], PUMP_PROGRAM_ID);
/** PDA `["mint-authority"]`. */
export const MINT_AUTHORITY_PDA = derive([Buffer.from('mint-authority')], PUMP_PROGRAM_ID);
/** PDA `["__event_authority"]`. */
export const EVENT_AUTHORITY_PDA = derive([Buffer.from('__event_authority')], PUMP_PROGRAM_ID);
/** PDA `["global_volume_accumulator"]`. */
export const GLOBAL_VOLUME_ACCUMULATOR_PDA = derive(
  [Buffer.from('global_volume_accumulator')],
  PUMP_PROGRAM_ID,
);
/**
 * PDA `["fee_config", <bytes du programme pump>]`, sous PUMP_FEE_PROGRAM_ID.
 * La constante de 32 octets dans l'IDL est bien l'ID du programme pump :
 * verifie octet par octet plutot que recopie.
 */
export const FEE_CONFIG_PDA = derive(
  [Buffer.from('fee_config'), PUMP_PROGRAM_ID.toBytes()],
  PUMP_FEE_PROGRAM_ID,
);

/** PDA `["bonding-curve", mint]`. */
export function deriveBondingCurve(mint: PublicKey): PublicKey {
  return pdaCache.get(`bc:${mint.toBase58()}`, () =>
    derive([Buffer.from('bonding-curve'), mint.toBytes()], PUMP_PROGRAM_ID),
  );
}

/**
 * ATA de la bonding curve. `allowOwnerOffCurve = true` : le proprietaire est un
 * PDA, donc hors courbe ed25519 — sans ce flag la derivation leve une erreur.
 */
export function deriveAssociatedBondingCurve(mint: PublicKey): PublicKey {
  return pdaCache.get(`abc:${mint.toBase58()}`, () =>
    getAssociatedTokenAddressSync(mint, deriveBondingCurve(mint), true),
  );
}

/**
 * PDA `["creator-vault", creator]`.
 * Un seul vault par createur, partage par tous ses tokens.
 */
export function deriveCreatorVault(creator: PublicKey): PublicKey {
  return pdaCache.get(`cv:${creator.toBase58()}`, () =>
    derive([Buffer.from('creator-vault'), creator.toBytes()], PUMP_PROGRAM_ID),
  );
}

/** PDA `["user_volume_accumulator", user]`. */
export function deriveUserVolumeAccumulator(user: PublicKey): PublicKey {
  return pdaCache.get(`uva:${user.toBase58()}`, () =>
    derive([Buffer.from('user_volume_accumulator'), user.toBytes()], PUMP_PROGRAM_ID),
  );
}

/** PDA Metaplex `["metadata", mpl_program, mint]`. */
export function deriveMetadata(mint: PublicKey): PublicKey {
  return pdaCache.get(`md:${mint.toBase58()}`, () =>
    derive(
      [Buffer.from('metadata'), MPL_TOKEN_METADATA_PROGRAM_ID.toBytes(), mint.toBytes()],
      MPL_TOKEN_METADATA_PROGRAM_ID,
    ),
  );
}

// ---------------------------------------------------------------------------
// Compte `global` — lecture des parametres reels
// ---------------------------------------------------------------------------

export interface PumpGlobal {
  initialized: boolean;
  authority: PublicKey;
  /** Destinataire des frais de protocole. A NE PAS coder en dur : il change. */
  feeRecipient: PublicKey;
  initialVirtualTokenReserves: bigint;
  initialVirtualSolReserves: bigint;
  initialRealTokenReserves: bigint;
  tokenTotalSupply: bigint;
  feeBasisPoints: bigint;
}

/**
 * Decode le prefixe STABLE du compte `global`.
 *
 * Le programme a plusieurs fois ajoute des champs APRES `fee_basis_points`
 * (withdraw_authority, creator_fee_basis_points, fee_recipients[7]...).
 * On ne lit donc que le prefixe, qui n'a jamais bouge, et on ignore la queue :
 * un decodeur exhaustif casserait a chaque mise a jour du programme.
 */
export function decodeGlobal(data: Buffer): PumpGlobal {
  const MIN_LEN = 8 + 1 + 32 + 32 + 8 * 5;
  if (data.length < MIN_LEN) {
    throw new Error(`global account too short: ${data.length} < ${MIN_LEN}`);
  }
  let o = 8; // discriminant Anchor
  const initialized = data.readUInt8(o) === 1;
  o += 1;
  const authority = new PublicKey(data.subarray(o, o + 32));
  o += 32;
  const feeRecipient = new PublicKey(data.subarray(o, o + 32));
  o += 32;
  const readU64 = () => {
    const v = data.readBigUInt64LE(o);
    o += 8;
    return v;
  };
  return {
    initialized,
    authority,
    feeRecipient,
    initialVirtualTokenReserves: readU64(),
    initialVirtualSolReserves: readU64(),
    initialRealTokenReserves: readU64(),
    tokenTotalSupply: readU64(),
    feeBasisPoints: readU64(),
  };
}

/**
 * Lit `global` on-chain. A appeler au boot et a rafraichir periodiquement,
 * jamais sur le chemin critique du snipe.
 */
export async function fetchGlobal(connection: Connection): Promise<PumpGlobal> {
  const info = await connection.getAccountInfo(GLOBAL_PDA, 'confirmed');
  if (!info) throw new Error(`pump global account not found at ${GLOBAL_PDA.toBase58()}`);
  if (!info.owner.equals(PUMP_PROGRAM_ID)) {
    throw new Error(`pump global account owned by ${info.owner.toBase58()}, expected the pump program`);
  }
  const global = decodeGlobal(info.data);
  if (!global.initialized) throw new Error('pump global account reports initialized=false');
  return global;
}

// ---------------------------------------------------------------------------
// Mathematiques de la bonding curve
// ---------------------------------------------------------------------------

/**
 * Tokens recus pour `solIn` lamports, produit constant sur reserves virtuelles.
 *
 * Reproduit `get_buy_price` du programme a l'entier pres. Tout est en BigInt :
 * `number` perd de la precision au-dela de 2^53 et les reserves virtuelles
 * valent ~1.07e15 — un calcul en flottant produit un `amount` faux et un buy
 * qui echoue on-chain.
 *
 *   n = vSol * vTok
 *   i = vSol + solIn
 *   r = n / i + 1        <- le +1 est l'arrondi conservateur du programme
 *   out = min(vTok - r, realTok)
 */
export function getBuyAmountOut(
  solIn: bigint,
  virtualSolReserves: bigint,
  virtualTokenReserves: bigint,
  realTokenReserves: bigint,
): bigint {
  if (solIn <= 0n) return 0n;
  const numerator = virtualSolReserves * virtualTokenReserves;
  const denominator = virtualSolReserves + solIn;
  const remaining = numerator / denominator + 1n;
  const out = virtualTokenReserves - remaining;
  if (out <= 0n) return 0n;
  return out < realTokenReserves ? out : realTokenReserves;
}

export interface BuyQuote {
  /** Argument `amount` : tokens demandes (unites de base, 6 decimales). */
  amount: bigint;
  /** Argument `max_sol_cost` : plafond de depense, frais inclus. */
  maxSolCost: bigint;
  /** Tokens theoriques avant application du slippage — pour les logs. */
  quotedTokens: bigint;
  /** Part du budget qui entre reellement dans la courbe (hors frais). */
  solIntoCurve: bigint;
  /** Part du budget consommee par les frais de protocole. */
  feeLamports: bigint;
  /** Fraction de l'offre totale acquise, en pourcentage. */
  supplyPct: number;
}

/**
 * Calcule les arguments du `buy` initial a partir d'un BUDGET en SOL.
 *
 * Choix deliberé : on raisonne en budget, pas en quantite cible.
 * `buy(amount, max_sol_cost)` demande un nombre EXACT de tokens et echoue si
 * le cout depasse le plafond. En fixant `maxSolCost = budget` exactement, la
 * depense est bornee par construction — quelle que soit la formule de frais
 * reellement appliquee par le programme. Le slippage est absorbe en demandant
 * MOINS de tokens, pas en relevant le plafond de depense. Aucune derive du
 * bareme de frais ne peut donc faire depenser plus que prevu.
 *
 * Dans une transaction atomique create+buy, l'etat de la courbe est son etat
 * initial et personne ne peut s'intercaler : le slippage ne couvre donc qu'une
 * eventuelle derive des parametres, pas un front-run. 100-300 bps suffisent.
 */
export function quoteInitialBuy(
  solBudgetLamports: bigint,
  slippageBps: number,
  global: Pick<
    PumpGlobal,
    | 'initialVirtualSolReserves'
    | 'initialVirtualTokenReserves'
    | 'initialRealTokenReserves'
    | 'tokenTotalSupply'
    | 'feeBasisPoints'
  > = DEFAULT_GLOBAL_PARAMS,
): BuyQuote {
  if (solBudgetLamports <= 0n) throw new Error('quoteInitialBuy: budget must be > 0');
  if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps >= 10_000) {
    throw new Error(`quoteInitialBuy: slippageBps must be an integer in [0, 10000), got ${slippageBps}`);
  }

  const feeBps = global.feeBasisPoints;
  // Le budget inclut les frais : on retire la part de frais avant de coter.
  const solIntoCurve = (solBudgetLamports * 10_000n) / (10_000n + feeBps);
  const feeLamports = solBudgetLamports - solIntoCurve;

  const quotedTokens = getBuyAmountOut(
    solIntoCurve,
    global.initialVirtualSolReserves,
    global.initialVirtualTokenReserves,
    global.initialRealTokenReserves,
  );
  if (quotedTokens <= 0n) throw new Error('quoteInitialBuy: curve quote resolved to zero tokens');

  const amount = (quotedTokens * BigInt(10_000 - slippageBps)) / 10_000n;
  if (amount <= 0n) throw new Error('quoteInitialBuy: slippage wiped out the entire quote');

  return {
    amount,
    maxSolCost: solBudgetLamports,
    quotedTokens,
    solIntoCurve,
    feeLamports,
    supplyPct: Number((amount * 1_000_000n) / global.tokenTotalSupply) / 10_000,
  };
}

// ---------------------------------------------------------------------------
// Tables de comptes — transcription litterale de l'IDL
// ---------------------------------------------------------------------------

interface AccountSpec {
  /** Nom exact tel qu'il figure dans l'IDL. */
  name: string;
  writable?: boolean;
  signer?: boolean;
}

/** `create` — 14 comptes. */
const CREATE_ACCOUNTS: readonly AccountSpec[] = [
  { name: 'mint', writable: true, signer: true },
  { name: 'mint_authority' },
  { name: 'bonding_curve', writable: true },
  { name: 'associated_bonding_curve', writable: true },
  { name: 'global' },
  { name: 'mpl_token_metadata' },
  { name: 'metadata', writable: true },
  { name: 'user', writable: true, signer: true },
  { name: 'system_program' },
  { name: 'token_program' },
  { name: 'associated_token_program' },
  { name: 'rent' },
  { name: 'event_authority' },
  { name: 'program' },
];

/**
 * `buy` — 16 comptes.
 * Les quatre derniers (accumulateurs de volume, fee_config, fee_program) ont
 * ete ajoutes apres le lancement : un bot copie d'un tutoriel de 2024 envoie
 * 12 comptes et se fait rejeter. Noter que `global_volume_accumulator` est
 * NON writable dans l'IDL, contrairement a ce que son nom suggere.
 */
const BUY_ACCOUNTS: readonly AccountSpec[] = [
  { name: 'global' },
  { name: 'fee_recipient', writable: true },
  { name: 'mint' },
  { name: 'bonding_curve', writable: true },
  { name: 'associated_bonding_curve', writable: true },
  { name: 'associated_user', writable: true },
  { name: 'user', writable: true, signer: true },
  { name: 'system_program' },
  { name: 'token_program' },
  { name: 'creator_vault', writable: true },
  { name: 'event_authority' },
  { name: 'program' },
  { name: 'global_volume_accumulator' },
  { name: 'user_volume_accumulator', writable: true },
  { name: 'fee_config' },
  { name: 'fee_program' },
];

/**
 * Projette une table de specs sur des cles concretes.
 * Un nom absent de `resolved` leve immediatement : c'est le garde-fou qui
 * transforme une derive d'IDL en erreur de demarrage plutot qu'en transaction
 * rejetee au pire moment.
 */
function toAccountMetas(
  specs: readonly AccountSpec[],
  resolved: Readonly<Record<string, PublicKey>>,
) {
  return specs.map((spec) => {
    const pubkey = resolved[spec.name];
    if (!pubkey) {
      throw new Error(
        `pumpfun: account "${spec.name}" required by the IDL was not provided ` +
          `(known: ${Object.keys(resolved).join(', ')})`,
      );
    }
    return { pubkey, isWritable: spec.writable === true, isSigner: spec.signer === true };
  });
}

// ---------------------------------------------------------------------------
// Encodage borsh minimal
// ---------------------------------------------------------------------------

/** String borsh : longueur u32 LE, puis les octets UTF-8. */
function encodeString(value: string): Buffer {
  const bytes = Buffer.from(value, 'utf8');
  const len = Buffer.alloc(4);
  len.writeUInt32LE(bytes.length, 0);
  return Buffer.concat([len, bytes]);
}

function encodeU64(value: bigint): Buffer {
  if (value < 0n || value > 0xffff_ffff_ffff_ffffn) {
    throw new Error(`u64 out of range: ${value}`);
  }
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(value, 0);
  return buf;
}

// ---------------------------------------------------------------------------
// Instructions
// ---------------------------------------------------------------------------

export interface TokenMetadataArgs {
  name: string;
  symbol: string;
  /** URI des metadonnees JSON (Irys/Arweave). Max 200 octets cote Metaplex. */
  uri: string;
}

/** Bornes Metaplex. Depasser fait echouer `create` on-chain. */
const METAPLEX_LIMITS = { name: 32, symbol: 10, uri: 200 } as const;

function assertMetadataFits(md: TokenMetadataArgs): void {
  for (const [field, max] of Object.entries(METAPLEX_LIMITS) as Array<
    [keyof TokenMetadataArgs, number]
  >) {
    const len = Buffer.byteLength(md[field], 'utf8');
    if (len === 0) throw new Error(`pumpfun: metadata.${field} is empty`);
    if (len > max) {
      throw new Error(`pumpfun: metadata.${field} is ${len} bytes, Metaplex allows ${max}`);
    }
  }
}

export interface CreateIxParams {
  mint: PublicKey;
  /** Payeur et signataire de la transaction. */
  user: PublicKey;
  /**
   * Beneficiaire des creator fees. Peut differer de `user` : le vault suit le
   * createur, pas le payeur. Par defaut, `user`.
   */
  creator?: PublicKey;
  metadata: TokenMetadataArgs;
}

/** Instruction `create` : mint + bonding curve + metadonnees Metaplex. */
export function buildCreateInstruction(p: CreateIxParams): TransactionInstruction {
  assertMetadataFits(p.metadata);
  const creator = p.creator ?? p.user;

  const keys = toAccountMetas(CREATE_ACCOUNTS, {
    mint: p.mint,
    mint_authority: MINT_AUTHORITY_PDA,
    bonding_curve: deriveBondingCurve(p.mint),
    associated_bonding_curve: deriveAssociatedBondingCurve(p.mint),
    global: GLOBAL_PDA,
    mpl_token_metadata: MPL_TOKEN_METADATA_PROGRAM_ID,
    metadata: deriveMetadata(p.mint),
    user: p.user,
    system_program: SystemProgram.programId,
    token_program: TOKEN_PROGRAM_ID,
    associated_token_program: ASSOCIATED_TOKEN_PROGRAM_ID,
    rent: SYSVAR_RENT_PUBKEY,
    event_authority: EVENT_AUTHORITY_PDA,
    program: PUMP_PROGRAM_ID,
  });

  const data = Buffer.concat([
    IX_CREATE,
    encodeString(p.metadata.name),
    encodeString(p.metadata.symbol),
    encodeString(p.metadata.uri),
    creator.toBuffer(),
  ]);

  return new TransactionInstruction({ programId: PUMP_PROGRAM_ID, keys, data });
}

export interface BuyIxParams {
  mint: PublicKey;
  user: PublicKey;
  creator?: PublicKey;
  feeRecipient: PublicKey;
  /** Tokens demandes, unites de base. */
  amount: bigint;
  /** Plafond de depense en lamports, frais inclus. */
  maxSolCost: bigint;
  /**
   * Argument optionnel `track_volume`.
   *
   * Non renseigne par defaut, et c'est deliberé : la desserialisation de cet
   * argument est tolerante a l'EOF cote programme, donc omettre l'octet de
   * queue est le chemin retro-compatible que suit tout client existant.
   * L'encodage exact du type `OptionBool` n'etant pas documente, on ne l'emet
   * que si l'appelant le demande explicitement.
   */
  trackVolume?: boolean;
}

/** Instruction `buy` sur la bonding curve. */
export function buildBuyInstruction(p: BuyIxParams): TransactionInstruction {
  if (p.amount <= 0n) throw new Error('pumpfun: buy amount must be > 0');
  if (p.maxSolCost <= 0n) throw new Error('pumpfun: maxSolCost must be > 0');
  const creator = p.creator ?? p.user;

  const keys = toAccountMetas(BUY_ACCOUNTS, {
    global: GLOBAL_PDA,
    fee_recipient: p.feeRecipient,
    mint: p.mint,
    bonding_curve: deriveBondingCurve(p.mint),
    associated_bonding_curve: deriveAssociatedBondingCurve(p.mint),
    associated_user: getAssociatedTokenAddressSync(p.mint, p.user, false),
    user: p.user,
    system_program: SystemProgram.programId,
    token_program: TOKEN_PROGRAM_ID,
    creator_vault: deriveCreatorVault(creator),
    event_authority: EVENT_AUTHORITY_PDA,
    program: PUMP_PROGRAM_ID,
    global_volume_accumulator: GLOBAL_VOLUME_ACCUMULATOR_PDA,
    user_volume_accumulator: deriveUserVolumeAccumulator(p.user),
    fee_config: FEE_CONFIG_PDA,
    fee_program: PUMP_FEE_PROGRAM_ID,
  });

  const parts = [IX_BUY, encodeU64(p.amount), encodeU64(p.maxSolCost)];
  if (p.trackVolume !== undefined) {
    // Option<bool> borsh : [tag, valeur].
    parts.push(Buffer.from([1, p.trackVolume ? 1 : 0]));
  }

  return new TransactionInstruction({
    programId: PUMP_PROGRAM_ID,
    keys,
    data: Buffer.concat(parts),
  });
}

// ---------------------------------------------------------------------------
// Transaction atomique create + buy
// ---------------------------------------------------------------------------

export interface CreateAndBuyParams {
  /** Payeur, createur et sniper. Signe la transaction. */
  payer: Keypair;
  /** Keypair du mint, issue du pool pre-genere. Signe la transaction. */
  mint: Keypair;
  metadata: TokenMetadataArgs;
  /** Budget total de l'achat initial, en lamports. */
  solBudgetLamports: bigint;
  slippageBps: number;
  /** Parametres lus depuis le compte `global`. */
  global: PumpGlobal;
  recentBlockhash: Blockhash;
  computeUnitLimit: number;
  computeUnitPriceMicroLamports: number;
  /**
   * Instruction de tip Jito. Placee en DERNIERE position : si une instruction
   * precedente echoue, la transaction entiere est annulee et le tip n'est pas
   * debite. Voir l'en-tete de `jitoBundle.ts` pour le choix du tip inline.
   */
  tipInstruction?: TransactionInstruction;
  /** ALT pre-creees et deja "chaudes". Utilisees seulement si la tx deborde. */
  lookupTables?: AddressLookupTableAccount[];
  creator?: PublicKey;
  trackVolume?: boolean;
}

export interface CreateAndBuyResult {
  tx: VersionedTransaction;
  quote: BuyQuote;
  /** Taille serialisee reelle, en octets. */
  size: number;
  /** Adresses derivees — a journaliser pour le suivi de position. */
  addresses: {
    mint: PublicKey;
    bondingCurve: PublicKey;
    associatedBondingCurve: PublicKey;
    associatedUser: PublicKey;
    creatorVault: PublicKey;
    metadata: PublicKey;
  };
  /** true si une ALT a ete necessaire pour passer sous la limite de taille. */
  usedLookupTables: boolean;
}

/**
 * Compile et signe la transaction v0 complete :
 *   SetComputeUnitLimit, SetComputeUnitPrice, create, createATA(idempotent),
 *   buy, tip.
 *
 * Ordre impose :
 *   - les instructions ComputeBudget doivent preceder toute consommation de CU ;
 *   - l'ATA de l'acheteur ne peut etre creee qu'apres l'existence du mint,
 *     donc apres `create` ;
 *   - `buy` exige une `associated_user` deja existante, d'ou l'ATA idempotente
 *     intercalee (idempotente : sans effet ni cout si le programme la cree
 *     lui-meme, donc sans risque de double creation) ;
 *   - le tip ferme la marche.
 *
 * Strategie de taille : on compile d'abord SANS ALT (le chemin le plus rapide
 * et le plus fiable). On ne bascule sur les ALT que si le resultat depasse la
 * limite. Une ALT ne peut de toute facon pas etre creee au moment du snipe :
 * elle n'est utilisable qu'un slot apres sa creation, elle doit donc etre
 * provisionnee a l'avance.
 */
export function buildCreateAndBuyTx(p: CreateAndBuyParams): CreateAndBuyResult {
  const mint = p.mint.publicKey;
  const user = p.payer.publicKey;
  const creator = p.creator ?? user;

  const quote = quoteInitialBuy(p.solBudgetLamports, p.slippageBps, p.global);

  const associatedUser = getAssociatedTokenAddressSync(mint, user, false);

  const instructions: TransactionInstruction[] = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: p.computeUnitLimit }),
    ComputeBudgetProgram.setComputeUnitPrice({
      microLamports: p.computeUnitPriceMicroLamports,
    }),
    buildCreateInstruction({ mint, user, creator, metadata: p.metadata }),
    createAssociatedTokenAccountIdempotentInstruction(user, associatedUser, user, mint),
    buildBuyInstruction({
      mint,
      user,
      creator,
      feeRecipient: p.global.feeRecipient,
      amount: quote.amount,
      maxSolCost: quote.maxSolCost,
      ...(p.trackVolume !== undefined ? { trackVolume: p.trackVolume } : {}),
    }),
  ];
  if (p.tipInstruction) instructions.push(p.tipInstruction);

  const compile = (luts?: AddressLookupTableAccount[]) => {
    const message = new TransactionMessage({
      payerKey: user,
      recentBlockhash: p.recentBlockhash,
      instructions,
    }).compileToV0Message(luts);
    const tx = new VersionedTransaction(message);
    tx.sign([p.payer, p.mint]);
    return { tx, size: tx.serialize().length };
  };

  let { tx, size } = compile();
  let usedLookupTables = false;

  if (size > MAX_TX_BYTES) {
    if (!p.lookupTables?.length) {
      throw new Error(
        `pumpfun: transaction is ${size} bytes (max ${MAX_TX_BYTES}) and no lookup table was ` +
          `provided. Shorten metadata.uri (currently ${Buffer.byteLength(p.metadata.uri, 'utf8')} ` +
          `bytes) or pre-create and warm an ALT holding the static pump accounts.`,
      );
    }
    ({ tx, size } = compile(p.lookupTables));
    usedLookupTables = true;
    if (size > MAX_TX_BYTES) {
      throw new Error(
        `pumpfun: transaction is still ${size} bytes (max ${MAX_TX_BYTES}) after applying ` +
          `${p.lookupTables.length} lookup table(s)`,
      );
    }
  }

  return {
    tx,
    quote,
    size,
    usedLookupTables,
    addresses: {
      mint,
      bondingCurve: deriveBondingCurve(mint),
      associatedBondingCurve: deriveAssociatedBondingCurve(mint),
      associatedUser,
      creatorVault: deriveCreatorVault(creator),
      metadata: deriveMetadata(mint),
    },
  };
}

// ===========================================================================
// SORTIE : etat de la courbe, cotation inverse, vente, collecte des frais
// ===========================================================================

// ---------------------------------------------------------------------------
// Compte `BondingCurve`
//
// Layout verifie empiriquement sur trois courbes mainnet le 2026-09-17 :
//   8  discriminant
//   8  virtual_token_reserves   u64
//   8  virtual_sol_reserves     u64
//   8  real_token_reserves      u64
//   8  real_sol_reserves        u64
//   8  token_total_supply       u64
//   1  complete                 bool
//  32  creator                  pubkey
//  = 81 octets utiles, sur des comptes alloues a 151 octets (reserve).
// Comme pour `global`, on ne lit que le prefixe et on ignore la queue.
// ---------------------------------------------------------------------------

export interface BondingCurveState {
  virtualTokenReserves: bigint;
  virtualSolReserves: bigint;
  realTokenReserves: bigint;
  realSolReserves: bigint;
  tokenTotalSupply: bigint;
  /** true une fois la courbe remplie et le token migre vers l'AMM. */
  complete: boolean;
  creator: PublicKey;
}

const BONDING_CURVE_MIN_LEN = 8 + 8 * 5 + 1 + 32;

export function decodeBondingCurve(data: Buffer): BondingCurveState {
  if (data.length < BONDING_CURVE_MIN_LEN) {
    throw new Error(`bonding curve account too short: ${data.length} < ${BONDING_CURVE_MIN_LEN}`);
  }
  let o = 8;
  const readU64 = () => {
    const v = data.readBigUInt64LE(o);
    o += 8;
    return v;
  };
  const virtualTokenReserves = readU64();
  const virtualSolReserves = readU64();
  const realTokenReserves = readU64();
  const realSolReserves = readU64();
  const tokenTotalSupply = readU64();
  const completeByte = data.readUInt8(o);
  o += 1;
  if (completeByte > 1) {
    // Un bool borsh vaut 0 ou 1. Autre chose = on ne lit pas ce qu'on croit.
    throw new Error(`bonding curve: invalid bool for "complete" (${completeByte}), layout drifted`);
  }
  const creator = new PublicKey(data.subarray(o, o + 32));

  if (virtualTokenReserves === 0n || virtualSolReserves === 0n) {
    throw new Error('bonding curve: zero virtual reserves, refusing to quote against it');
  }
  return {
    virtualTokenReserves,
    virtualSolReserves,
    realTokenReserves,
    realSolReserves,
    tokenTotalSupply,
    complete: completeByte === 1,
    creator,
  };
}

export async function fetchBondingCurve(
  connection: Connection,
  mint: PublicKey,
): Promise<BondingCurveState> {
  const pda = deriveBondingCurve(mint);
  const info = await connection.getAccountInfo(pda, 'processed');
  if (!info) throw new Error(`bonding curve not found for mint ${mint.toBase58()}`);
  if (!info.owner.equals(PUMP_PROGRAM_ID)) {
    throw new Error(`bonding curve ${pda.toBase58()} is owned by ${info.owner.toBase58()}`);
  }
  return decodeBondingCurve(info.data);
}

/**
 * Prix instantane, en lamports par unite de base de token (6 decimales).
 *
 * Ratio des reserves VIRTUELLES, jamais des reserves reelles : c'est le prix
 * que le programme applique.
 *
 * A ne jamais deduire des parametres initiaux. Une sonde mainnet a montre des
 * courbes dont l'ecart virtualSol - realSol vaut 998 SOL au lieu des 30 SOL
 * canoniques : tout calcul qui suppose "30 SOL de reserve virtuelle initiale"
 * se trompe de deux ordres de grandeur sur ces tokens.
 */
export function curvePrice(
  curve: Pick<BondingCurveState, 'virtualSolReserves' | 'virtualTokenReserves'>,
): number {
  return Number(curve.virtualSolReserves) / Number(curve.virtualTokenReserves);
}

/** Capitalisation implicite, en lamports. */
export function curveMarketCapLamports(curve: BondingCurveState): number {
  return curvePrice(curve) * Number(curve.tokenTotalSupply);
}

// ---------------------------------------------------------------------------
// Cotation inverse (vente)
// ---------------------------------------------------------------------------

export interface SellQuote {
  /** Tokens vendus (unites de base). */
  amount: bigint;
  /** SOL sortant de la courbe, avant frais. */
  grossSolOut: bigint;
  feeLamports: bigint;
  /** SOL effectivement recu, frais deduits. */
  netSolOut: bigint;
  /** Argument `min_sol_output`, net apres application du slippage. */
  minSolOutput: bigint;
}

/**
 * SOL brut rendu par la courbe pour `tokensIn` tokens.
 *
 * Symetrique de `getBuyAmountOut`, produit constant sur reserves virtuelles :
 *   out = (tokensIn * vSol) / (vTok + tokensIn)
 *
 * Division entiere, donc arrondi vers le bas : conservateur du bon cote, on
 * n'annonce jamais plus que ce que la courbe rendra.
 */
export function getSellAmountOut(
  tokensIn: bigint,
  virtualSolReserves: bigint,
  virtualTokenReserves: bigint,
): bigint {
  if (tokensIn <= 0n) return 0n;
  return (tokensIn * virtualSolReserves) / (virtualTokenReserves + tokensIn);
}

/**
 * Cote une vente a quantite d'entree fixe et calcule `min_sol_output`.
 *
 * Choix sur le sens du slippage : `minSolOutput` est derive du montant NET
 * (frais deduits), pas du brut. Si le programme compare `min_sol_output` au
 * brut, notre borne est simplement plus basse que necessaire - la transaction
 * passe, protegee par le slippage. Dans l'autre sens (borne calculee sur le
 * brut alors que le programme compare le net), toute vente echouerait
 * systematiquement. On choisit l'erreur qui ne bloque pas la sortie : en
 * gestion de position, une vente qui ne part pas coute bien plus cher qu'une
 * vente legerement sous-protegee.
 */
export function quoteExactInputSell(
  tokensIn: bigint,
  curve: Pick<BondingCurveState, 'virtualSolReserves' | 'virtualTokenReserves'>,
  slippageBps: number,
  feeBasisPoints: bigint = DEFAULT_GLOBAL_PARAMS.feeBasisPoints,
): SellQuote {
  if (tokensIn <= 0n) throw new Error('quoteExactInputSell: amount must be > 0');
  if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps >= 10_000) {
    throw new Error(
      `quoteExactInputSell: slippageBps must be an integer in [0, 10000), got ${slippageBps}`,
    );
  }

  const grossSolOut = getSellAmountOut(
    tokensIn,
    curve.virtualSolReserves,
    curve.virtualTokenReserves,
  );
  if (grossSolOut <= 0n) throw new Error('quoteExactInputSell: curve returned zero SOL');

  const feeLamports = (grossSolOut * feeBasisPoints) / 10_000n;
  const netSolOut = grossSolOut - feeLamports;
  const minSolOutput = (netSolOut * BigInt(10_000 - slippageBps)) / 10_000n;

  return { amount: tokensIn, grossSolOut, feeLamports, netSolOut, minSolOutput };
}

// ---------------------------------------------------------------------------
// `sell` - meme table de comptes que `buy` (16 comptes, IDL verifie)
// ---------------------------------------------------------------------------

const SELL_ACCOUNTS: readonly AccountSpec[] = BUY_ACCOUNTS;

export interface SellIxParams {
  mint: PublicKey;
  user: PublicKey;
  creator: PublicKey;
  feeRecipient: PublicKey;
  amount: bigint;
  minSolOutput: bigint;
  trackVolume?: boolean;
}

export function buildSellInstruction(p: SellIxParams): TransactionInstruction {
  if (p.amount <= 0n) throw new Error('pumpfun: sell amount must be > 0');
  if (p.minSolOutput < 0n) throw new Error('pumpfun: minSolOutput must be >= 0');

  const keys = toAccountMetas(SELL_ACCOUNTS, {
    global: GLOBAL_PDA,
    fee_recipient: p.feeRecipient,
    mint: p.mint,
    bonding_curve: deriveBondingCurve(p.mint),
    associated_bonding_curve: deriveAssociatedBondingCurve(p.mint),
    associated_user: getAssociatedTokenAddressSync(p.mint, p.user, false),
    user: p.user,
    system_program: SystemProgram.programId,
    token_program: TOKEN_PROGRAM_ID,
    creator_vault: deriveCreatorVault(p.creator),
    event_authority: EVENT_AUTHORITY_PDA,
    program: PUMP_PROGRAM_ID,
    global_volume_accumulator: GLOBAL_VOLUME_ACCUMULATOR_PDA,
    user_volume_accumulator: deriveUserVolumeAccumulator(p.user),
    fee_config: FEE_CONFIG_PDA,
    fee_program: PUMP_FEE_PROGRAM_ID,
  });

  const parts = [IX_SELL, encodeU64(p.amount), encodeU64(p.minSolOutput)];
  if (p.trackVolume !== undefined) parts.push(Buffer.from([1, p.trackVolume ? 1 : 0]));

  return new TransactionInstruction({
    programId: PUMP_PROGRAM_ID,
    keys,
    data: Buffer.concat(parts),
  });
}

export interface BuildSellTxParams {
  /** Detenteur des tokens, payeur et signataire. */
  payer: Keypair;
  mint: PublicKey;
  /** Createur du token : determine le creator_vault. Lu sur la courbe. */
  creator: PublicKey;
  /** Tokens a vendre (unites de base). */
  amount: bigint;
  /** Etat courant de la courbe, relu juste avant la construction. */
  curve: Pick<BondingCurveState, 'virtualSolReserves' | 'virtualTokenReserves'>;
  slippageBps: number;
  feeRecipient: PublicKey;
  feeBasisPoints: bigint;
  recentBlockhash: Blockhash;
  computeUnitLimit: number;
  computeUnitPriceMicroLamports: number;
  /** Tip Jito, place en derniere position. */
  tipInstruction?: TransactionInstruction;
  lookupTables?: AddressLookupTableAccount[];
  trackVolume?: boolean;
}

export interface BuildSellTxResult {
  tx: VersionedTransaction;
  quote: SellQuote;
  size: number;
}

/**
 * Transaction v0 de vente, tip Jito inline en derniere position.
 *
 * Passer la vente par un bundle Jito n'est pas un luxe : une vente visible
 * dans le mempool public est la cible ideale d'un sandwich, l'attaquant
 * vendant devant vous puis rachetant derriere. Le bundle rend la transaction
 * invisible jusqu'a son inclusion.
 *
 * Aucune creation d'ATA ici : vendre suppose de detenir les tokens, donc que
 * l'ATA existe deja.
 */
export function buildSellTx(p: BuildSellTxParams): BuildSellTxResult {
  const quote = quoteExactInputSell(p.amount, p.curve, p.slippageBps, p.feeBasisPoints);

  const instructions: TransactionInstruction[] = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: p.computeUnitLimit }),
    ComputeBudgetProgram.setComputeUnitPrice({
      microLamports: p.computeUnitPriceMicroLamports,
    }),
    buildSellInstruction({
      mint: p.mint,
      user: p.payer.publicKey,
      creator: p.creator,
      feeRecipient: p.feeRecipient,
      amount: quote.amount,
      minSolOutput: quote.minSolOutput,
      ...(p.trackVolume !== undefined ? { trackVolume: p.trackVolume } : {}),
    }),
  ];
  if (p.tipInstruction) instructions.push(p.tipInstruction);

  const message = new TransactionMessage({
    payerKey: p.payer.publicKey,
    recentBlockhash: p.recentBlockhash,
    instructions,
  }).compileToV0Message(p.lookupTables);
  const tx = new VersionedTransaction(message);
  tx.sign([p.payer]);

  const size = tx.serialize().length;
  if (size > MAX_TX_BYTES) {
    throw new Error(`pumpfun: sell transaction is ${size} bytes (max ${MAX_TX_BYTES})`);
  }
  return { tx, quote, size };
}

// ---------------------------------------------------------------------------
// `collect_creator_fee` - 5 comptes, aucun argument
// ---------------------------------------------------------------------------

const COLLECT_CREATOR_FEE_ACCOUNTS: readonly AccountSpec[] = [
  { name: 'creator', writable: true, signer: true },
  { name: 'creator_vault', writable: true },
  { name: 'system_program' },
  { name: 'event_authority' },
  { name: 'program' },
];

/**
 * Vide le creator_vault vers le createur.
 *
 * Note : l'IDL ne marque pas `creator` comme signataire. On l'exige quand
 * meme - c'est de toute facon le payeur de la transaction, et un compte
 * signataire de plus ne peut pas faire echouer une instruction qui ne le
 * demande pas, alors que l'inverse serait une faille.
 */
export function buildCollectCreatorFeeInstruction(creator: PublicKey): TransactionInstruction {
  const keys = toAccountMetas(COLLECT_CREATOR_FEE_ACCOUNTS, {
    creator,
    creator_vault: deriveCreatorVault(creator),
    system_program: SystemProgram.programId,
    event_authority: EVENT_AUTHORITY_PDA,
    program: PUMP_PROGRAM_ID,
  });
  return new TransactionInstruction({
    programId: PUMP_PROGRAM_ID,
    keys,
    data: IX_COLLECT_CREATOR_FEE,
  });
}
