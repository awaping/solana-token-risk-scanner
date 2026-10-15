/**
 * src/solana/jitoBundle.ts
 * ---------------------------------------------------------------------------
 * Assemblage, signature et soumission d'un bundle atomique Jito.
 *
 * Un bundle Jito, c'est : jusqu'a 5 transactions executees dans l'ordre, dans
 * le meme slot, par le meme leader, en tout-ou-rien. Si une seule transaction
 * echoue, aucune n'atterrit. C'est exactement la garantie qu'il faut ici :
 * le `create` du token et le `buy` initial doivent etre indissociables, sinon
 * on cree un token pour un concurrent qui achete le premier tick.
 *
 * DECISIONS D'ARCHITECTURE
 *
 * 1. Le tip est une instruction DANS la transaction principale, pas une
 *    transaction separee. `Bundle.addTipTx()` du SDK cree une tx de tip
 *    distincte : un validateur malveillant peut alors extraire vos tx du
 *    bundle, les rejouer seul et encaisser le tip sans executer le reste
 *    ("uncle bandit"). Tip dans la meme tx = pas d'extraction possible.
 *
 * 2. Le bundle est diffuse EN PARALLELE vers plusieurs regions de Block
 *    Engine. La premiere reponse gagne (`Promise.any`). Envoyer le meme
 *    bundle a plusieurs regions est sans risque : les transactions portent les
 *    memes signatures, donc au plus une copie peut atterrir on-chain.
 *
 * 3. Le tip est dimensionne dynamiquement sur le tip floor publie par Jito.
 *    Un tip fixe est soit du gaspillage, soit une garantie de ne jamais
 *    atterrir quand le reseau chauffe.
 *
 * 4. La confirmation se fait par polling HTTP de `getBundleStatuses`, et non
 *    par le flux gRPC `onBundleResult` : le flux ne rapporte que les bundles
 *    soumis par la connexion courante et se tait si le stream se reconnecte.
 * ---------------------------------------------------------------------------
 */

