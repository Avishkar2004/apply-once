import Dexie, { type Table } from 'dexie';
import type { CanonicalKey } from '@autofill/core';
import type { MappingSource } from '@/shared/types';

/**
 * The local database (ARCHITECTURE.md §4, "Storage layout").
 *
 * What is encrypted and what is not, deliberately:
 *
 *  - `profile`, `documents`, `answerBank` hold PII and are stored as AES-GCM
 *    envelopes. Only the service worker, holding the DEK, can read them.
 *  - `overrides` and `mappingCache` hold hostnames, field signatures and
 *    canonical *key names* — no profile values. They stay in the clear because
 *    Tier 0 is specified at ~0ms (§3.2) and a per-lookup decrypt would not be.
 *  - `auditLog` is by definition user-visible (§6.8).
 *
 * Non-sensitive preferences live in `chrome.storage.sync`, not here — see
 * `storage/settings.ts`.
 */

export interface SealedRecordFields {
  iv: Uint8Array;
  ciphertext: Uint8Array;
}

/** Free-form singletons: the vault record, the sync high-water mark, flags. */
export interface MetaRecord {
  key: string;
  value: unknown;
}

export interface ProfileRecord extends SealedRecordFields {
  /** Always `'primary'` — one profile per installation. */
  id: string;
  updatedAt: string;
}

export interface DocumentRecord extends SealedRecordFields {
  blobId: string;
  filename: string;
  mimeType: string;
  byteSize: number;
  createdAt: string;
}

export interface AnswerRecord extends SealedRecordFields {
  /** sha256 of the normalised question text (+ company when company-specific). */
  questionHash: string;
  company?: string;
  usedCount: number;
  lastUsed: string;
}

export interface MappingCacheRecord {
  /** hash(hostname + signature) — one LLM call per site, not per application. */
  cacheKey: string;
  hostname: string;
  canonicalKey: CanonicalKey | 'FREE_TEXT' | 'UNMAPPABLE';
  confidence: number;
  source: MappingSource;
  createdAt: string;
}

export interface OverrideRecord {
  /** `${hostname}::${signature}` — the compound primary key. */
  id: string;
  hostname: string;
  signature: string;
  canonicalKey: CanonicalKey;
  /** The label as it appeared when the correction was made, for the settings UI. */
  label?: string;
  createdAt: string;
}

/**
 * One application, not one fill.
 *
 * Filling the same form three times is one thing that happened to the user, so
 * a repeat updates the row and bumps `fills` rather than appending. Without
 * that, the history reads as noise the moment anyone corrects a field and
 * re-fills.
 */
export interface AuditEntry {
  id?: number;
  hostname: string;
  url: string;
  adapter?: string;
  /** Scraped from the page (§3.2) — what turns a hostname into an application. */
  jobTitle?: string;
  company?: string;
  /** Most recent fill. */
  at: string;
  /** First fill, so the history can say when an application was started. */
  firstAt?: string;
  /** Times filled. Absent on rows written before v3; read as 1. */
  fills?: number;
  filled: number;
  lowConfidence: number;
  rejected: number;
  skipped: number;
}

/**
 * A synced event, held **sealed** (WEB.md §4.1, ARCHITECTURE.md §6.2).
 *
 * The ciphertext is exactly what goes over the wire and exactly what came back,
 * so a retried push is byte-identical and the sync loop never needs the DEK.
 * Only the projector opens these, and only when the vault is unlocked.
 */
export interface EventRecord extends SealedRecordFields {
  /** UUIDv7 from the device that created it. */
  id: string;
  deviceId: string;
  /** Server-assigned seq, or `-1` while unacknowledged — this is the push queue. */
  syncedSeq: number;
  createdAt: string;
}

export class AutoFillDatabase extends Dexie {
  meta!: Table<MetaRecord, string>;
  profile!: Table<ProfileRecord, string>;
  documents!: Table<DocumentRecord, string>;
  answerBank!: Table<AnswerRecord, string>;
  mappingCache!: Table<MappingCacheRecord, string>;
  overrides!: Table<OverrideRecord, string>;
  auditLog!: Table<AuditEntry, number>;
  events!: Table<EventRecord, string>;

  constructor(name = 'autofill') {
    super(name);
    this.version(1).stores({
      meta: 'key',
      profile: 'id',
      documents: 'blobId, createdAt',
      answerBank: 'questionHash, company, lastUsed',
      mappingCache: 'cacheKey, hostname, createdAt',
      overrides: 'id, hostname, signature',
      auditLog: '++id, hostname, at',
    });

    // v2 adds the sync event log. Dexie carries the v1 stores forward, so only
    // the new table is declared. `syncedSeq` is indexed because the push queue
    // is a range query over it on every sync (§4.3).
    this.version(2).stores({
      events: 'id, syncedSeq, createdAt',
    });

    // v3 indexes `auditLog.url` so a repeat fill can find the application it
    // belongs to instead of appending a duplicate row. The added `jobTitle`,
    // `company`, `firstAt` and `fills` fields need no declaration — Dexie only
    // wants the indexed ones — and existing rows simply lack them.
    this.version(3).stores({
      auditLog: '++id, hostname, at, url',
    });
  }
}

let instance: AutoFillDatabase | undefined;

/** Lazily opened singleton. A service worker may be torn down between messages. */
export function db(): AutoFillDatabase {
  instance ??= new AutoFillDatabase();
  return instance;
}

/** Test seam — lets a suite swap in a fresh database. */
export function __setDatabaseForTests(next: AutoFillDatabase | undefined): void {
  instance = next;
}

export const PROFILE_RECORD_ID = 'primary';
export const VAULT_META_KEY = 'vault';
