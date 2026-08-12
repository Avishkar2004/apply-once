import { beforeEach, describe, expect, it } from 'vitest';
import { toBase64 } from '@autofill/core';
import { MAX_ATTEMPTS } from '../src/auth/rate-limit';
import { cookieFrom, envelope, json, login, request, resetDatabase, signUp } from './helpers';

/** Auth (WEB.md §7) and the threat model around it (§10, §12). */

beforeEach(resetDatabase);

describe('signup', () => {
  it('creates an account and signs the caller in', async () => {
    const response = await json('/auth/signup', {
      email: 'ada@example.com',
      authKey: toBase64(new Uint8Array(32).fill(7)),
      salt: toBase64(new Uint8Array(16).fill(1)),
      wrappedDek: toBase64(new Uint8Array(40).fill(2)),
      wrappedDekRecovery: toBase64(new Uint8Array(40).fill(3)),
    });

    expect(response.status).toBe(201);
    expect(response.headers.get('Set-Cookie')).toMatch(/HttpOnly/);
    expect(response.headers.get('Set-Cookie')).toMatch(/Secure/);
    expect(response.headers.get('Set-Cookie')).toMatch(/SameSite=Strict/);
  });

  it('refuses a second account on the same email', async () => {
    await signUp('ada@example.com');
    const response = await json('/auth/signup', {
      email: 'ada@example.com',
      authKey: toBase64(new Uint8Array(32).fill(7)),
      salt: toBase64(new Uint8Array(16).fill(1)),
      wrappedDek: toBase64(new Uint8Array(40).fill(2)),
      wrappedDekRecovery: toBase64(new Uint8Array(40).fill(3)),
    });
    expect(response.status).toBe(409);
  });

  it('treats email case-insensitively — one person, one account', async () => {
    await signUp('Ada@Example.com');
    const response = await login('ada@example.com');
    expect(response.status).toBe(200);
  });

  it('rejects a malformed request without echoing the value back', async () => {
    const response = await json('/auth/signup', { email: 'not-an-email', authKey: 'AAAA' });
    expect(response.status).toBe(400);
    expect(await response.text()).not.toContain('not-an-email');
  });
});

describe('login', () => {
  it('returns the salt and wrapped DEK — never the DEK itself', async () => {
    await signUp('ada@example.com');
    const response = await login('ada@example.com');

    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;

    expect(Object.keys(body).sort()).toEqual(['salt', 'wrappedDek']);
    // The recovery wrap is not part of a normal login; only the recovery flow
    // needs it, and shipping it every time widens the blast radius for nothing.
    expect(body).not.toHaveProperty('wrappedDekRecovery');
  });

  it('rejects the wrong auth key', async () => {
    await signUp('ada@example.com');
    expect((await login('ada@example.com', 8)).status).toBe(401);
  });

  it('gives an unknown account the same answer as a wrong key', async () => {
    await signUp('ada@example.com');

    const unknown = await login('nobody@example.com');
    const wrongKey = await login('ada@example.com', 8);

    expect(unknown.status).toBe(wrongKey.status);
    expect(await unknown.text()).toBe(await wrongKey.text());
  });
});

describe('the account-existence oracle (§7, §12)', () => {
  it('returns a salt for an unknown email, indistinguishable from a real one', async () => {
    await signUp('ada@example.com');

    const real = (await (await request('/auth/salt?email=ada@example.com')).json()) as {
      salt: string;
    };
    const fake = (await (await request('/auth/salt?email=nobody@example.com')).json()) as {
      salt: string;
    };

    expect(fake.salt).toBeTruthy();
    expect(fake.salt).not.toBe(real.salt);
    // Same shape, so length alone does not answer the question either.
    expect(fake.salt.length).toBe(real.salt.length);
  });

  it('returns the *same* fake salt every time — a varying one is itself the signal', async () => {
    const first = (await (await request('/auth/salt?email=nobody@example.com')).json()) as {
      salt: string;
    };
    const second = (await (await request('/auth/salt?email=nobody@example.com')).json()) as {
      salt: string;
    };
    expect(second.salt).toBe(first.salt);
  });

  it('derives a different fake salt per email', async () => {
    const a = (await (await request('/auth/salt?email=a@example.com')).json()) as { salt: string };
    const b = (await (await request('/auth/salt?email=b@example.com')).json()) as { salt: string };
    expect(a.salt).not.toBe(b.salt);
  });
});

