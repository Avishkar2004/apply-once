import { beforeEach, describe, expect, it } from 'vitest';
import { toBase64 } from '@autofill/core';
import { envelope, json, request, resetDatabase } from './helpers';

/**
 * Bearer-token sessions — the extension's transport.
 *
 * The browser flow in WEB.md §7 uses an `HttpOnly; Secure; SameSite=Strict`
 * cookie. An MV3 service worker calling this API is not same-site with it, so a
 * `Strict` cookie is never attached; relaxing it to `SameSite=None` for one
 * client would hand the *browser* client a CSRF surface.
 *
 * So the extension opts in to `transport: 'bearer'` and sends
 * `Authorization: Bearer <sessionId>`. These tests pin the property that makes
 * that safe: a caller gets one transport or the other, never both.
 */

const AUTH_KEY = toBase64(new Uint8Array(32).fill(7));

async function signUpBearer(email = 'ada@example.com'): Promise<string> {
  const response = await json('/auth/signup', {
    email,
    authKey: AUTH_KEY,
    salt: toBase64(new Uint8Array(16).fill(1)),
    wrappedDek: toBase64(new Uint8Array(40).fill(2)),
    wrappedDekRecovery: toBase64(new Uint8Array(40).fill(3)),
    transport: 'bearer',
  });
  const body = (await response.json()) as { sessionId: string };
  return body.sessionId;
}

const bearer = (token: string) => ({ headers: { Authorization: `Bearer ${token}` } });

beforeEach(resetDatabase);

describe('transport selection', () => {
  it('returns a session id and sets no cookie when bearer is requested', async () => {
    const response = await json('/auth/signup', {
      email: 'ada@example.com',
      authKey: AUTH_KEY,
      salt: toBase64(new Uint8Array(16).fill(1)),
      wrappedDek: toBase64(new Uint8Array(40).fill(2)),
      wrappedDekRecovery: toBase64(new Uint8Array(40).fill(3)),
      transport: 'bearer',
    });

    expect(response.status).toBe(201);
    expect(response.headers.get('Set-Cookie')).toBeNull();
    expect((await response.json()) as Record<string, unknown>).toHaveProperty('sessionId');
  });

  it('sets a cookie and leaks no token when cookie is requested', async () => {
    const response = await json('/auth/signup', {
      email: 'grace@example.com',
      authKey: AUTH_KEY,
      salt: toBase64(new Uint8Array(16).fill(1)),
      wrappedDek: toBase64(new Uint8Array(40).fill(2)),
      wrappedDekRecovery: toBase64(new Uint8Array(40).fill(3)),
    });

    expect(response.headers.get('Set-Cookie')).toMatch(/HttpOnly/);
    // A token in the body would be readable by page JavaScript — exactly what
    // HttpOnly exists to prevent.
    expect((await response.json()) as Record<string, unknown>).not.toHaveProperty('sessionId');
  });

  it('defaults to the cookie when no transport is named', async () => {
    const response = await json('/auth/signup', {
      email: 'noel@example.com',
      authKey: AUTH_KEY,
      salt: toBase64(new Uint8Array(16).fill(1)),
      wrappedDek: toBase64(new Uint8Array(40).fill(2)),
      wrappedDekRecovery: toBase64(new Uint8Array(40).fill(3)),
    });
    expect(response.headers.get('Set-Cookie')).toBeTruthy();
  });

  it('returns a token on login too', async () => {
    await signUpBearer();
    const response = await json('/auth/login', {
      email: 'ada@example.com',
      authKey: AUTH_KEY,
      transport: 'bearer',
    });

    const body = (await response.json()) as { sessionId?: string; wrappedDek?: string };
    expect(body.sessionId).toBeTruthy();
    expect(body.wrappedDek).toBeTruthy();
  });
});

describe('authenticating with a bearer token', () => {
  it('accepts a valid token on sync', async () => {
    const token = await signUpBearer();

    expect((await request('/sync/status', bearer(token))).status).toBe(200);
    expect(
      (await json('/sync/push', { events: [envelope('a')] }, bearer(token))).status,
    ).toBe(200);
  });

  it('rejects a forged token', async () => {
    await signUpBearer();
    expect((await request('/sync/status', bearer('deadbeef'))).status).toBe(401);
  });

  it('ignores a non-bearer authorization scheme', async () => {
    const token = await signUpBearer();
    const response = await request('/sync/status', {
      headers: { Authorization: `Basic ${token}` },
    });
    expect(response.status).toBe(401);
  });

  it('is revoked by logout like any other session', async () => {
    const token = await signUpBearer();
    await json('/auth/logout', {}, bearer(token));
    expect((await request('/sync/status', bearer(token))).status).toBe(401);
  });

  it('scopes to its own account', async () => {
    const ada = await signUpBearer('ada@example.com');
    const grace = await signUpBearer('grace@example.com');

    await json('/sync/push', { events: [envelope('ada-1')] }, bearer(ada));

    const gracePage = (await (
      await request('/sync/pull?since=0', bearer(grace))
    ).json()) as { events: unknown[] };
    expect(gracePage.events).toEqual([]);
  });
});

describe('transport precedence', () => {
  it('prefers the cookie, so a header cannot override a browser session', async () => {
    const adaToken = await signUpBearer('ada@example.com');

    const graceLogin = await json('/auth/signup', {
      email: 'grace@example.com',
      authKey: AUTH_KEY,
      salt: toBase64(new Uint8Array(16).fill(1)),
      wrappedDek: toBase64(new Uint8Array(40).fill(2)),
      wrappedDekRecovery: toBase64(new Uint8Array(40).fill(3)),
    });
    const graceCookie = (graceLogin.headers.get('Set-Cookie') ?? '').split(';')[0] ?? '';

    await json('/sync/push', { events: [envelope('grace-1')] }, { cookie: graceCookie });

    // Grace's cookie and Ada's bearer token on the same request: the cookie wins,
    // so an injected header cannot escalate to another account.
    const page = (await (
      await request('/sync/pull?since=0', {
        cookie: graceCookie,
        headers: { Authorization: `Bearer ${adaToken}` },
      })
    ).json()) as { events: Array<{ id: string }> };

    expect(page.events.map((event) => event.id)).toEqual(['grace-1']);
  });
});
