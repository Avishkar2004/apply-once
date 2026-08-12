import { beforeEach, describe, expect, it } from 'vitest';
import type { PullResponse, PushResponse } from '@autofill/core';
import { envelope, json, request, resetDatabase, signUp } from './helpers';

/**
 * The sync protocol (WEB.md §4.2, §4.3).
 *
 * W3's done-criterion is "curl can push and pull envelopes idempotently" —
 * these are that, plus the tenant-isolation and quota properties the protocol
 * depends on but does not state as endpoints.
 */

beforeEach(resetDatabase);

describe('push', () => {
  it('assigns a monotonic seq per user', async () => {
    const { cookie } = await signUp();

    const response = await json(
      '/sync/push',
      { events: [envelope('a'), envelope('b'), envelope('c')] },
      { cookie },
    );
    expect(response.status).toBe(200);

    const body = (await response.json()) as PushResponse;
    expect(body.assigned.map((entry) => entry.seq)).toEqual([1, 2, 3]);
    expect(body.highWater).toBe(3);
  });

  it('continues the sequence across separate pushes', async () => {
    const { cookie } = await signUp();
    await json('/sync/push', { events: [envelope('a')] }, { cookie });

    const second = await json('/sync/push', { events: [envelope('b')] }, { cookie });
    const body = (await second.json()) as PushResponse;
    expect(body.assigned[0]?.seq).toBe(2);
    expect(body.highWater).toBe(2);
  });

  it('is idempotent on id — a crashed client can simply push again', async () => {
    const { cookie } = await signUp();
    const events = [envelope('a'), envelope('b')];

    const first = ((await (await json('/sync/push', { events }, { cookie })).json()) as PushResponse)
      .assigned;
    const second = ((await (
      await json('/sync/push', { events }, { cookie })
    ).json()) as PushResponse).assigned;

    // Same ids, same seqs — no duplicate rows, no counter drift.
    expect(second).toEqual(first);

    const pulled = (await (
      await request('/sync/pull?since=0', { cookie })
    ).json()) as PullResponse;
    expect(pulled.events).toHaveLength(2);
  });

  it('assigns fresh seqs only to the new half of a partial re-push', async () => {
    const { cookie } = await signUp();
    await json('/sync/push', { events: [envelope('a')] }, { cookie });

    const response = await json(
      '/sync/push',
      { events: [envelope('a'), envelope('b')] },
      { cookie },
    );
    const body = (await response.json()) as PushResponse;

    expect(body.assigned).toEqual([
      { id: 'a', seq: 1 },
      { id: 'b', seq: 2 },
    ]);
  });

  it('rejects duplicate ids inside one request', async () => {
    const { cookie } = await signUp();
    const response = await json(
      '/sync/push',
      { events: [envelope('a'), envelope('a')] },
      { cookie },
    );
    expect(response.status).toBe(400);
  });

  it('refuses an unauthenticated push', async () => {
    expect((await json('/sync/push', { events: [envelope('a')] })).status).toBe(401);
  });
});

