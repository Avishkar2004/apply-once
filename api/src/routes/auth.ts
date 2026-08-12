import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { Context, Env as HonoEnv } from 'hono';
import { z } from 'zod';
import { uuidv7 } from '@autofill/core';
import type { AppBindings } from '../env';
import { fromBase64, toBase64, findAccountByEmail, findAccountById } from '../accounts';
import { hashAuthKey, verifyAgainstDecoy, verifyAuthKey } from '../auth/credentials';
import { fakeSaltFor, normaliseEmail } from '../auth/salt';
import { checkLoginRate, clearLoginRate, clientIp } from '../auth/rate-limit';
import {
  clearSessionCookie,
  createSession,
  issueSessionCookie,
  revokeAllSessions,
  revokeSession,
} from '../auth/session';
import { requireSession } from '../middleware';

/**
 * Auth (WEB.md §7).
 *
 * ```
 * POST /auth/signup   { email, authKey, salt, wrappedDek, wrappedDekRecovery }
 * POST /auth/login    { email, authKey }  → HttpOnly session cookie + { salt, wrappedDek }
 * POST /auth/rotate   { authKey_old, authKey_new, wrappedDek_new }
 * ```
 *
 * "Email is used for account identity and nothing else. No marketing, no
 * email-based recovery — email cannot recover an account, only the Recovery Kit
 * can."
 */

const base64 = z.string().min(1).max(4096).regex(/^[A-Za-z0-9+/]+={0,2}$/, 'expected base64');

/**
 * How the caller wants its session back.
 *
 * `cookie` (the default) is the browser flow of §7. `bearer` is for the
 * extension, whose service-worker requests are not same-site with this API and
 * therefore never carry a `SameSite=Strict` cookie.
 *
 * It is an explicit opt-in rather than a sniffed User-Agent so that a browser
 * page can never be tricked into receiving a token its JavaScript can read —
 * the whole point of `HttpOnly`.
 */
const TRANSPORT = z.enum(['cookie', 'bearer']).default('cookie');

const SIGNUP = z.object({
  email: z.email().max(320),
  authKey: base64,
  salt: base64,
  wrappedDek: base64,
  wrappedDekRecovery: base64,
  transport: TRANSPORT,
});

const LOGIN = z.object({
  email: z.email().max(320),
  authKey: base64,
  deviceId: z.string().min(1).max(64).optional(),
  transport: TRANSPORT,
});

const ROTATE = z.object({
  authKeyOld: base64,
  authKeyNew: base64,
  wrappedDekNew: base64,
});

export const authRoutes = new Hono<AppBindings>();

/**
 * The pre-login salt fetch — and the oracle it would otherwise be (§7, §12).
 *
 * An unknown email gets a deterministic HMAC-derived salt that is
 * indistinguishable from a real one, so probing this endpoint tells an attacker
 * nothing about who has an account.
 */
authRoutes.get('/salt', async (context) => {
  const email = context.req.query('email');
  if (!email) throw new HTTPException(400, { message: 'email is required' });

  const account = await findAccountByEmail(context.env, email);
  const salt = account
    ? toBase64(account.salt)
    : toBase64(await fakeSaltFor(context.env.SERVER_SECRET, email));

  return context.json({ salt });
});

authRoutes.post('/signup', async (context) => {
  const body = SIGNUP.parse(await context.req.json());
  const email = normaliseEmail(body.email);

  if (await findAccountByEmail(context.env, email)) {
    // Signup is the one place an existence answer is unavoidable — the caller
    // has to know it cannot claim this address.
    throw new HTTPException(409, { message: 'An account already exists for that email.' });
  }

  const userId = uuidv7();
  const stored = await hashAuthKey(body.authKey);
  const now = new Date().toISOString();

  await context.env.DB.batch([
    context.env.DB.prepare(
      `INSERT INTO accounts (
         user_id, email, salt, auth_hash, auth_salt, auth_iterations,
         wrapped_dek, wrapped_dek_recovery, event_count, byte_count,
         web_access, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 1, ?, ?)`,
    ).bind(
      userId,
      email,
      fromBase64(body.salt),
      stored.hash,
      stored.salt,
      stored.iterations,
      fromBase64(body.wrappedDek),
      fromBase64(body.wrappedDekRecovery),
      now,
      now,
    ),
    context.env.DB.prepare('INSERT INTO sequences (user_id, high_water) VALUES (?, 0)').bind(userId),
  ]);

  const { sessionId } = await createSession(context.env, userId);
  return context.json(grantSession(context, sessionId, body.transport, { userId }), 201);
});

