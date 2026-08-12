import { describe, expect, it, vi } from 'vitest';
import {
  PUSH_CHUNK,
  SyncError,
  syncOnce,
  toBase64,
  UNSYNCED,
  unsyncedEvent,
  type LocalEvent,
  type PullResponse,
  type PushResponse,
  type SyncApi,
  type SyncStore,
} from '../src/index';

/**
 * The sync loop (WEB.md §4.3), and the failure modes its pseudocode omits.
 *
 * An in-memory `SyncStore` stands in for Dexie. That is the point of the store
 * being an interface: the loop under test here is byte-for-byte the one the
 * extension runs.
 */

function memoryStore(seed: LocalEvent[] = []): SyncStore & { rows: Map<string, LocalEvent> } {
  const rows = new Map(seed.map((event) => [event.id, event]));
  let water = 0;

  return {
    rows,
    async pendingEvents(limit) {
      return [...rows.values()]
        .filter((event) => event.syncedSeq === UNSYNCED)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
        .slice(0, limit);
    },
    async markSynced(assigned) {
      for (const { id, seq } of assigned) {
        const row = rows.get(id);
        if (row) rows.set(id, { ...row, syncedSeq: seq });
      }
    },
    async upsertEvents(events) {
      for (const event of events) rows.set(event.id, event);
    },
    async knownEventIds(ids) {
      return new Set(ids.filter((id) => rows.has(id)));
    },
    async highWater() {
      return water;
    },
    async setHighWater(value) {
      water = value;
    },
    async countEvents() {
      return rows.size;
    },
    async countPending() {
      return [...rows.values()].filter((e) => e.syncedSeq === UNSYNCED).length;
    },
  };
}

const localEvent = (id: string, createdAt = '2026-08-12T00:00:00Z'): LocalEvent =>
  unsyncedEvent({
    id,
    deviceId: 'device-a',
    ciphertext: new Uint8Array(32).fill(1),
    iv: new Uint8Array(12).fill(2),
    createdAt,
  });

const remoteEvent = (id: string, seq: number) => ({
  id,
  userId: 'u1',
  seq,
  deviceId: 'device-b',
  ciphertext: toBase64(new Uint8Array(32).fill(3)),
  iv: toBase64(new Uint8Array(12).fill(4)),
  createdAt: '2026-08-12T00:00:00Z',
});

function stubApi(overrides: Partial<SyncApi> = {}): SyncApi {
  return {
    push: async (events) => ({
      assigned: events.map((event, index) => ({ id: event.id, seq: index + 1 })),
      highWater: events.length,
    }),
    pull: async () => ({ events: [], highWater: 0, more: false }),
    ...overrides,
  };
}

describe('push', () => {
  it('sends pending events and records the seqs it got back', async () => {
    const store = memoryStore([localEvent('a'), localEvent('b', '2026-08-12T00:00:01Z')]);
    const outcome = await syncOnce({ store, api: stubApi() });

    expect(outcome.pushed).toBe(2);
    expect(store.rows.get('a')?.syncedSeq).toBe(1);
    expect(store.rows.get('b')?.syncedSeq).toBe(2);
  });

  it('sends nothing when everything is already acknowledged', async () => {
    const store = memoryStore([{ ...localEvent('a'), syncedSeq: 4 }]);
    const push = vi.fn(stubApi().push);

    await syncOnce({ store, api: stubApi({ push }) });
    expect(push).not.toHaveBeenCalled();
  });

  it('chunks a backlog larger than one request allows', async () => {
    const seed = Array.from({ length: PUSH_CHUNK + 20 }, (_, i) =>
      localEvent(`e${i}`, `2026-08-12T00:00:${String(i % 60).padStart(2, '0')}Z`),
    );
    const store = memoryStore(seed);

    const sizes: number[] = [];
    const push = vi.fn(async (events: Parameters<SyncApi['push']>[0]): Promise<PushResponse> => {
      sizes.push(events.length);
      return {
        assigned: events.map((event, index) => ({ id: event.id, seq: sizes.length * 1000 + index })),
        highWater: 0,
      };
    });

    const outcome = await syncOnce({ store, api: stubApi({ push }) });

    expect(sizes[0]).toBe(PUSH_CHUNK);
    expect(outcome.pushed).toBe(seed.length);
    expect(await store.countPending()).toBe(0);
  });

  it('pushes byte-identical envelopes on a retry — rows are stored sealed', async () => {
    const store = memoryStore([localEvent('a')]);
    const sent: string[] = [];

    const push = vi.fn(async (events: Parameters<SyncApi['push']>[0]): Promise<PushResponse> => {
      sent.push(events[0]!.ciphertext);
      throw new SyncError('transient', 'network blip');
    });

    await syncOnce({ store, api: stubApi({ push }) });
    await syncOnce({ store, api: stubApi({ push }) });

    // Re-sealing on push would mint a new IV and change these bytes.
    expect(sent[0]).toBe(sent[1]);
  });

  it('stops rather than spinning if the server acknowledges nothing', async () => {
    const store = memoryStore([localEvent('a')]);
    const outcome = await syncOnce({
      store,
      api: stubApi({ push: async () => ({ assigned: [], highWater: 0 }) }),
    });

    expect(outcome.stoppedBecause?.kind).toBe('rejected');
  });
});

