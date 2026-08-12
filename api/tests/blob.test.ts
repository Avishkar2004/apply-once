import { beforeEach, describe, expect, it } from 'vitest';
import { request, resetDatabase, signUp } from './helpers';

/** Blobs (WEB.md §2, §4.2) — content-addressed, immutable, per-account. */

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

const bytes = (size = 32, fill = 1) => new Uint8Array(size).fill(fill);

function put(hash: string, body: Uint8Array, cookie: string) {
  return request(`/blob/${hash}`, {
    method: 'PUT',
    body: body as BodyInit,
    cookie,
    headers: { 'Content-Type': 'application/octet-stream' },
  });
}

beforeEach(resetDatabase);

describe('put', () => {
  it('stores a blob and reports 201', async () => {
    const { cookie } = await signUp();
    expect((await put(HASH_A, bytes(), cookie)).status).toBe(201);
  });

  it('is idempotent — same content, same key, no re-upload', async () => {
    const { cookie } = await signUp();
    expect((await put(HASH_A, bytes(), cookie)).status).toBe(201);
    // §2: "Written once. Same content → same key → idempotent."
    expect((await put(HASH_A, bytes(), cookie)).status).toBe(204);
  });

  it('rejects a key that is not a SHA-256 hex digest', async () => {
    const { cookie } = await signUp();
    expect((await put('not-a-hash', bytes(), cookie)).status).toBe(400);
    expect((await put('A'.repeat(64), bytes(), cookie)).status).toBe(400);
  });

  it('rejects an empty body', async () => {
    const { cookie } = await signUp();
    expect((await put(HASH_A, new Uint8Array(0), cookie)).status).toBe(400);
  });

  it('refuses an unauthenticated write', async () => {
    const response = await request(`/blob/${HASH_A}`, {
      method: 'PUT',
      body: bytes() as BodyInit,
    });
    expect(response.status).toBe(401);
  });
});

describe('get', () => {
  it('returns the exact bytes it was given', async () => {
    const { cookie } = await signUp();
    const payload = bytes(128, 42);
    await put(HASH_A, payload, cookie);

    const response = await request(`/blob/${HASH_A}`, { cookie });
    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(payload);
  });

  it('404s for a blob that was never written', async () => {
    const { cookie } = await signUp();
    expect((await request(`/blob/${HASH_B}`, { cookie })).status).toBe(404);
  });

  it('marks the response private — this is one user’s ciphertext', async () => {
    const { cookie } = await signUp();
    await put(HASH_A, bytes(), cookie);

    const cacheControl = (await request(`/blob/${HASH_A}`, { cookie })).headers.get('Cache-Control');
    expect(cacheControl).toContain('private');
    expect(cacheControl).not.toContain('public');
  });
});

describe('tenant isolation', () => {
  it('never serves another account’s blob, even with the right hash', async () => {
    const ada = await signUp('ada@example.com');
    const grace = await signUp('grace@example.com');

    await put(HASH_A, bytes(64, 7), ada.cookie);

    // Grace knows the hash — content addressing makes hashes guessable for
    // known content — and still cannot read it. Keys are prefixed by user id.
    expect((await request(`/blob/${HASH_A}`, { cookie: grace.cookie })).status).toBe(404);
  });

  it('lets two accounts store the same content independently', async () => {
    const ada = await signUp('ada@example.com');
    const grace = await signUp('grace@example.com');

    expect((await put(HASH_A, bytes(), ada.cookie)).status).toBe(201);
    // Not a 204 — Grace has not written this, even though Ada has.
    expect((await put(HASH_A, bytes(), grace.cookie)).status).toBe(201);
  });
});

describe('delete (§4.5)', () => {
  it('removes the blob and is safe to repeat', async () => {
    const { cookie } = await signUp();
    await put(HASH_A, bytes(), cookie);

    expect((await request(`/blob/${HASH_A}`, { method: 'DELETE', cookie })).status).toBe(204);
    expect((await request(`/blob/${HASH_A}`, { cookie })).status).toBe(404);
    // Deleting something already gone is not an error — a retrying GC job
    // should not have to care whether it already succeeded.
    expect((await request(`/blob/${HASH_A}`, { method: 'DELETE', cookie })).status).toBe(204);
  });

  it('gives the storage back', async () => {
    const { cookie } = await signUp();
    await put(HASH_A, bytes(1024), cookie);

    const before = (await (await request('/sync/status', { cookie })).json()) as { bytes: number };
    expect(before.bytes).toBe(1024);

    await request(`/blob/${HASH_A}`, { method: 'DELETE', cookie });

    const after = (await (await request('/sync/status', { cookie })).json()) as { bytes: number };
    expect(after.bytes).toBe(0);
  });
});
