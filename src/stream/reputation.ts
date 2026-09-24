/**
 * Cache de réputation des créateurs.
 *
 * Toute la connaissance sur un créateur est consultable en O(1) au moment où
 * son token apparaît : lancements observés par le flux, ventes rapides passées
 * et historique RPC enrichi en arrière-plan. Le cache est persisté sur disque
 * (JSON) pour survivre aux redémarrages : plus le flux tourne longtemps,
 * plus il reconnaît les déployeurs en série.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { CreatorSnapshot } from './fast-score.js';

const DAY_MS = 86_400_000;
const MAX_LAUNCHES = 50;
const MAX_MINTS = 20;
/** Durée de validité d'un enrichissement RPC. */
export const ENRICHMENT_TTL_MS = 6 * 3_600_000;
/** Les créateurs inactifs depuis ce délai sont purgés du cache. */
const RETENTION_MS = 14 * DAY_MS;

export interface CreatorRecord {
  /** Horodatages (ms) des lancements observés. */
  launches: number[];
  mints: string[];
  devSells: number;
  lastSeen: number;
  enrichment?: CreatorSnapshot['enrichment'] & { at: number };
}

export class ReputationStore {
  private readonly records = new Map<string, CreatorRecord>();
  private dirty = false;

  constructor(private readonly path?: string) {}

  get size(): number {
    return this.records.size;
  }

  private record(address: string): CreatorRecord {
    let record = this.records.get(address);
    if (!record) {
      record = { launches: [], mints: [], devSells: 0, lastSeen: 0 };
      this.records.set(address, record);
    }
    return record;
  }

  recordLaunch(address: string, mint: string, now = Date.now()): void {
    const record = this.record(address);
    if (record.mints.includes(mint)) return;
    record.launches.push(now);
    if (record.launches.length > MAX_LAUNCHES) record.launches.shift();
    record.mints.push(mint);
    if (record.mints.length > MAX_MINTS) record.mints.shift();
    record.lastSeen = now;
    this.dirty = true;
  }

  recordDevSell(address: string): void {
    this.record(address).devSells++;
    this.dirty = true;
  }

  setEnrichment(address: string, enrichment: NonNullable<CreatorSnapshot['enrichment']>, now = Date.now()): void {
    this.record(address).enrichment = { ...enrichment, at: now };
    this.dirty = true;
  }

  /** Vrai si l'historique RPC du créateur est absent ou périmé. */
  needsEnrichment(address: string, now = Date.now()): boolean {
    const enrichment = this.records.get(address)?.enrichment;
    return !enrichment || now - enrichment.at > ENRICHMENT_TTL_MS;
  }

  /** Vue instantanée utilisée par le score rapide (O(nombre de lancements), ≤ 50). */
  snapshot(address: string, now = Date.now()): CreatorSnapshot {
    const record = this.records.get(address);
    if (!record) return { address, launches24h: 0, devSellsSeen: 0 };
    let launches24h = 0;
    for (const t of record.launches) if (now - t < DAY_MS) launches24h++;
    const fresh = record.enrichment && now - record.enrichment.at <= ENRICHMENT_TTL_MS ? record.enrichment : undefined;
    return {
      address,
      launches24h,
      devSellsSeen: record.devSells,
      enrichment: fresh
        ? {
            previousTokensCreated: fresh.previousTokensCreated,
            signatureCount: fresh.signatureCount,
            fullHistory: fresh.fullHistory,
            walletAgeDays: fresh.walletAgeDays,
            solBalance: fresh.solBalance,
            txScanned: fresh.txScanned,
          }
        : undefined,
    };
  }

  load(): number {
    if (!this.path) return 0;
    try {
      const raw = JSON.parse(readFileSync(this.path, 'utf8')) as Record<string, CreatorRecord>;
      for (const [address, record] of Object.entries(raw)) this.records.set(address, record);
      return this.records.size;
    } catch {
      return 0; // premier lancement ou fichier illisible : cache vide
    }
  }

  /** Écriture atomique (fichier temporaire puis renommage) et purge des entrées anciennes. */
  save(now = Date.now()): void {
    if (!this.path || !this.dirty) return;
    for (const [address, record] of this.records) {
      if (now - record.lastSeen > RETENTION_MS) this.records.delete(address);
    }
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(Object.fromEntries(this.records)));
    renameSync(tmp, this.path);
    this.dirty = false;
  }
}
