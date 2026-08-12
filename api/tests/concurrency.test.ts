import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import type { PullResponse, PushResponse } from '@autofill/core';
import { envelope, json, request, resetDatabase, signUp } from './helpers';

/**
 * Concurrent pushes and the sequence counter.
 *
 * Reading `high_water` and later writing an absolute value back is a race: two
 * pushes both read N and both insert over the same seqs. `PRIMARY KEY
 * (user_id, id)` does not catch it — the ids differ — so the duplicates are
 * silent, and a cursor walk (`seq > since`) then skips whichever row the page
 * boundary did not reach.
 *
 * The fix is an atomic `UPDATE ... RETURNING` range reservation plus a UNIQUE
 * index on `(user_id, seq)`. These tests pin both.
 */

beforeEach(resetDatabase);

describe('concurrent pushes', () => {
  it('never assigns the same seq twice', async () => {
    const { cookie } = await signUp();

    const batches = Array.from({ length: 8 }, (_, batch) =>
      Array.from({ length: 10 }, (_, i) => envelope(`b${batch}-e${i}`)),
    );

    const responses = await Promise.all(
      batches.map((events) => json('/sync/push', { events }, { cookie })),
    );

    for (const response of responses) expect(response.status).toBe(200);

    const bodies = (await Promise.all(
      responses.map((response) => response.json()),
    )) as PushResponse[];

    const seqs = bodies.flatMap((body) => body.assigned.map((entry) => entry.seq));
    expect(seqs).toHaveLength(80);
    // The property that matters: every seq is distinct.
    expect(new Set(seqs).size).toBe(80);
  });

  it('leaves every event reachable by a cursor walk', async () => {
    const { cookie } = await signUp('b@example.com');

    await Promise.all(
      Array.from({ length: 6 }, (_, batch) =>
        json(
          '/sync/push',
          { events: Array.from({ length: 10 }, (_, i) => envelope(`b${batch}-e${i}`)) },
          { cookie },
        ),
      ),
    );

    // Walk the cursor the way a real client does, in small pages.
    const seen: string[] = [];
    let cursor = 0;
    for (let page = 0; page < 50; page += 1) {
      const body = (await (
        await request(`/sync/pull?since=${cursor}&limit=7`, { cookie })
      ).json()) as PullResponse;

      seen.push(...body.events.map((event) => event.id));
      cursor = body.highWater;
      if (!body.more) break;
    }

    // A duplicated seq would strand rows here even though they are in the table.
    expect(new Set(seen).size).toBe(60);
  });

  it('keeps the counter consistent with the rows', async () => {
    const { cookie, userId } = await signUp('c@example.com');

    await Promise.all(
      Array.from({ length: 5 }, (_, batch) =>
        json(
          '/sync/push',
          { events: Array.from({ length: 8 }, (_, i) => envelope(`b${batch}-e${i}`)) },
          { cookie },
        ),
      ),
    );

    const counter = await env.DB.prepare('SELECT high_water FROM sequences WHERE user_id = ?')
      .bind(userId)
      .first<{ high_water: number }>();
    const rows = await env.DB.prepare(
      'SELECT COUNT(*) AS n, MAX(seq) AS max_seq FROM events WHERE user_id = ?',
    )
      .bind(userId)
      .first<{ n: number; max_seq: number }>();

    expect(rows?.n).toBe(40);
    // The counter is a high-water mark, never behind the rows it handed out.
    expect(counter?.high_water).toBeGreaterThanOrEqual(rows?.max_seq ?? 0);
  });

  it('stays idempotent when the same batch is pushed concurrently', async () => {
    const { cookie } = await signUp('d@example.com');
    const events = Array.from({ length: 12 }, (_, i) => envelope(`e${i}`));

    const responses = await Promise.all([
      json('/sync/push', { events }, { cookie }),
      json('/sync/push', { events }, { cookie }),
      json('/sync/push', { events }, { cookie }),
    ]);

    for (const response of responses) expect(response.status).toBe(200);

    const page = (await (
      await request('/sync/pull?since=0&limit=1000', { cookie })
    ).json()) as PullResponse;

    // Three racing pushes of the same ids must still store each event once.
    expect(page.events).toHaveLength(12);
    expect(new Set(page.events.map((e) => e.seq)).size).toBe(12);
  });
});

describe('the UNIQUE backstop', () => {
  it('refuses a duplicate seq at the database level', async () => {
    const { cookie, userId } = await signUp('e@example.com');
    await json('/sync/push', { events: [envelope('a')] }, { cookie });

    // Simulate the regression the constraint exists to catch.
    await expect(
      env.DB.prepare(
        `INSERT INTO events (user_id, id, seq, device_id, iv, ciphertext, created_at)
         VALUES (?, 'forged', 1, 'd', X'00', X'00', '2026-08-12T00:00:00Z')`,
      )
        .bind(userId)
        .run(),
    ).rejects.toBeTruthy();
  });
});
