import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { MAX_BYTES_PER_ACCOUNT, MAX_EVENTS_PER_ACCOUNT } from '@autofill/core';
import { envelope, json, request, resetDatabase, signUp } from './helpers';

/** Account controls, quotas and deletion (WEB.md §4.5, §8, §10). */

beforeEach(resetDatabase);

describe('web access switch (§10)', () => {
  it('blocks sync reads when turned off', async () => {
    const { cookie } = await signUp();
    await json('/sync/push', { events: [envelope('a')] }, { cookie });

    await json('/account/web-access', { enabled: false }, { cookie });

    // Turning it off revokes sessions, so sign in again to prove it is the
    // switch doing the blocking rather than a stale cookie.
    const fresh = await json('/auth/login', {
      email: 'ada@example.com',
      authKey: btoa(String.fromCharCode(...new Uint8Array(32).fill(7))),
    });
    const cookie2 = (fresh.headers.get('Set-Cookie') ?? '').split(';')[0] ?? '';

    expect((await request('/sync/pull?since=0', { cookie: cookie2 })).status).toBe(403);
    expect((await json('/sync/push', { events: [envelope('b')] }, { cookie: cookie2 })).status).toBe(
      403,
    );
  });

  it('still lets the owner sign in and turn it back on', async () => {
    const { cookie } = await signUp();
    await json('/account/web-access', { enabled: false }, { cookie });

    const fresh = await json('/auth/login', {
      email: 'ada@example.com',
      authKey: btoa(String.fromCharCode(...new Uint8Array(32).fill(7))),
    });
    expect(fresh.status).toBe(200);
    const cookie2 = (fresh.headers.get('Set-Cookie') ?? '').split(';')[0] ?? '';

    // /account is deliberately not behind the switch — otherwise it would be a
    // one-way door.
    expect((await request('/account', { cookie: cookie2 })).status).toBe(200);

    await json('/account/web-access', { enabled: true }, { cookie: cookie2 });
    expect((await request('/sync/pull?since=0', { cookie: cookie2 })).status).toBe(200);
  });

  it('signs out live browser sessions the moment it is turned off', async () => {
    const { cookie } = await signUp();
    await json('/account/web-access', { enabled: false }, { cookie });
    expect((await request('/account', { cookie })).status).toBe(401);
  });
});

describe('quota (§8)', () => {
  it('reports headroom against the documented limits', async () => {
    const { cookie } = await signUp();
    const account = (await (await request('/account', { cookie })).json()) as {
      quota: { events: number; bytes: number; eventsRemaining: number; bytesRemaining: number };
    };

    expect(account.quota.events).toBe(0);
    expect(account.quota.eventsRemaining).toBe(MAX_EVENTS_PER_ACCOUNT);
    expect(account.quota.bytesRemaining).toBe(MAX_BYTES_PER_ACCOUNT);
  });

  it('rejects a push that would cross the event limit', async () => {
    const { cookie, userId } = await signUp();

    // Park the counter just under the limit rather than pushing 50,000 events.
    await env.DB.prepare('UPDATE accounts SET event_count = ? WHERE user_id = ?')
      .bind(MAX_EVENTS_PER_ACCOUNT - 1, userId)
      .run();

    expect((await json('/sync/push', { events: [envelope('a')] }, { cookie })).status).toBe(200);
    expect((await json('/sync/push', { events: [envelope('b')] }, { cookie })).status).toBe(413);
  });

  it('rejects a push that would cross the byte limit', async () => {
    const { cookie, userId } = await signUp();
    await env.DB.prepare('UPDATE accounts SET byte_count = ? WHERE user_id = ?')
      .bind(MAX_BYTES_PER_ACCOUNT - 10, userId)
      .run();

    expect((await json('/sync/push', { events: [envelope('a', 4096)] }, { cookie })).status).toBe(
      413,
    );
  });

  it('does not count a re-pushed event twice', async () => {
    const { cookie } = await signUp();
    await json('/sync/push', { events: [envelope('a')] }, { cookie });

    const before = (await (await request('/sync/status', { cookie })).json()) as { bytes: number };
    await json('/sync/push', { events: [envelope('a')] }, { cookie });
    const after = (await (await request('/sync/status', { cookie })).json()) as { bytes: number };

    // Idempotent push must be idempotent for the quota too, or a retrying
    // client eats its own storage.
    expect(after.bytes).toBe(before.bytes);
  });
});

describe('account deletion (§4.5)', () => {
  it('drops events, blobs and the account together', async () => {
    const { cookie, userId } = await signUp();
    await json('/sync/push', { events: [envelope('a'), envelope('b')] }, { cookie });
    await request(`/blob/${'c'.repeat(64)}`, {
      method: 'PUT',
      body: new Uint8Array(64).fill(1) as BodyInit,
      cookie,
    });

    const response = await request('/account', { method: 'DELETE', cookie });
    expect(response.status).toBe(200);

    const events = await env.DB.prepare('SELECT COUNT(*) AS n FROM events WHERE user_id = ?')
      .bind(userId)
      .first<{ n: number }>();
    expect(events?.n).toBe(0);

    const account = await env.DB.prepare('SELECT COUNT(*) AS n FROM accounts WHERE user_id = ?')
      .bind(userId)
      .first<{ n: number }>();
    expect(account?.n).toBe(0);

    // The R2 object is gone too, not just its index row.
    expect(await env.BLOBS.get(`${userId}/${'c'.repeat(64)}`)).toBeNull();
  });

  it('invalidates the session', async () => {
    const { cookie } = await signUp();
    await request('/account', { method: 'DELETE', cookie });
    expect((await request('/account', { cookie })).status).toBe(401);
  });

  it('frees the email for re-use', async () => {
    const { cookie } = await signUp('ada@example.com');
    await request('/account', { method: 'DELETE', cookie });
    await expect(signUp('ada@example.com')).resolves.toBeTruthy();
  });
});

describe('service surface', () => {
  it('answers health checks without auth', async () => {
    expect((await request('/health')).status).toBe(200);
  });

  it('404s an unknown route as JSON', async () => {
    const response = await request('/nope');
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'Not found.' });
  });
});
