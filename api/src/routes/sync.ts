import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import {
  DEFAULT_PULL_LIMIT,
  envelopeBytes,
  MAX_PULL_LIMIT,
  PUSH_REQUEST,
  type PullResponse,
  type PushResponse,
  type StoredEnvelope,
} from '@autofill/core';
import type { AppBindings } from '../env';
import { findAccountById, fromBase64, toBase64, wouldExceedQuota } from '../accounts';
import { requireSession, requireWebAccess } from '../middleware';

/**
 * The sync protocol (WEB.md §4.2) — "two endpoints and a watermark. That is the
 * whole protocol."
 *
 * ```
 * POST /sync/push  { events: EventEnvelope[] } → { assigned: {id, seq}[], highWater }
 * GET  /sync/pull  ?since=<seq>&limit=500     → { events, highWater, more }
 * ```
 *
 * The server never decrypts anything here. It assigns `seq`, enforces the
 * quota, and hands bytes back.
 */
export const syncRoutes = new Hono<AppBindings>();

syncRoutes.use('*', requireSession, requireWebAccess);

/**
 * Push.
 *
 * "Push is idempotent on `id` — re-pushing an event the server already holds
 * returns its existing `seq`. A client that crashes mid-push simply pushes
 * again."
 *
 * `seq` comes from a per-user counter bumped in the same batch as the insert.
 * §8: "D1 serializes writes per database, so this is safe without additional
 * locking."
 */
