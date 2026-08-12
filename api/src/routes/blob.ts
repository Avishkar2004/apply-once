import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { MAX_BYTES_PER_ACCOUNT } from '@autofill/core';
import type { AppBindings } from '../env';
import { findAccountById } from '../accounts';
import { requireSession, requireWebAccess } from '../middleware';

/**
 * Blobs (WEB.md §2, §4.2).
 *
 * ```
 * PUT /blob/:hash  <encrypted bytes> → 201 | 204 (already present)
 * GET /blob/:hash                    → encrypted bytes
 * ```
 *
 * "Blobs — content-addressed, immutable | job postings, answer sets, resume
 * files | Keyed by SHA-256 of plaintext. Written once. Same content → same key
 * → idempotent."
 *
 * The hash is of the **plaintext**, computed on the client, so the server can
 * never verify it — it only sees ciphertext. That is fine and deliberate: the
 * hash is a deduplication key chosen by a client that already holds the data,
 * not an integrity claim the server makes. What the server does enforce is that
 * a key is well-formed, scoped to the account, and written at most once.
 */
export const blobRoutes = new Hono<AppBindings>();

blobRoutes.use('*', requireSession, requireWebAccess);

/** A single blob is bounded well below the account quota. §5: ~200 KB each. */
const MAX_BLOB_BYTES = 2 * 1024 * 1024;

const HASH_PATTERN = /^[0-9a-f]{64}$/;

/**
 * Keys are prefixed by user id (§8: "content-addressed by SHA-256 of plaintext,
 * prefixed by userId"), so one account can never read another's object even if
 * it somehow learned the hash.
 */
const objectKey = (userId: string, hash: string) => `${userId}/${hash}`;

function assertHash(hash: string): void {
  if (!HASH_PATTERN.test(hash)) {
    throw new HTTPException(400, { message: 'Blob key must be a lowercase SHA-256 hex digest.' });
  }
}

blobRoutes.put('/:hash', async (context) => {
  const hash = context.req.param('hash');
  assertHash(hash);

  const userId = context.get('userId')!;
  const account = await findAccountById(context.env, userId);
  if (!account) throw new HTTPException(401, { message: 'Account not found.' });

  // Already stored → 204, no re-upload. This is what makes "same content → same
  // key → idempotent" cheap for a client re-syncing after a crash.
  const existing = await context.env.DB.prepare(
    'SELECT hash FROM blobs WHERE user_id = ? AND hash = ?',
  )
    .bind(userId, hash)
    .first<{ hash: string }>();
  if (existing) return context.body(null, 204);

  const body = await context.req.arrayBuffer();
  if (body.byteLength === 0) throw new HTTPException(400, { message: 'Empty blob.' });
  if (body.byteLength > MAX_BLOB_BYTES) {
    throw new HTTPException(413, { message: 'Blob exceeds the per-object limit.' });
  }
  if (account.byte_count + body.byteLength > MAX_BYTES_PER_ACCOUNT) {
    throw new HTTPException(413, { message: 'Account storage limit reached.' });
  }

  await context.env.BLOBS.put(objectKey(userId, hash), body);

  const now = new Date().toISOString();
  await context.env.DB.batch([
    context.env.DB.prepare(
      'INSERT INTO blobs (user_id, hash, byte_count, created_at) VALUES (?, ?, ?, ?)',
    ).bind(userId, hash, body.byteLength, now),
    context.env.DB.prepare(
      'UPDATE accounts SET byte_count = byte_count + ?, updated_at = ? WHERE user_id = ?',
    ).bind(body.byteLength, now, userId),
  ]);

  return context.body(null, 201);
});

blobRoutes.get('/:hash', async (context) => {
  const hash = context.req.param('hash');
  assertHash(hash);

  const userId = context.get('userId')!;
  const object = await context.env.BLOBS.get(objectKey(userId, hash));
  if (!object) throw new HTTPException(404, { message: 'No such blob.' });

  return new Response(object.body, {
    headers: {
      'Content-Type': 'application/octet-stream',
      // Content-addressed and immutable, so it can be cached hard — but
      // privately: this is one user's ciphertext, never a shared CDN object.
      'Cache-Control': 'private, max-age=31536000, immutable',
      'Content-Length': String(object.size),
    },
  });
});

/**
 * §4.5 — "a nightly local job hard-deletes their blobs once every known device
 * has passed that `seq`." The decision is the client's; this is the endpoint it
 * calls once it has made it.
 */
blobRoutes.delete('/:hash', async (context) => {
  const hash = context.req.param('hash');
  assertHash(hash);

  const userId = context.get('userId')!;
  const row = await context.env.DB.prepare(
    'SELECT byte_count FROM blobs WHERE user_id = ? AND hash = ?',
  )
    .bind(userId, hash)
    .first<{ byte_count: number }>();
  if (!row) return context.body(null, 204);

  await context.env.BLOBS.delete(objectKey(userId, hash));
  await context.env.DB.batch([
    context.env.DB.prepare('DELETE FROM blobs WHERE user_id = ? AND hash = ?').bind(userId, hash),
    context.env.DB.prepare(
      'UPDATE accounts SET byte_count = MAX(0, byte_count - ?), updated_at = ? WHERE user_id = ?',
    ).bind(row.byte_count, new Date().toISOString(), userId),
  ]);

  return context.body(null, 204);
});