import {
  AddressLookupTableAccount,
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import type { Blockhash, Connection } from '@solana/web3.js';
import bs58 from 'bs58';
import type { Logger } from 'pino';

import { searcherClient } from 'jito-ts/dist/sdk/block-engine/searcher.js';
import type { SearcherClient } from 'jito-ts/dist/sdk/block-engine/searcher.js';
import { Bundle } from 'jito-ts/dist/sdk/block-engine/types.js';

// ---------------------------------------------------------------------------
// Constantes protocole
// ---------------------------------------------------------------------------

/** Limite dure du protocole Jito. */
export const MAX_BUNDLE_TX = 5;

/**
 * Comptes de tip officiels, utilises comme repli si `getTipAccounts()` echoue
 * (le bot ne doit pas rater un lancement pour une erreur de metadonnees).
 * Toujours en tirer un AU HASARD : viser toujours le meme compte cree de la
 * contention d'ecriture sur ce compte et degrade le taux d'atterrissage.
 */
const FALLBACK_TIP_ACCOUNTS = [
  '96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5',
  'HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe',
  'Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY',
  'ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49',
  'DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh',
  'ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt',
  'DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL',
  '3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT',
];

/** Rafraichissement du cache des comptes de tip et du tip floor. */
const TIP_ACCOUNTS_TTL_MS = 5 * 60_000;
const TIP_FLOOR_TTL_MS = 15_000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface JitoConfig {
  /** Hotes gRPC des Block Engines, SANS schema. Ex: `ny.mainnet.block-engine.jito.wtf`. */
  blockEngines: string[];
  /** Base HTTP pour getBundleStatuses. Ex: `https://mainnet.block-engine.jito.wtf`. */
  httpUrl: string;
  tipFloorUrl: string;
  /** Keypair searcher, optionnel (l'acces sans auth est ouvert, mais rate-limite). */
  authKeypair?: Keypair;
  dynamicTip: boolean;
  tipPercentile: 25 | 50 | 75 | 95 | 99;
  tipMinLamports: number;
  tipMaxLamports: number;
  tipMultiplier: number;
  bundleTimeoutMs: number;
  /** Si true, rien n'est envoye : le bundle est construit, simule, puis jete. */
  dryRun: boolean;
}

/** Un groupe d'instructions = une transaction du bundle. */
export interface TxGroup {
  instructions: TransactionInstruction[];
  /** Signataires additionnels (mint keypair, wallets snipers...). Le payer est ajoute seul. */
  signers: Keypair[];
  /** Payeur de frais de CETTE transaction. */
  payer: Keypair;
  /** Optionnel : ALT pour compresser les comptes si la tx frole la limite de 1232 octets. */
  lookupTables?: AddressLookupTableAccount[];
  /** Unites de calcul demandees. Omis => pas d'instruction ComputeBudget ajoutee. */
  computeUnitLimit?: number;
  computeUnitPriceMicroLamports?: number;
}

export interface BundleSubmission {
  bundleId: string;
  /** Signature de chaque transaction, dans l'ordre du bundle. */
  signatures: string[];
  tipLamports: number;
  /** Region qui a accepte le bundle en premier. */
  acceptedBy: string;
  submittedAtMs: number;
}

export type BundleOutcome =
  | { status: 'landed'; slot: number; bundleId: string }
  | { status: 'failed'; bundleId: string; reason: string }
  | { status: 'timeout'; bundleId: string };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * jito-ts a change de convention entre les majeures : certaines methodes
 * renvoient la valeur brute, d'autres un `Result<T, Error>` facon Rust.
 * Ce normaliseur absorbe les deux et evite qu'une bump de dependance casse
 * silencieusement le chemin critique.
 */
function unwrapResult<T>(value: unknown): T {
  if (value && typeof value === 'object' && 'ok' in (value as Record<string, unknown>)) {
    const r = value as { ok: boolean; value?: T; error?: unknown };
    if (!r.ok) throw r.error instanceof Error ? r.error : new Error(String(r.error));
    return r.value as T;
  }
  return value as T;
}

function pickRandom<T>(items: readonly T[]): T {
  return items[Math.floor(Math.random() * items.length)] as T;
}

// ---------------------------------------------------------------------------
// JitoBundler
// ---------------------------------------------------------------------------

export class JitoBundler {
  private readonly cfg: JitoConfig;
  private readonly connection: Connection;
  private readonly log: Logger;

  /** Un client gRPC persistant par region. Etabli une seule fois au demarrage :
   *  ouvrir une connexion au moment du snipe couterait 100-300 ms de handshake. */
  private readonly clients = new Map<string, SearcherClient>();

  private tipAccounts: PublicKey[] = FALLBACK_TIP_ACCOUNTS.map((a) => new PublicKey(a));
  private tipAccountsFetchedAt = 0;

  private cachedTipLamports: number | null = null;
  private tipFloorFetchedAt = 0;

  constructor(cfg: JitoConfig, connection: Connection, logger: Logger) {
    if (cfg.blockEngines.length === 0) throw new Error('JitoConfig.blockEngines must not be empty');
    if (cfg.tipMinLamports > cfg.tipMaxLamports) {
      throw new Error('JitoConfig: tipMinLamports > tipMaxLamports');
    }
    this.cfg = cfg;
    this.connection = connection;
    this.log = logger.child({ module: 'jito' });
  }

  /**
   * A appeler au boot, avant le premier signal. Ouvre les connexions gRPC et
   * prechauffe les caches pour que `submit()` n'ait plus aucun I/O optionnel
   * sur son chemin.
   */
  async init(): Promise<void> {
    for (const host of this.cfg.blockEngines) {
      try {
        this.clients.set(host, searcherClient(host, this.cfg.authKeypair));
        this.log.info({ host }, 'block engine client ready');
      } catch (err) {
        // Une region morte ne doit pas empecher le bot de demarrer sur les autres.
        this.log.error({ err, host }, 'failed to create block engine client');
      }
    }
    if (this.clients.size === 0) throw new Error('no usable Jito block engine client');

    // Les deux prefetch sont independants : en parallele.
    await Promise.allSettled([this.refreshTipAccounts(), this.refreshTipFloor()]);
  }

  close(): void {
    this.clients.clear();
  }

  // -------------------------------------------------------------------------
  // Tip
  // -------------------------------------------------------------------------

  private async refreshTipAccounts(): Promise<void> {
    if (Date.now() - this.tipAccountsFetchedAt < TIP_ACCOUNTS_TTL_MS) return;
    const client = this.clients.values().next().value as SearcherClient | undefined;
    if (!client) return;
    try {
      const accounts = unwrapResult<string[]>(await client.getTipAccounts());
      if (Array.isArray(accounts) && accounts.length > 0) {
        this.tipAccounts = accounts.map((a) => new PublicKey(a));
        this.tipAccountsFetchedAt = Date.now();
        this.log.debug({ count: accounts.length }, 'tip accounts refreshed');
      }
    } catch (err) {
      // Non bloquant : la liste de repli est valide et change rarement.
      this.log.warn({ err }, 'getTipAccounts failed, keeping fallback list');
    }
  }

  /**
   * Lit le tip floor publie par Jito et en derive le tip a payer.
   * En cas d'echec on retombe sur `tipMinLamports` : sous-payer et rater le
   * bundle est recuperable, ne pas envoyer du tout ne l'est pas.
   */
  private async refreshTipFloor(): Promise<void> {
    if (!this.cfg.dynamicTip) {
      this.cachedTipLamports = this.cfg.tipMinLamports;
      return;
    }
    if (this.cachedTipLamports !== null && Date.now() - this.tipFloorFetchedAt < TIP_FLOOR_TTL_MS) {
      return;
    }

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 1500);
    try {
      const res = await fetch(this.cfg.tipFloorUrl, { signal: ac.signal });
      if (!res.ok) throw new Error(`tip floor HTTP ${res.status}`);
      const rows = (await res.json()) as Array<Record<string, number>>;
      const row = rows[0];
      if (!row) throw new Error('empty tip floor payload');

      // Les valeurs sont en SOL dans la reponse Jito, pas en lamports.
      const key = `landed_tips_${this.cfg.tipPercentile}th_percentile`;
      const sol = row[key];
      if (typeof sol !== 'number' || !Number.isFinite(sol)) {
        throw new Error(`missing percentile ${key}`);
      }

      const lamports = Math.round(sol * 1e9 * this.cfg.tipMultiplier);
      this.cachedTipLamports = Math.min(
        this.cfg.tipMaxLamports,
        Math.max(this.cfg.tipMinLamports, lamports),
      );
      this.tipFloorFetchedAt = Date.now();
      this.log.debug({ tipLamports: this.cachedTipLamports, sol }, 'tip floor refreshed');
    } catch (err) {
      this.log.warn({ err }, 'tip floor unavailable, falling back to tipMinLamports');
      this.cachedTipLamports ??= this.cfg.tipMinLamports;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Tip courant en lamports. Synchrone : le rafraichissement est en tache de fond. */
  get tipLamports(): number {
    return this.cachedTipLamports ?? this.cfg.tipMinLamports;
  }

  /** Instruction de tip, a inserer dans la transaction principale (voir en-tete). */
  buildTipInstruction(from: PublicKey, lamports = this.tipLamports): TransactionInstruction {
    return SystemProgram.transfer({
      fromPubkey: from,
      toPubkey: pickRandom(this.tipAccounts),
      lamports,
    });
  }

  // -------------------------------------------------------------------------
  // Construction
  // -------------------------------------------------------------------------

  /**
   * Compile et signe un groupe d'instructions en transaction versionnee (v0).
   *
   * Les instructions ComputeBudget sont placees en tete : le runtime Solana
   * exige qu'elles apparaissent avant toute instruction qui consomme des CU.
   */
  buildTransaction(group: TxGroup, recentBlockhash: Blockhash): VersionedTransaction {
    const prelude: TransactionInstruction[] = [];
    if (group.computeUnitLimit !== undefined) {
      prelude.push(ComputeBudgetProgram.setComputeUnitLimit({ units: group.computeUnitLimit }));
    }
    if (group.computeUnitPriceMicroLamports !== undefined) {
      prelude.push(
        ComputeBudgetProgram.setComputeUnitPrice({
          microLamports: group.computeUnitPriceMicroLamports,
        }),
      );
    }

    const message = new TransactionMessage({
      payerKey: group.payer.publicKey,
      recentBlockhash,
      instructions: [...prelude, ...group.instructions],
    }).compileToV0Message(group.lookupTables);

    const tx = new VersionedTransaction(message);

    // Deduplique les signataires : signer deux fois avec la meme cle produit
    // une transaction invalide.
    const seen = new Set<string>();
    const signers = [group.payer, ...group.signers].filter((kp) => {
      const k = kp.publicKey.toBase58();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    tx.sign(signers);

    const size = tx.serialize().length;
    if (size > 1232) {
      // Echouer ici est infiniment moins cher que de faire rejeter le bundle.
      throw new Error(`transaction too large: ${size} bytes (max 1232) - use an ALT`);
    }
    return tx;
  }

  // -------------------------------------------------------------------------
  // Soumission
  // -------------------------------------------------------------------------

  /**
   * Construit, signe et diffuse le bundle.
   *
   * @param groups   1 a 5 groupes d'instructions, dans l'ordre d'execution.
   * @param tipFrom  Keypair qui paie le tip. Doit etre le payer de `tipInGroup`.
   * @param tipInGroup Index du groupe recevant l'instruction de tip.
   *                   Par defaut le premier : le tip voyage avec le `create`,
   *                   donc il n'est payable qu'en executant reellement le create.
   */
  async submit(
    groups: TxGroup[],
    tipFrom: Keypair,
    tipInGroup = 0,
  ): Promise<BundleSubmission> {
    if (groups.length === 0) throw new Error('submit: no transaction groups');
    if (groups.length > MAX_BUNDLE_TX) {
      throw new Error(`submit: ${groups.length} transactions exceeds the ${MAX_BUNDLE_TX} tx limit`);
    }
    const target = groups[tipInGroup];
    if (!target) throw new Error(`submit: tipInGroup ${tipInGroup} out of range`);
    if (!target.payer.publicKey.equals(tipFrom.publicKey)) {
      throw new Error('submit: tipFrom must be the fee payer of the tip-carrying transaction');
    }

    // Rafraichissements en tache de fond : ils ne doivent jamais retarder
    // l'envoi. Le cache precedent est utilise si le refresh n'a pas fini.
    void this.refreshTipAccounts();
    void this.refreshTipFloor();

    const { blockhash } = await this.connection.getLatestBlockhash('confirmed');
    const tipLamports = this.tipLamports;
    const prepared = groups.map((g, i) =>
      i === tipInGroup
        ? {
            ...g,
            // Tip en DERNIERE position de la tx : si une instruction anterieure
            // echoue, la tx entiere est annulee et le tip n'est pas debite.
            instructions: [...g.instructions, this.buildTipInstruction(tipFrom.publicKey, tipLamports)],
          }
        : g,
    );

    const txs = prepared.map((g) => this.buildTransaction(g, blockhash));
    const signatures = txs.map((tx) => bs58.encode(tx.signatures[0] as Uint8Array));

    if (this.cfg.dryRun) {
      // Simulation de la premiere tx : attrape 90% des erreurs de comptes ou
      // de discriminants avant d'avoir depense quoi que ce soit.
      const sim = await this.connection.simulateTransaction(txs[0] as VersionedTransaction, {
        sigVerify: false,
        replaceRecentBlockhash: true,
      });
      this.log.warn(
        { signatures, tipLamports, simErr: sim.value.err, logs: sim.value.logs?.slice(-12) },
        'DRY_RUN - bundle built and simulated, not sent',
      );
      return {
        bundleId: `dryrun-${signatures[0]}`,
        signatures,
        tipLamports,
        acceptedBy: 'dry-run',
        submittedAtMs: Date.now(),
      };
    }

    const submittedAtMs = Date.now();
    const { bundleId, acceptedBy } = await this.broadcast(txs);

    this.log.info(
      { bundleId, acceptedBy, txCount: txs.length, tipLamports, signatures },
      'bundle submitted',
    );
    return { bundleId, signatures, tipLamports, acceptedBy, submittedAtMs };
  }

  /**
   * Diffuse des transactions DEJA construites et signees, tip inclus.
   *
   * C'est le chemin des modules qui compilent eux-memes leur transaction -
   * `buildCreateAndBuyTx` et `buildSellTx` - parce qu'ils doivent connaitre la
   * taille serialisee exacte et placer le tip a une position precise. Les
   * recompiler ici ferait diverger ce qui a ete mesure de ce qui est envoye.
   */
  async submitSignedTransactions(txs: VersionedTransaction[]): Promise<BundleSubmission> {
    if (txs.length === 0) throw new Error('submitSignedTransactions: no transactions');
    if (txs.length > MAX_BUNDLE_TX) {
      throw new Error(
        `submitSignedTransactions: ${txs.length} transactions exceeds the ${MAX_BUNDLE_TX} tx limit`,
      );
    }
    for (const [i, tx] of txs.entries()) {
      // Une signature nulle = transaction non signee. Jito la rejetterait, mais
      // l'erreur renvoyee est opaque : autant echouer ici avec le bon message.
      if (tx.signatures.length === 0 || tx.signatures.every((s) => s.every((b) => b === 0))) {
        throw new Error(`submitSignedTransactions: transaction ${i} is not signed`);
      }
    }

    void this.refreshTipAccounts();
    void this.refreshTipFloor();

    const signatures = txs.map((tx) => bs58.encode(tx.signatures[0] as Uint8Array));
    const tipLamports = this.tipLamports;

    if (this.cfg.dryRun) {
      const sim = await this.connection.simulateTransaction(txs[0] as VersionedTransaction, {
        sigVerify: false,
        replaceRecentBlockhash: true,
      });
      this.log.warn(
        { signatures, simErr: sim.value.err, logs: sim.value.logs?.slice(-12) },
        'DRY_RUN - pre-signed bundle simulated, not sent',
      );
      return {
        bundleId: `dryrun-${signatures[0]}`,
        signatures,
        tipLamports,
        acceptedBy: 'dry-run',
        submittedAtMs: Date.now(),
      };
    }

    const submittedAtMs = Date.now();
    const { bundleId, acceptedBy } = await this.broadcast(txs);
    this.log.info({ bundleId, acceptedBy, txCount: txs.length, signatures }, 'bundle submitted');
    return { bundleId, signatures, tipLamports, acceptedBy, submittedAtMs };
  }

  /**
   * Diffuse le bundle vers toutes les regions simultanement et retourne la
   * premiere acceptation. Envoyer aux N regions est sans danger : les
   * transactions sont identiques et signees, donc au plus une copie peut
   * atterrir on-chain.
   */
  private async broadcast(
    txs: VersionedTransaction[],
  ): Promise<{ bundleId: string; acceptedBy: string }> {
    const attempts = [...this.clients.entries()].map(async ([host, client]) => {
      // Un objet Bundle par region : le SDK le mute a l'envoi.
      const bundle = new Bundle(txs, MAX_BUNDLE_TX);
      const bundleId = unwrapResult<string>(await client.sendBundle(bundle));
      if (!bundleId) throw new Error(`${host}: sendBundle returned no id`);
      return { bundleId, acceptedBy: host };
    });

    try {
      return await Promise.any(attempts);
    } catch (err) {
      const causes =
        err instanceof AggregateError
          ? err.errors.map((e) => (e instanceof Error ? e.message : String(e)))
          : [String(err)];
      this.log.error({ causes }, 'every block engine rejected the bundle');
      throw new Error(`bundle rejected by all regions: ${causes.join(' | ')}`);
    }
  }

  // -------------------------------------------------------------------------
  // Confirmation
  // -------------------------------------------------------------------------

  /**
   * Attend l'atterrissage du bundle.
   *
   * Polling HTTP plutot que le flux gRPC `onBundleResult` : ce dernier ne
   * remonte que les bundles de la connexion courante et devient silencieux
   * apres une reconnexion, ce qui produit de faux timeouts.
   *
   * Un `timeout` n'est PAS une preuve d'echec : le bundle peut atterrir juste
   * apres. L'appelant doit verifier la signature on-chain avant de rejouer,
   * sous peine de deployer deux fois le meme token.
   */
  async waitForLanded(
    bundleId: string,
    timeoutMs = this.cfg.bundleTimeoutMs,
  ): Promise<BundleOutcome> {
    if (bundleId.startsWith('dryrun-')) return { status: 'landed', slot: 0, bundleId };

    const deadline = Date.now() + timeoutMs;
    let pollIntervalMs = 300;

    while (Date.now() < deadline) {
      try {
        const status = await this.fetchBundleStatus(bundleId);
        if (status?.confirmation_status === 'confirmed' || status?.confirmation_status === 'finalized') {
          if (status.err && status.err.Ok !== null) {
            const reason = JSON.stringify(status.err);
            this.log.error({ bundleId, reason }, 'bundle landed with an error');
            return { status: 'failed', bundleId, reason };
          }
          this.log.info({ bundleId, slot: status.slot }, 'bundle landed');
          return { status: 'landed', slot: status.slot ?? 0, bundleId };
        }
      } catch (err) {
        // Une erreur de polling n'est pas une erreur de bundle : on repolle.
        this.log.debug({ err, bundleId }, 'bundle status poll failed');
      }
      await sleep(pollIntervalMs);
      // Backoff doux : dense au debut (le bundle atterrit en 1-2 slots ou
      // jamais), puis on releve la pression sur l'endpoint.
      pollIntervalMs = Math.min(1500, Math.round(pollIntervalMs * 1.4));
    }

    this.log.warn({ bundleId, timeoutMs }, 'bundle confirmation timed out');
    return { status: 'timeout', bundleId };
  }

  private async fetchBundleStatus(bundleId: string): Promise<{
    confirmation_status?: string;
    slot?: number;
    err?: { Ok: unknown } | null;
  } | null> {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 2000);
    try {
      const res = await fetch(`${this.cfg.httpUrl.replace(/\/+$/, '')}/api/v1/getBundleStatuses`, {
        method: 'POST',
        signal: ac.signal,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'getBundleStatuses',
          params: [[bundleId]],
        }),
      });
      if (!res.ok) throw new Error(`getBundleStatuses HTTP ${res.status}`);
      const json = (await res.json()) as {
        result?: { value?: Array<Record<string, never>> };
        error?: { message?: string };
      };
      if (json.error) throw new Error(json.error.message ?? 'getBundleStatuses error');
      return (json.result?.value?.[0] as never) ?? null;
    } finally {
      clearTimeout(timer);
    }
  }
}