syncRoutes.post('/push', async (context) => {
  const body = PUSH_REQUEST.parse(await context.req.json());
  const userId = context.get('userId')!;
  const db = context.env.DB;

  const account = await findAccountById(context.env, userId);
  if (!account) throw new HTTPException(401, { message: 'Account not found.' });

  // Reject duplicate ids inside one request before touching the database —
  // otherwise two rows in the same batch race for the same primary key.
  const seen = new Set<string>();
  for (const event of body.events) {
    if (seen.has(event.id)) {
      throw new HTTPException(400, { message: `Duplicate event id in request: ${event.id}` });
    }
    seen.add(event.id);
  }

  // Idempotency: anything already stored keeps the seq it was given.
  const existing = await findExistingSeqs(
    db,
    userId,
    body.events.map((event) => event.id),
  );
  const fresh = body.events.filter((event) => !existing.has(event.id));

  const addedBytes = fresh.reduce((total, event) => total + envelopeBytes(event), 0);
  if (wouldExceedQuota(account, fresh.length, addedBytes)) {
    // §8 — the quota exists "only to bound a runaway client", so say which
    // dimension blew rather than returning a bare 413.
    throw new HTTPException(413, {
      message:
        `Account storage limit reached (${account.event_count} events, ` +
        `${account.byte_count} bytes). Delete some applications or contact support.`,
    });
  }

  // Nothing new: a pure re-push. Answer from what is already stored without
  // touching the counter — D1 also rejects an empty batch outright.
  if (fresh.length === 0) {
    return context.json({
      assigned: body.events.map((event) => ({ id: event.id, seq: existing.get(event.id)! })),
      highWater: await currentHighWater(context.env, userId),
    } satisfies PushResponse);
  }

  // Reserve the sequence range ATOMICALLY.
  //
  // Reading the counter and later writing an absolute value back is a race: two
  // concurrent pushes both read N, both write N+k, and both insert rows over the
  // same seqs. `PRIMARY KEY (user_id, id)` does not catch it because the ids
  // differ — so the duplicates are silent, and a cursor walk (`seq > since`)
  // then skips whichever row it did not happen to read. That is unrecoverable
  // data loss the client cannot even detect.
  //
  // A single `UPDATE ... RETURNING` is one statement, so the read-modify-write
  // cannot interleave.
  const reserved = await db
    .prepare(
      'UPDATE sequences SET high_water = high_water + ? WHERE user_id = ? RETURNING high_water',
    )
    .bind(fresh.length, userId)
    .first<{ high_water: number }>();

  if (!reserved) throw new HTTPException(500, { message: 'Sequence counter is missing.' });

  const endSeq = reserved.high_water;
  const startSeq = endSeq - fresh.length;
  const createdAt = new Date().toISOString();

  // `INSERT OR IGNORE`, not a plain INSERT.
  //
  // The existence check above is an optimisation, not a guard: it and the insert
  // are two statements, so two concurrent pushes of the SAME ids both see
  // nothing and both try to insert. A plain INSERT then violates
  // `PRIMARY KEY (user_id, id)` and the whole batch 500s — turning "push is
  // idempotent, just push again" (§4.2) into a hard failure precisely when a
  // retrying client needs it most. OR IGNORE makes the loser a no-op.
  const results = await db.batch(
    fresh.map((event, index) =>
      db
        .prepare(
          `INSERT OR IGNORE INTO events (user_id, id, seq, device_id, iv, ciphertext, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          userId,
          event.id,
          startSeq + index + 1,
          event.deviceId,
          fromBase64(event.iv),
          fromBase64(event.ciphertext),
          createdAt,
        ),
    ),
  );

  // Count what was actually written. Rows the race lost were ignored, and
  // charging the account for them would let a retry loop eat its own quota.
  const inserted = results.reduce((total, result) => total + (result.meta.changes ?? 0), 0);
  const insertedBytes = inserted === fresh.length
    ? addedBytes
    : Math.round((addedBytes / Math.max(fresh.length, 1)) * inserted);

  if (inserted > 0) {
    await db
      .prepare(
        `UPDATE accounts SET event_count = event_count + ?, byte_count = byte_count + ?,
                updated_at = ? WHERE user_id = ?`,
      )
      .bind(inserted, insertedBytes, createdAt, userId)
      .run();
  }

  // Read the seqs back rather than trusting the ones we reserved: a row the race
  // lost kept the winner's seq, not ours. This is the authoritative answer, and
  // it is what makes two concurrent identical pushes return identical bodies.
  const stored = await findExistingSeqs(
    db,
    userId,
    body.events.map((event) => event.id),
  );

  const response: PushResponse = {
    assigned: body.events.map((event) => ({
      id: event.id,
      seq: stored.get(event.id) ?? existing.get(event.id) ?? 0,
    })),
    highWater: endSeq,
  };
  return context.json(response);
});

/**
 * Pull — a cursor walk.
 *
 * "Each client persists its own `highWater`; there is no server-side per-device
 * state to corrupt." A client that has been offline for months just walks the
 * cursor; there is no expiry and no forced full re-sync.
 */
syncRoutes.get('/pull', async (context) => {
  const userId = context.get('userId')!;

  const since = Number.parseInt(context.req.query('since') ?? '0', 10);
  if (!Number.isFinite(since) || since < 0) {
    throw new HTTPException(400, { message: '`since` must be a non-negative integer.' });
  }

  const requested = Number.parseInt(context.req.query('limit') ?? String(DEFAULT_PULL_LIMIT), 10);
  const limit = Math.min(
    Number.isFinite(requested) && requested > 0 ? requested : DEFAULT_PULL_LIMIT,
    MAX_PULL_LIMIT,
  );

  // One extra row is the cheapest possible `more` — no second COUNT query.
  const rows = await context.env.DB.prepare(
    `SELECT id, seq, device_id, iv, ciphertext, created_at
       FROM events
      WHERE user_id = ? AND seq > ?
      ORDER BY seq ASC
      LIMIT ?`,
  )
    .bind(userId, since, limit + 1)
    .all<{
      id: string;
      seq: number;
      device_id: string;
      iv: ArrayBuffer;
      ciphertext: ArrayBuffer;
      created_at: string;
    }>();

  const more = rows.results.length > limit;
  const page = more ? rows.results.slice(0, limit) : rows.results;

  const events: StoredEnvelope[] = page.map((row) => ({
    id: row.id,
    userId,
    seq: row.seq,
    deviceId: row.device_id,
    iv: toBase64(row.iv),
    ciphertext: toBase64(row.ciphertext),
    createdAt: row.created_at,
  }));

  const response: PullResponse = {
    events,
    // The cursor advances to the last row actually returned, never past it —
    // otherwise `more` would strand the rows in between.
    highWater: page.at(-1)?.seq ?? since,
    more,
  };
  return context.json(response);
});

/** Sync status for `/settings` (§6.1) — counts only, nothing decryptable. */
syncRoutes.get('/status', async (context) => {
  const account = await findAccountById(context.env, context.get('userId')!);
  if (!account) throw new HTTPException(401, { message: 'Account not found.' });

  return context.json({
    events: account.event_count,
    bytes: account.byte_count,
    highWater: await currentHighWater(context.env, account.user_id),
    webAccess: account.web_access === 1,
  });
});

/**
 * SQLite binds one variable per `?`, and D1 caps a statement at roughly 100 of
 * them. A naive `id IN (?,?,…)` over a whole push therefore fails with
 * "too many SQL variables" the moment a client sends more than ~99 events —
 * which a first sync or a week offline does routinely (§6.2 projects ~2,700
 * events on a first load).
 *
 * So the lookup is chunked. The chunk size leaves headroom for the `user_id`
 * bind and for D1 raising or lowering the cap.
 */
const ID_LOOKUP_CHUNK = 50;

async function findExistingSeqs(
  db: D1Database,
  userId: string,
  ids: string[],
): Promise<Map<string, number>> {
  const found = new Map<string, number>();

  for (let offset = 0; offset < ids.length; offset += ID_LOOKUP_CHUNK) {
    const chunk = ids.slice(offset, offset + ID_LOOKUP_CHUNK);
    const placeholders = chunk.map(() => '?').join(',');
    const rows = await db
      .prepare(`SELECT id, seq FROM events WHERE user_id = ? AND id IN (${placeholders})`)
      .bind(userId, ...chunk)
      .all<{ id: string; seq: number }>();

    for (const row of rows.results) found.set(row.id, row.seq);
  }

  return found;
}

async function currentHighWater(
  env: AppBindings['Bindings'],
  userId: string,
): Promise<number> {
  const row = await env.DB.prepare('SELECT high_water FROM sequences WHERE user_id = ?')
    .bind(userId)
    .first<{ high_water: number }>();
  return row?.high_water ?? 0;
}
