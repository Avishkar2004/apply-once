import { env } from 'cloudflare:test';
import { toBase64 } from '@autofill/core';
import app from '../src/index';
// Inlined at build time — `workerd` has no filesystem to read it from.
import SCHEMA from '../schema.sql?raw';

/**
 * Shared setup for the Worker integration tests.
 *
 * Every test gets a clean database. The alternative — ordering tests so their
 * leftovers do not collide — is how a suite starts passing for the wrong reason.
 */

export async function resetDatabase(): Promise<void> {
  await env.DB.exec('DROP TABLE IF EXISTS events');
  await env.DB.exec('DROP TABLE IF EXISTS accounts');
  await env.DB.exec('DROP TABLE IF EXISTS sequences');
  await env.DB.exec('DROP TABLE IF EXISTS blobs');

  // Two D1 quirks to work around here:
  //  - `exec()` treats every *line* as a complete statement, so a multi-line
  //    CREATE TABLE fails with "incomplete input". `prepare().run()` does not.
  //  - Comments must be stripped *before* splitting on ';', or a leading
  //    comment stays glued to the statement after it.
  const statements = SCHEMA.split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n')
    .split(';')
    .map((statement) => statement.trim())
    .filter(Boolean);

  for (const statement of statements) await env.DB.prepare(statement).run();

  const kv = await env.SESSIONS.list();
  await Promise.all(kv.keys.map(({ name }) => env.SESSIONS.delete(name)));

  const objects = await env.BLOBS.list();
  await Promise.all(objects.objects.map(({ key }) => env.BLOBS.delete(key)));
}

const BASE = 'https://sync.autofill.test';

export interface Session {
  cookie: string;
  userId: string;
}

export function request(path: string, init: RequestInit & { cookie?: string } = {}) {
  const headers = new Headers(init.headers);
  if (init.cookie) headers.set('Cookie', init.cookie);
  if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');

  return app.fetch(new Request(`${BASE}${path}`, { ...init, headers }), env);
}

export function json(path: string, body: unknown, init: RequestInit & { cookie?: string } = {}) {
  return request(path, { ...init, method: init.method ?? 'POST', body: JSON.stringify(body) });
}

function cookieFrom(response: Response): string {
  const header = response.headers.get('Set-Cookie') ?? '';
  return header.split(';')[0] ?? '';
}

/** A fresh account plus a signed-in session. */
export async function signUp(email = 'ada@example.com'): Promise<Session> {
  const response = await json('/auth/signup', {
    email,
    authKey: toBase64(new Uint8Array(32).fill(7)),
    salt: toBase64(new Uint8Array(16).fill(1)),
    wrappedDek: toBase64(new Uint8Array(40).fill(2)),
    wrappedDekRecovery: toBase64(new Uint8Array(40).fill(3)),
  });

  if (response.status !== 201) throw new Error(`signup failed: ${await response.text()}`);
  const { userId } = (await response.json()) as { userId: string };
  return { cookie: cookieFrom(response), userId };
}

export async function login(email: string, authKeyByte = 7): Promise<Response> {
  return json('/auth/login', {
    email,
    authKey: toBase64(new Uint8Array(32).fill(authKeyByte)),
  });
}

export { cookieFrom };

/** A syntactically valid envelope. Contents are opaque to the server anyway. */
export function envelope(id: string, size = 64) {
  return {
    id,
    deviceId: 'device-a',
    ciphertext: toBase64(new Uint8Array(size).fill(9)),
    iv: toBase64(new Uint8Array(12).fill(4)),
  };
}
