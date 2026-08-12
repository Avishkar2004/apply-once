import { setCookie, deleteCookie } from 'hono/cookie';
import type { Context, Env as HonoEnv } from 'hono';
import type { Env } from '../env';

/**
 * Sessions (WEB.md §7).
 *
 * "Session cookie: `HttpOnly`, `Secure`, `SameSite=Strict`, 30-day sliding
 * expiry, revocable per device from `/settings`."
 *
 * Stored in Workers KV rather than D1: §8 wants "short TTL, cheap reads", and a
 * session lookup happens on every single request while a D1 read costs more.
 * KV's TTL also does the expiry for us — an abandoned session evaporates rather
 * than accumulating.
 */

export const SESSION_COOKIE = 'af_session';

/** §7 — 30-day sliding expiry. */
export const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;

/** Re-issue rather than churn KV on every request. */
const SLIDING_REFRESH_AFTER_SECONDS = 24 * 60 * 60;

export interface SessionRecord {
  userId: string;
  /** Which device this session belongs to, so `/settings` can revoke one. */
  deviceId?: string;
  createdAt: string;
  lastSeenAt: string;
}

const sessionKey = (sessionId: string) => `session:${sessionId}`;
const userIndexKey = (userId: string, sessionId: string) => `user:${userId}:${sessionId}`;

function newSessionId(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function createSession(
  env: Env,
  userId: string,
  deviceId?: string,
): Promise<{ sessionId: string; record: SessionRecord }> {
  const sessionId = newSessionId();
  const now = new Date().toISOString();
  const record: SessionRecord = {
    userId,
    ...(deviceId ? { deviceId } : {}),
    createdAt: now,
    lastSeenAt: now,
  };

  await env.SESSIONS.put(sessionKey(sessionId), JSON.stringify(record), {
    expirationTtl: SESSION_TTL_SECONDS,
  });
  // Index so "revoke every session for this user" is a list, not a scan.
  await env.SESSIONS.put(userIndexKey(userId, sessionId), '1', {
    expirationTtl: SESSION_TTL_SECONDS,
  });

  return { sessionId, record };
}

export async function readSession(env: Env, sessionId: string): Promise<SessionRecord | undefined> {
  const raw = await env.SESSIONS.get(sessionKey(sessionId));
  return raw ? (JSON.parse(raw) as SessionRecord) : undefined;
}

/** Slide the expiry, but only once a day — not on every request. */
export async function touchSession(
  env: Env,
  sessionId: string,
  record: SessionRecord,
): Promise<void> {
  const age = Date.now() - Date.parse(record.lastSeenAt);
  if (age < SLIDING_REFRESH_AFTER_SECONDS * 1000) return;

  const refreshed: SessionRecord = { ...record, lastSeenAt: new Date().toISOString() };
  await env.SESSIONS.put(sessionKey(sessionId), JSON.stringify(refreshed), {
    expirationTtl: SESSION_TTL_SECONDS,
  });
  await env.SESSIONS.put(userIndexKey(record.userId, sessionId), '1', {
    expirationTtl: SESSION_TTL_SECONDS,
  });
}

export async function revokeSession(env: Env, sessionId: string): Promise<void> {
  const record = await readSession(env, sessionId);
  await env.SESSIONS.delete(sessionKey(sessionId));
  if (record) await env.SESSIONS.delete(userIndexKey(record.userId, sessionId));
}

/** Every device signed out — used by passphrase rotation and account deletion. */
export async function revokeAllSessions(env: Env, userId: string): Promise<number> {
  const { keys } = await env.SESSIONS.list({ prefix: `user:${userId}:` });
  await Promise.all(
    keys.map(async ({ name }) => {
      const sessionId = name.slice(`user:${userId}:`.length);
      await env.SESSIONS.delete(sessionKey(sessionId));
      await env.SESSIONS.delete(name);
    }),
  );
  return keys.length;
}

// Generic over the Hono env so any route's context can pass, rather than
// forcing every caller to match one exact binding shape.
export function issueSessionCookie<E extends HonoEnv>(
  context: Context<E>,
  sessionId: string,
): void {
  setCookie(context, SESSION_COOKIE, sessionId, {
    httpOnly: true,
    secure: true,
    sameSite: 'Strict',
    path: '/',
    maxAge: SESSION_TTL_SECONDS,
  });
}

export function clearSessionCookie<E extends HonoEnv>(context: Context<E>): void {
  deleteCookie(context, SESSION_COOKIE, { path: '/', secure: true, sameSite: 'Strict' });
}