authRoutes.post('/login', async (context) => {
  const body = LOGIN.parse(await context.req.json());
  const email = normaliseEmail(body.email);

  // Counted before verification, so a wrong key cannot be retried for free.
  const rate = await checkLoginRate(context.env, email, clientIp(context.req.raw));
  if (!rate.allowed) {
    throw new HTTPException(429, {
      message: 'Too many attempts. Try again later.',
      res: new Response('Too many attempts. Try again later.', {
        status: 429,
        headers: { 'Retry-After': String(rate.retryAfter) },
      }),
    });
  }

  const account = await findAccountByEmail(context.env, email);

  // Burn equivalent work for an unknown account so latency does not leak
  // existence — the fake salt above is pointless if login answers in 2ms.
  if (!account) {
    await verifyAgainstDecoy(body.authKey, context.env.SERVER_SECRET);
    throw new HTTPException(401, { message: 'Incorrect email or passphrase.' });
  }

  const ok = await verifyAuthKey(body.authKey, {
    hash: new Uint8Array(account.auth_hash),
    salt: new Uint8Array(account.auth_salt),
    iterations: account.auth_iterations,
  });
  if (!ok) throw new HTTPException(401, { message: 'Incorrect email or passphrase.' });

  await clearLoginRate(context.env, email);
  const { sessionId } = await createSession(context.env, account.user_id, body.deviceId);

  // The client needs both to reconstruct the DEK; neither is usable without the
  // passphrase, which never leaves the device.
  return context.json(
    grantSession(context, sessionId, body.transport, {
      salt: toBase64(account.salt),
      wrappedDek: toBase64(account.wrapped_dek),
    }),
  );
});

/**
 * Hand back a session by whichever transport the caller asked for.
 *
 * Exactly one of the two happens: a cookie is set, or the id is in the body.
 * Never both — a token in the body of a browser response would be readable by
 * page JavaScript, which is precisely what `HttpOnly` exists to prevent.
 */
function grantSession<E extends HonoEnv, T extends Record<string, unknown>>(
  context: Context<E>,
  sessionId: string,
  transport: 'cookie' | 'bearer',
  body: T,
): T | (T & { sessionId: string }) {
  if (transport === 'bearer') return { ...body, sessionId };
  issueSessionCookie(context, sessionId);
  return body;
}

/**
 * Passphrase change (§3.1).
 *
 * "Change your passphrase → derive a new MUK → re-wrap the same DEK → one row
 * updated." The recovery wrap is deliberately untouched: the Recovery Kit keeps
 * working across a passphrase change, which is the whole point of it.
 */
authRoutes.post('/rotate', requireSession, async (context) => {
  const body = ROTATE.parse(await context.req.json());
  const userId = context.get('userId')!;

  const account = await findAccountById(context.env, userId);
  if (!account) throw new HTTPException(401, { message: 'Account not found.' });

  const ok = await verifyAuthKey(body.authKeyOld, {
    hash: new Uint8Array(account.auth_hash),
    salt: new Uint8Array(account.auth_salt),
    iterations: account.auth_iterations,
  });
  if (!ok) throw new HTTPException(401, { message: 'Current passphrase is incorrect.' });

  const stored = await hashAuthKey(body.authKeyNew);
  await context.env.DB.prepare(
    `UPDATE accounts
        SET auth_hash = ?, auth_salt = ?, auth_iterations = ?, wrapped_dek = ?, updated_at = ?
      WHERE user_id = ?`,
  )
    .bind(
      stored.hash,
      stored.salt,
      stored.iterations,
      fromBase64(body.wrappedDekNew),
      new Date().toISOString(),
      userId,
    )
    .run();

  // A passphrase change signs out every other device — that is what a user
  // changing a credential expects, and what makes it useful after a theft.
  await revokeAllSessions(context.env, userId);
  const { sessionId } = await createSession(context.env, userId);
  issueSessionCookie(context, sessionId);

  return context.json({ ok: true });
});

authRoutes.post('/logout', requireSession, async (context) => {
  await revokeSession(context.env, context.get('sessionId')!);
  clearSessionCookie(context);
  return context.json({ ok: true });
});

/** §6.1 `/settings` — "Devices, sync status, passphrase change…". */
authRoutes.post('/logout-all', requireSession, async (context) => {
  const revoked = await revokeAllSessions(context.env, context.get('userId')!);
  clearSessionCookie(context);
  return context.json({ ok: true, revoked });
});
