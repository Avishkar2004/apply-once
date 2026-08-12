import { UNSYNCED, type LocalEvent, type SyncStore } from '@autofill/core';
import { db } from '@/storage/db';

/**
 * `SyncStore` over Dexie.
 *
 * This is the only file that knows the sync loop stores anything in IndexedDB.
 * The loop itself is in `packages/core` and is storage-agnostic, which is what
 * lets the extension and a future web client run byte-identical sync logic
 * (WEB.md §9).
 */

const HIGH_WATER_KEY = 'sync:highWater';

export const dexieSyncStore: SyncStore = {
  async pendingEvents(limit) {
    const rows = await db()
      .events.where('syncedSeq')
      .equals(UNSYNCED)
      .limit(limit)
      .toArray();

    // Oldest first, so a partial push drains the backlog in order.
    return rows
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map((row) => ({
        id: row.id,
        deviceId: row.deviceId,
        ciphertext: row.ciphertext,
        iv: row.iv,
        syncedSeq: row.syncedSeq,
        createdAt: row.createdAt,
      }));
  },

  async markSynced(assigned) {
    // One transaction: a crash mid-way must not leave half the chunk marked.
    await db().transaction('rw', db().events, async () => {
      for (const { id, seq } of assigned) {
        await db().events.update(id, { syncedSeq: seq });
      }
    });
  },

  async upsertEvents(events: LocalEvent[]) {
    await db().events.bulkPut(
      events.map((event) => ({
        id: event.id,
        deviceId: event.deviceId,
        ciphertext: event.ciphertext,
        iv: event.iv,
        syncedSeq: event.syncedSeq,
        createdAt: event.createdAt,
      })),
    );
  },

  async knownEventIds(ids) {
    const found = await db().events.where('id').anyOf(ids).primaryKeys();
    return new Set(found);
  },

  async highWater() {
    const record = await db().meta.get(HIGH_WATER_KEY);
    return typeof record?.value === 'number' ? record.value : 0;
  },

  async setHighWater(value) {
    await db().meta.put({ key: HIGH_WATER_KEY, value });
  },

  async countEvents() {
    return db().events.count();
  },

  async countPending() {
    return db().events.where('syncedSeq').equals(UNSYNCED).count();
  },
};

/** Local-only reset — used when signing out of a sync account. */
export async function clearSyncState(): Promise<void> {
  await db().meta.delete(HIGH_WATER_KEY);
}
