import { beforeEach, describe, expect, it } from 'vitest';
import type { PullResponse, PushResponse } from '@autofill/core';
import { envelope, json, request, resetDatabase, signUp } from './helpers';

/**
 * Large pushes — regression cover for the SQL-variable limit.
 *
 * The idempotency lookup binds one SQL variable per event id. D1 caps a
 * statement at roughly 100 variables, so an unchunked `id IN (?,?,…)` returned
 * `D1_ERROR: too many SQL variables` — a 500 — for any push above ~99 events.
 *
 * That is not an edge case. WEB.md §6.2 projects ~2,700 events on a first load,
 * and §4.2 lets a client send up to 1,000 per request, so the very first sync of
 * a populated account would have failed.
 *
 * These tests exist because a review agent probed the boundary and found it.
 */

beforeEach(resetDatabase);

describe('large pushes (D1 SQL-variable limit)', () => {
  it('accepts a push just past the variable cap', async () => {
    const { cookie } = await signUp();
    const events = Array.from({ length: 150 }, (_, i) => envelope(`e${i}`));

    const response = await json('/sync/push', { events }, { cookie });
    expect(response.status).toBe(200);

    const body = (await response.json()) as PushResponse;
    expect(body.assigned).toHaveLength(150);
    expect(body.highWater).toBe(150);
  });

  it('accepts a push at the documented per-request maximum', async () => {
    const { cookie } = await signUp('b@example.com');
    const events = Array.from({ length: 1000 }, (_, i) => envelope(`e${i}`));

    const response = await json('/sync/push', { events }, { cookie });
    expect(response.status).toBe(200);

    const body = (await response.json()) as PushResponse;
    expect(body.assigned).toHaveLength(1000);
    expect(body.highWater).toBe(1000);
  });

  it('assigns every seq exactly once across a large push', async () => {
    const { cookie } = await signUp('c@example.com');
    const events = Array.from({ length: 250 }, (_, i) => envelope(`e${i}`));

    const body = (await (
      await json('/sync/push', { events }, { cookie })
    ).json()) as PushResponse;

    const seqs = body.assigned.map((entry) => entry.seq).sort((a, b) => a - b);
    expect(new Set(seqs).size).toBe(250);
    expect(seqs[0]).toBe(1);
    expect(seqs.at(-1)).toBe(250);
  });

  it('maps each id to its own seq, not to a neighbour’s', async () => {
    const { cookie } = await signUp('d@example.com');
    const events = Array.from({ length: 120 }, (_, i) => envelope(`e${i}`));

    const body = (await (
      await json('/sync/push', { events }, { cookie })
    ).json()) as PushResponse;

    // Insert order is push order, so id e{n} must carry seq n+1.
    for (const [index, entry] of body.assigned.entries()) {
      expect(entry.id).toBe(`e${index}`);
      expect(entry.seq).toBe(index + 1);
    }
  });

  it('stays idempotent across the chunk boundary', async () => {
    const { cookie } = await signUp('e@example.com');
    const events = Array.from({ length: 130 }, (_, i) => envelope(`e${i}`));

    const first = (await (await json('/sync/push', { events }, { cookie })).json()) as PushResponse;
    const second = (await (await json('/sync/push', { events }, { cookie })).json()) as PushResponse;

    expect(second.assigned).toEqual(first.assigned);

    const page = (await (
      await request('/sync/pull?since=0&limit=1000', { cookie })
    ).json()) as PullResponse;
    expect(page.events).toHaveLength(130);
  });

  it('handles a partial overlap spanning several chunks', async () => {
    const { cookie } = await signUp('f@example.com');

    await json(
      '/sync/push',
      { events: Array.from({ length: 120 }, (_, i) => envelope(`e${i}`)) },
      { cookie },
    );

    // 60 already stored, 60 new — the overlap straddles the 50-id chunks.
    const mixed = Array.from({ length: 120 }, (_, i) => envelope(`e${i + 60}`));
    const body = (await (
      await json('/sync/push', { events: mixed }, { cookie })
    ).json()) as PushResponse;

    expect(body.assigned).toHaveLength(120);
    // The first 60 keep their original seqs; the rest continue the sequence.
    expect(body.assigned[0]).toEqual({ id: 'e60', seq: 61 });
    expect(body.assigned[59]).toEqual({ id: 'e119', seq: 120 });
    expect(body.assigned[60]).toEqual({ id: 'e120', seq: 121 });
    expect(body.highWater).toBe(180);
  });

  it('counts a large push against the quota exactly once', async () => {
    const { cookie } = await signUp('g@example.com');
    const events = Array.from({ length: 150 }, (_, i) => envelope(`e${i}`));

    await json('/sync/push', { events }, { cookie });
    const before = (await (await request('/sync/status', { cookie })).json()) as {
      events: number;
      bytes: number;
    };

    await json('/sync/push', { events }, { cookie });
    const after = (await (await request('/sync/status', { cookie })).json()) as {
      events: number;
      bytes: number;
    };

    expect(before.events).toBe(150);
    expect(after).toEqual(before);
  });
});