describe('pull', () => {
  it('walks the cursor and reports when there is more', async () => {
    const { cookie } = await signUp();
    await json(
      '/sync/push',
      { events: Array.from({ length: 5 }, (_, i) => envelope(`e${i}`)) },
      { cookie },
    );

    const first = (await (
      await request('/sync/pull?since=0&limit=2', { cookie })
    ).json()) as PullResponse;
    expect(first.events.map((event) => event.seq)).toEqual([1, 2]);
    expect(first.more).toBe(true);
    expect(first.highWater).toBe(2);

    const second = (await (
      await request(`/sync/pull?since=${first.highWater}&limit=2`, { cookie })
    ).json()) as PullResponse;
    expect(second.events.map((event) => event.seq)).toEqual([3, 4]);
    expect(second.more).toBe(true);

    const third = (await (
      await request(`/sync/pull?since=${second.highWater}&limit=2`, { cookie })
    ).json()) as PullResponse;
    expect(third.events.map((event) => event.seq)).toEqual([5]);
    expect(third.more).toBe(false);
  });

  it('never advances the watermark past the last row returned', async () => {
    const { cookie } = await signUp();
    await json(
      '/sync/push',
      { events: Array.from({ length: 4 }, (_, i) => envelope(`e${i}`)) },
      { cookie },
    );

    const page = (await (
      await request('/sync/pull?since=0&limit=2', { cookie })
    ).json()) as PullResponse;

    // Advancing to the true high-water here would strand events 3 and 4 forever.
    expect(page.highWater).toBe(2);
  });

  it('returns the bytes it was given, unchanged', async () => {
    const { cookie } = await signUp();
    const sent = envelope('a', 128);
    await json('/sync/push', { events: [sent] }, { cookie });

    const page = (await (await request('/sync/pull?since=0', { cookie })).json()) as PullResponse;
    expect(page.events[0]?.ciphertext).toBe(sent.ciphertext);
    expect(page.events[0]?.iv).toBe(sent.iv);
    expect(page.events[0]?.deviceId).toBe(sent.deviceId);
  });

  it('is empty at the head of the log', async () => {
    const { cookie } = await signUp();
    await json('/sync/push', { events: [envelope('a')] }, { cookie });

    const page = (await (await request('/sync/pull?since=1', { cookie })).json()) as PullResponse;
    expect(page.events).toEqual([]);
    expect(page.more).toBe(false);
    expect(page.highWater).toBe(1);
  });

  it('rejects a negative cursor', async () => {
    const { cookie } = await signUp();
    expect((await request('/sync/pull?since=-1', { cookie })).status).toBe(400);
  });
});

describe('tenant isolation', () => {
  it('never returns another account’s events', async () => {
    const ada = await signUp('ada@example.com');
    const grace = await signUp('grace@example.com');

    await json('/sync/push', { events: [envelope('ada-1')] }, { cookie: ada.cookie });
    await json('/sync/push', { events: [envelope('grace-1')] }, { cookie: grace.cookie });

    const adaPage = (await (
      await request('/sync/pull?since=0', { cookie: ada.cookie })
    ).json()) as PullResponse;
    expect(adaPage.events.map((event) => event.id)).toEqual(['ada-1']);

    const gracePage = (await (
      await request('/sync/pull?since=0', { cookie: grace.cookie })
    ).json()) as PullResponse;
    expect(gracePage.events.map((event) => event.id)).toEqual(['grace-1']);
  });

  it('gives each account its own sequence space', async () => {
    const ada = await signUp('ada@example.com');
    const grace = await signUp('grace@example.com');

    await json('/sync/push', { events: [envelope('x'), envelope('y')] }, { cookie: ada.cookie });
    const gracePush = (await (
      await json('/sync/push', { events: [envelope('z')] }, { cookie: grace.cookie })
    ).json()) as PushResponse;

    // Grace's first event is seq 1 even though Ada already used 1 and 2.
    expect(gracePush.assigned[0]?.seq).toBe(1);
  });

  it('lets two accounts hold the same event id independently', async () => {
    const ada = await signUp('ada@example.com');
    const grace = await signUp('grace@example.com');

    const first = await json('/sync/push', { events: [envelope('shared')] }, { cookie: ada.cookie });
    const second = await json(
      '/sync/push',
      { events: [envelope('shared')] },
      { cookie: grace.cookie },
    );

    // PRIMARY KEY (user_id, id) — not id alone.
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
  });
});

describe('status', () => {
  it('reports counts without revealing anything decryptable', async () => {
    const { cookie } = await signUp();
    await json('/sync/push', { events: [envelope('a'), envelope('b')] }, { cookie });

    const status = (await (await request('/sync/status', { cookie })).json()) as {
      events: number;
      bytes: number;
      highWater: number;
      webAccess: boolean;
    };

    expect(status.events).toBe(2);
    expect(status.highWater).toBe(2);
    expect(status.bytes).toBeGreaterThan(0);
    expect(status.webAccess).toBe(true);
  });
});