describe('rate limiting (§7)', () => {
  it('locks out after the documented number of attempts', async () => {
    await signUp('ada@example.com');

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      expect((await login('ada@example.com', 8)).status).toBe(401);
    }

    const blocked = await login('ada@example.com', 8);
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get('Retry-After')).toBeTruthy();
  });

  it('does not punish a user for one typo before a correct attempt', async () => {
    await signUp('ada@example.com');
    await login('ada@example.com', 8);

    expect((await login('ada@example.com')).status).toBe(200);
    // The counter was cleared, so the next wrong attempt starts from scratch.
    expect((await login('ada@example.com', 8)).status).toBe(401);
  });
});

describe('passphrase rotation (§3.1)', () => {
  it('re-wraps the DEK and leaves the recovery wrap alone', async () => {
    const { cookie } = await signUp('ada@example.com');

    const response = await json(
      '/auth/rotate',
      {
        authKeyOld: toBase64(new Uint8Array(32).fill(7)),
        authKeyNew: toBase64(new Uint8Array(32).fill(9)),
        wrappedDekNew: toBase64(new Uint8Array(40).fill(5)),
      },
      { cookie },
    );
    expect(response.status).toBe(200);

    // Old key no longer works, new one does.
    expect((await login('ada@example.com', 7)).status).toBe(401);

    const fresh = await login('ada@example.com', 9);
    expect(fresh.status).toBe(200);
    const body = (await fresh.json()) as { wrappedDek: string };
    expect(body.wrappedDek).toBe(toBase64(new Uint8Array(40).fill(5)));
  });

  it('rejects rotation with the wrong current key', async () => {
    const { cookie } = await signUp('ada@example.com');
    const response = await json(
      '/auth/rotate',
      {
        authKeyOld: toBase64(new Uint8Array(32).fill(1)),
        authKeyNew: toBase64(new Uint8Array(32).fill(9)),
        wrappedDekNew: toBase64(new Uint8Array(40).fill(5)),
      },
      { cookie },
    );
    expect(response.status).toBe(401);
  });

  it('signs out every other device', async () => {
    const first = await signUp('ada@example.com');
    const secondLogin = await login('ada@example.com');
    const secondCookie = cookieFrom(secondLogin);

    await json(
      '/auth/rotate',
      {
        authKeyOld: toBase64(new Uint8Array(32).fill(7)),
        authKeyNew: toBase64(new Uint8Array(32).fill(9)),
        wrappedDekNew: toBase64(new Uint8Array(40).fill(5)),
      },
      { cookie: first.cookie },
    );

    expect((await request('/sync/status', { cookie: secondCookie })).status).toBe(401);
  });
});

describe('sessions', () => {
  it('rejects a forged cookie', async () => {
    await signUp('ada@example.com');
    const response = await request('/sync/status', { cookie: 'af_session=deadbeef' });
    expect(response.status).toBe(401);
  });

  it('invalidates the session on logout', async () => {
    const { cookie } = await signUp('ada@example.com');
    expect((await request('/sync/status', { cookie })).status).toBe(200);

    await json('/auth/logout', {}, { cookie });
    expect((await request('/sync/status', { cookie })).status).toBe(401);
  });

  it('signs every device out on logout-all', async () => {
    const first = await signUp('ada@example.com');
    const secondCookie = cookieFrom(await login('ada@example.com'));

    await json('/auth/logout-all', {}, { cookie: first.cookie });

    expect((await request('/sync/status', { cookie: first.cookie })).status).toBe(401);
    expect((await request('/sync/status', { cookie: secondCookie })).status).toBe(401);
  });

  it('does not let a signed-out session push', async () => {
    const { cookie } = await signUp('ada@example.com');
    await json('/auth/logout', {}, { cookie });

    expect((await json('/sync/push', { events: [envelope('a')] }, { cookie })).status).toBe(401);
  });
});