describe('pull', () => {
  it('stores new events and advances the cursor', async () => {
    const store = memoryStore();
    const outcome = await syncOnce({
      store,
      api: stubApi({
        pull: async () => ({ events: [remoteEvent('r1', 1), remoteEvent('r2', 2)], highWater: 2, more: false }),
      }),
    });

    expect(outcome.pulled).toBe(2);
    expect(outcome.changedIds).toEqual(['r1', 'r2']);
    expect(await store.highWater()).toBe(2);
    expect(store.rows.get('r1')?.syncedSeq).toBe(1);
  });

  it('walks every page', async () => {
    const pages: PullResponse[] = [
      { events: [remoteEvent('r1', 1)], highWater: 1, more: true },
      { events: [remoteEvent('r2', 2)], highWater: 2, more: true },
      { events: [remoteEvent('r3', 3)], highWater: 3, more: false },
    ];
    const store = memoryStore();
    const outcome = await syncOnce({
      store,
      api: stubApi({ pull: async (since) => pages[since] ?? pages[2]! }),
    });

    expect(outcome.pulled).toBe(3);
    expect(await store.highWater()).toBe(3);
  });

  it('does not reset syncedSeq on events this device pushed', async () => {
    // The echo problem: what we push comes back on the next pull.
    const store = memoryStore([{ ...localEvent('a'), syncedSeq: 7 }]);

    const outcome = await syncOnce({
      store,
      api: stubApi({
        pull: async () => ({
          events: [{ ...remoteEvent('a', 7), deviceId: 'device-a' }],
          highWater: 7,
          more: false,
        }),
      }),
    });

    expect(outcome.pulled).toBe(0);
    // Nothing changed, so the projector must not be told it did.
    expect(outcome.changedIds).toEqual([]);
    expect(store.rows.get('a')?.syncedSeq).toBe(7);
  });

  it('never advances the cursor past the last row returned', async () => {
    const store = memoryStore();
    await syncOnce({
      store,
      api: stubApi({
        // A server (or proxy) claiming a high-water far beyond what it sent.
        pull: async () => ({ events: [remoteEvent('r1', 1)], highWater: 9999, more: false }),
      }),
    });

    // Trusting 9999 would silently skip events 2..9999 forever.
    expect(await store.highWater()).toBe(1);
  });

  it('stops rather than looping if the server claims more but sends none', async () => {
    const store = memoryStore();
    const outcome = await syncOnce({
      store,
      api: stubApi({ pull: async () => ({ events: [], highWater: 0, more: true }) }),
    });

    expect(outcome.stoppedBecause?.kind).toBe('rejected');
  });

  it('bounds one invocation so a wake-up cannot run forever', async () => {
    const store = memoryStore();
    let seq = 0;
    const outcome = await syncOnce({
      store,
      api: stubApi({
        pull: async () => {
          seq += 1;
          return { events: [remoteEvent(`r${seq}`, seq)], highWater: seq, more: true };
        },
      }),
    });

    expect(outcome.truncated).toBe(true);
  });
});

