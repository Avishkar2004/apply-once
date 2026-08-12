import { MAX_PULL_LIMIT, type PushedEnvelope } from './envelope';
import { SyncError, type SyncApi } from './client';
import { UNSYNCED, type LocalEvent, type SyncStore } from './store';
import { toBase64, fromBase64 } from '../crypto/primitives';

/**
 * The sync loop (WEB.md §4.3) — shared by every client.
 *
 * ```
 * 1. Push anything local the server has not acknowledged
 * 2. Pull everything new
 * 3. Rebuild projections for applications whose events changed
 * ```
 *
 * Three deliberate departures from the pseudocode in §4.3:
 *
 *  - **No `dek` parameter.** Rows are stored sealed (see `store.ts`), so the
 *    loop moves opaque envelopes and never needs the key. Sync therefore works
 *    in states where the vault is locked, and a compromised loop cannot leak
 *    plaintext because it never holds any.
 *  - **`opened` is not in scope in step 3.** The published pseudocode declares
 *    it inside the pull loop and uses it after — it would not compile. Changed
 *    ids are accumulated across pages instead.
 *  - **Pushes are chunked.** §4.2 caps a request at 1,000 events, and a client
 *    returning from a long offline stretch can hold more than that.
 *
 * Reprojection is a **hook**. The projector (`deriveStatus`, TRACK §3.4) is
 * specified in a document not present in this repository, so the loop calls
 * whatever is registered and does nothing if that is nothing. Syncing is
 * correct without it; only the derived view is missing.
 */

/** §4.2 allows up to 1,000 per request; stay under it with room to spare. */
export const PUSH_CHUNK = 500;

/** Bound on one invocation, so a wake-up cannot run unboundedly long. */
export const MAX_PULL_PAGES = 50;

export interface SyncOutcome {
  pushed: number;
  pulled: number;
  /** Event ids that arrived from another device this run. */
  changedIds: string[];
  highWater: number;
  /**
   * Set when the loop stopped early. The loop resolves rather than throwing for
   * conditions the caller cannot act on immediately — a scheduled sync that
   * throws on every tick because the user signed out is noise, not information.
   */
  stoppedBecause?: SyncError;
  /** True when more remained than one invocation would take. */
  truncated: boolean;
}

export interface SyncDeps {
  store: SyncStore;
  api: SyncApi;
  /**
   * Rebuild derived state for the events that changed (§4.3 step 3).
   * Absent until TRACKING.md's projector exists.
   */
  reproject?: (changedIds: string[]) => Promise<void>;
  /** Injected for deterministic tests. */
  now?: () => Date;
}

export async function syncOnce(deps: SyncDeps): Promise<SyncOutcome> {
  const outcome: SyncOutcome = {
    pushed: 0,
    pulled: 0,
    changedIds: [],
    highWater: await deps.store.highWater(),
    truncated: false,
  };

  try {
    outcome.pushed = await pushPending(deps);
    const pulled = await pullNew(deps, outcome);
    outcome.pulled = pulled.count;
    outcome.changedIds = pulled.changedIds;
  } catch (error) {
    if (!(error instanceof SyncError)) throw error;
    // Everything already committed before the failure stands: push acks were
    // recorded per chunk, and the cursor advanced per page. The next run
    // resumes from there rather than redoing work.
    outcome.stoppedBecause = error;
    return outcome;
  }

  // Only reproject what actually changed (§4.3) — and only after the pull
  // committed, so a projector that throws cannot roll back a good sync.
  if (outcome.changedIds.length > 0 && deps.reproject) {
    await deps.reproject(outcome.changedIds);
  }

  return outcome;
}

/**
 * Step 1 — push.
 *
 * Chunked, and each chunk's acknowledgements are committed before the next
 * chunk is sent. If the worker dies between two chunks, the first chunk stays
 * marked synced and only the rest is retried.
 *
 * The dangerous window is between the server committing a push and this client
 * recording the acks. A crash there leaves rows marked `UNSYNCED` that the
 * server already holds — which is exactly why push is idempotent on id (§4.2):
 * the retry returns the original seqs and nothing is duplicated.
 */
async function pushPending(deps: SyncDeps): Promise<number> {
  let pushed = 0;

  for (;;) {
    const pending = await deps.store.pendingEvents(PUSH_CHUNK);
    if (pending.length === 0) return pushed;

    const { assigned } = await deps.api.push(pending.map(toEnvelope));
    await deps.store.markSynced(assigned);
    pushed += pending.length;

    // A server that acknowledged nothing would spin this loop forever.
    if (assigned.length === 0) {
      throw new SyncError('rejected', 'The sync service acknowledged no events.');
    }
    if (pending.length < PUSH_CHUNK) return pushed;
  }
}

/**
 * Step 2 — pull.
 *
 * A cursor walk. The cursor is persisted after every page, so an interruption
 * costs at most one page rather than restarting the walk.
 */
async function pullNew(
  deps: SyncDeps,
  outcome: SyncOutcome,
): Promise<{ count: number; changedIds: string[] }> {
  let cursor = await deps.store.highWater();
  let count = 0;
  const changedIds: string[] = [];

  for (let page = 0; page < MAX_PULL_PAGES; page += 1) {
    const { events, more, highWater } = await deps.api.pull(cursor, MAX_PULL_LIMIT);

    if (events.length > 0) {
      // Events this device pushed come back on the next pull. They are already
      // stored, and re-putting them would reset `syncedSeq` — so only genuinely
      // new ids are written, and only those count as changes for the projector.
      const known = await deps.store.knownEventIds(events.map((event) => event.id));
      const incoming = events.filter((event) => !known.has(event.id));

      if (incoming.length > 0) {
        await deps.store.upsertEvents(
          incoming.map((event) => ({
            id: event.id,
            deviceId: event.deviceId,
            ciphertext: fromBase64(event.ciphertext),
            iv: fromBase64(event.iv),
            syncedSeq: event.seq,
            createdAt: event.createdAt,
          })),
        );
        changedIds.push(...incoming.map((event) => event.id));
      }
      count += incoming.length;
    }

    // Only advance past what the server actually returned. The server already
    // guarantees this, but a client that trusted a bogus `highWater` would
    // silently skip events forever.
    const next = Math.max(cursor, Math.min(highWater, lastSeq(events) ?? highWater));
    if (next !== cursor) {
      cursor = next;
      await deps.store.setHighWater(cursor);
      outcome.highWater = cursor;
    }

    if (!more) return { count, changedIds };

    // The server says there is more but gave us nothing and moved no cursor —
    // continuing would loop forever.
    if (events.length === 0) {
      throw new SyncError('rejected', 'The sync service reported more events but returned none.');
    }
  }

  outcome.truncated = true;
  return { count, changedIds };
}

function lastSeq(events: Array<{ seq: number }>): number | undefined {
  return events.length ? events[events.length - 1]!.seq : undefined;
}

function toEnvelope(event: LocalEvent): PushedEnvelope {
  return {
    id: event.id,
    deviceId: event.deviceId,
    ciphertext: toBase64(event.ciphertext),
    iv: toBase64(event.iv),
  };
}

/** Convenience for callers building a local row before it has been pushed. */
export function unsyncedEvent(
  input: Omit<LocalEvent, 'syncedSeq' | 'createdAt'> & { createdAt?: string },
): LocalEvent {
  return {
    ...input,
    syncedSeq: UNSYNCED,
    createdAt: input.createdAt ?? new Date().toISOString(),
  };
}
