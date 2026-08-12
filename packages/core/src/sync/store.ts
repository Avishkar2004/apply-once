/**
 * What the sync loop needs from local storage.
 *
 * An interface rather than a Dexie table because `packages/core` must not
 * depend on a storage backend (WEB.md §9 — "no DOM, no `chrome.*`"; the lint
 * rule in `eslint.config.js` also bans importing `dexie` here). The extension
 * implements this over Dexie; a future web client implements it over its own.
 * Both then run the *same* loop, which is what §9 is protecting.
 */

/**
 * A locally-held event, **sealed**.
 *
 * ARCHITECTURE.md §6.2 requires data to be encrypted at rest, so the extension
 * stores the ciphertext it will push — or the ciphertext it pulled — and never
 * the plaintext. Two consequences worth stating:
 *
 *  - **Push is byte-stable.** Re-sealing on every attempt would mint a fresh IV
 *    each time, so a retried push would carry different bytes under the same id.
 *    The server dedups on id so it would still be correct, but storing sealed
 *    means the retry is byte-identical, which is a far easier property to reason
 *    about and to test.
 *  - **The loop never needs the DEK.** It moves opaque envelopes. Only the
 *    projector opens them, and only when the vault is unlocked.
 *
 * WEB.md §4.3's pseudocode stores `opened` events instead. That reflects the web
 * app, where §6.2 has IndexedDB holding the decrypted projection after unlock —
 * a different client with a different threat model.
 */
export interface LocalEvent {
  /** UUIDv7, generated on the device that created the event. The dedup key. */
  id: string;
  deviceId: string;
  /** AES-GCM ciphertext, AAD `af1:event:<id>`. Opaque here. */
  ciphertext: Uint8Array;
  iv: Uint8Array;
  /**
   * The server-assigned sequence number, or `UNSYNCED` while the server has
   * not acknowledged it. This is the push queue: "everything local the server
   * has not acknowledged" is one indexed range query (§4.3).
   */
  syncedSeq: number;
  /** Local clock. Used for ordering the push queue and for GC — never for merge. */
  createdAt: string;
}

/** Sentinel for "the server has not acknowledged this yet" (§4.3). */
export const UNSYNCED = -1;

export interface SyncStore {
  /** Events the server has not acknowledged, oldest first. */
  pendingEvents(limit: number): Promise<LocalEvent[]>;
  /** Mark pushed events with the seq the server assigned them. */
  markSynced(assigned: Array<{ id: string; seq: number }>): Promise<void>;
  /**
   * Union-by-id. §4.3: "dedup is free" — a `put` keyed on id makes a re-pulled
   * event a no-op rather than a duplicate.
   *
   * Must not clobber a local row that is still pending: see `loop.ts`.
   */
  upsertEvents(events: LocalEvent[]): Promise<void>;
  /** Ids already present locally, from the given candidates. */
  knownEventIds(ids: string[]): Promise<Set<string>>;

  /** The pull cursor. §4.3 keeps it in local meta, per client. */
  highWater(): Promise<number>;
  setHighWater(value: number): Promise<void>;

  countEvents(): Promise<number>;
  countPending(): Promise<number>;
}
