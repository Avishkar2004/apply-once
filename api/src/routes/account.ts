import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import type { AppBindings } from '../env';
import { findAccountById, quotaFor } from '../accounts';
import { clearSessionCookie, revokeAllSessions } from '../auth/session';
import { requireSession } from '../middleware';

/**
 * Account management — the server half of `/settings` (WEB.md §6.1).
 *
 * Deliberately **not** behind `requireWebAccess`: a user who has turned web
 * access off must still be able to see their account and turn it back on.
 */
export const accountRoutes = new Hono<AppBindings>();

accountRoutes.use('*', requireSession);

accountRoutes.get('/', async (context) => {
  const account = await findAccountById(context.env, context.get('userId')!);
  if (!account) throw new HTTPException(401, { message: 'Account not found.' });

  const quota = quotaFor(account);
  return context.json({
    userId: account.user_id,
    email: account.email,
    webAccess: account.web_access === 1,
    createdAt: account.created_at,
    quota,
  });
});

/**
 * §10 — "A 'web access off' account switch that makes the server reject all
 * `/sync` reads for that account, for people who want the extension's
 * guarantees without the website's weakness."
 *
 * This is the fourth mitigation for the JS-delivery problem, and the only one
 * that is a complete answer rather than a partial one: a server that refuses to
 * serve your data cannot be coerced into serving it to backdoored JavaScript.
 */
accountRoutes.post('/web-access', async (context) => {
  const { enabled } = z.object({ enabled: z.boolean() }).parse(await context.req.json());
  const userId = context.get('userId')!;

  await context.env.DB.prepare(
    'UPDATE accounts SET web_access = ?, updated_at = ? WHERE user_id = ?',
  )
    .bind(enabled ? 1 : 0, new Date().toISOString(), userId)
    .run();

  // Turning it off signs out every browser session immediately; leaving them
  // alive until expiry would defeat the point of the switch.
  if (!enabled) await revokeAllSessions(context.env, userId);

  return context.json({ webAccess: enabled });
});

/**
 * §4.5 — "Server-side hard deletion happens only on account deletion, which
 * drops the row and every blob in one transaction."
 *
 * R2 objects cannot join a D1 transaction, so the order is chosen so that any
 * crash leaves orphaned *bytes* rather than orphaned *references*: delete the
 * rows first, then the objects. An orphaned R2 object is unreachable — the
 * index that named it is gone — and is swept by the same pass on retry.
 */
accountRoutes.delete('/', async (context) => {
  const userId = context.get('userId')!;

  const blobs = await context.env.DB.prepare('SELECT hash FROM blobs WHERE user_id = ?')
    .bind(userId)
    .all<{ hash: string }>();

  await context.env.DB.batch([
    context.env.DB.prepare('DELETE FROM events WHERE user_id = ?').bind(userId),
    context.env.DB.prepare('DELETE FROM blobs WHERE user_id = ?').bind(userId),
    context.env.DB.prepare('DELETE FROM sequences WHERE user_id = ?').bind(userId),
    context.env.DB.prepare('DELETE FROM accounts WHERE user_id = ?').bind(userId),
  ]);

  await Promise.all(
    blobs.results.map((row) => context.env.BLOBS.delete(`${userId}/${row.hash}`)),
  );

  await revokeAllSessions(context.env, userId);
  clearSessionCookie(context);

  return context.json({ ok: true, blobsDeleted: blobs.results.length });
});