describe('failure handling', () => {
  it.each([
    ['unauthenticated', 401],
    ['forbidden', 403],
    ['quota', 413],
  ] as const)('reports %s without throwing at the caller', async (kind, status) => {
    const store = memoryStore([localEvent('a')]);
    const outcome = await syncOnce({
      store,
      api: stubApi({
        push: async () => {
          throw new SyncError(kind, 'nope', status);
        },
      }),
    });

    expect(outcome.stoppedBecause?.kind).toBe(kind);
    expect(outcome.pushed).toBe(0);
  });

  it('keeps a pull that already committed when a later page fails', async () => {
    const store = memoryStore();
    let call = 0;
    const outcome = await syncOnce({
      store,
      api: stubApi({
        pull: async () => {
          call += 1;
          if (call === 1) return { events: [remoteEvent('r1', 1)], highWater: 1, more: true };
          throw new SyncError('transient', 'connection lost');
        },
      }),
    });

    expect(outcome.stoppedBecause?.retryable).toBe(true);
    // The first page is banked; the next run resumes from seq 1, not from zero.
    expect(await store.highWater()).toBe(1);
    expect(store.rows.has('r1')).toBe(true);
  });

  it('rethrows a non-sync error rather than swallowing a bug', async () => {
    const store = memoryStore([localEvent('a')]);
    await expect(
      syncOnce({
        store,
        api: stubApi({
          push: async () => {
            throw new TypeError('genuine bug');
          },
        }),
      }),
    ).rejects.toBeInstanceOf(TypeError);
  });
});

describe('reprojection (§4.3 step 3)', () => {
  it('runs only for events that actually changed', async () => {
    const store = memoryStore();
    const reproject = vi.fn(async () => undefined);

    await syncOnce({
      store,
      api: stubApi({
        pull: async () => ({ events: [remoteEvent('r1', 1)], highWater: 1, more: false }),
      }),
      reproject,
    });

    expect(reproject).toHaveBeenCalledWith(['r1']);
  });

  it('is skipped when nothing changed', async () => {
    const store = memoryStore();
    const reproject = vi.fn(async () => undefined);

    await syncOnce({ store, api: stubApi(), reproject });
    expect(reproject).not.toHaveBeenCalled();
  });

  it('syncs correctly with no projector registered — TRACKING.md is absent', async () => {
    const store = memoryStore();
    const outcome = await syncOnce({
      store,
      api: stubApi({
        pull: async () => ({ events: [remoteEvent('r1', 1)], highWater: 1, more: false }),
      }),
    });

    expect(outcome.pulled).toBe(1);
    expect(store.rows.has('r1')).toBe(true);
  });
});

describe('convergence (§2 — a grow-only set)', () => {
  it('two devices offline for a week end up identical', async () => {
    const serverLog: Array<ReturnType<typeof remoteEvent>> = [];
    let nextSeq = 0;

    const sharedApi = (): SyncApi => ({
      async push(events) {
        const assigned = events.map((event) => {
          const existing = serverLog.find((row) => row.id === event.id);
          if (existing) return { id: event.id, seq: existing.seq };
          nextSeq += 1;
          serverLog.push({ ...remoteEvent(event.id, nextSeq), deviceId: event.deviceId });
          return { id: event.id, seq: nextSeq };
        });
        return { assigned, highWater: nextSeq };
      },
      async pull(since) {
        const page = serverLog.filter((row) => row.seq > since);
        return { events: page, highWater: page.at(-1)?.seq ?? since, more: false };
      },
    });

    const ada = memoryStore([localEvent('ada-1'), localEvent('ada-2', '2026-08-12T00:00:01Z')]);
    const grace = memoryStore([localEvent('grace-1')]);

    // Each syncs twice: once to push and see its own, once to see the other's.
    for (const store of [ada, grace, ada, grace]) {
      await syncOnce({ store, api: sharedApi() });
    }

    const ids = (store: typeof ada) => [...store.rows.keys()].sort();
    expect(ids(ada)).toEqual(ids(grace));
    expect(ids(ada)).toEqual(['ada-1', 'ada-2', 'grace-1']);
  });
});
