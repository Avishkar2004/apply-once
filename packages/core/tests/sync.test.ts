import { describe, expect, it } from 'vitest';
import {
  createVault,
  envelopeBytes,
  isUuidv7,
  openEvent,
  PADDING_BUCKET_BYTES,
  padToBucket,
  PUSH_REQUEST,
  sealEvent,
  STORED_ENVELOPE,
  unpad,
  uuidv7,
  uuidv7Timestamp,
} from '../src/index';

/** The sync wire format (WEB.md §4.1) and its padding (§10, §12). */

describe('uuidv7', () => {
  it('is well-formed and version 7', () => {
    const id = uuidv7();
    expect(isUuidv7(id)).toBe(true);
    expect(id).toHaveLength(36);
  });

  it('embeds the timestamp it was given', () => {
    const now = 1_754_000_000_000;
    expect(uuidv7Timestamp(uuidv7(now))).toBe(now);
  });

  it('sorts chronologically as a string — the property the index relies on', () => {
    const early = uuidv7(1_700_000_000_000);
    const late = uuidv7(1_800_000_000_000);
    expect([late, early].sort()).toEqual([early, late]);
  });

  it('does not collide within a millisecond', () => {
    const now = Date.now();
    const ids = new Set(Array.from({ length: 1000 }, () => uuidv7(now)));
    expect(ids.size).toBe(1000);
  });

  it('rejects a v4 uuid', () => {
    expect(isUuidv7(crypto.randomUUID())).toBe(false);
  });
});

describe('padding (§10 — blur the size metadata)', () => {
  it('rounds up to the bucket', () => {
    expect(padToBucket(new Uint8Array(10)).byteLength).toBe(PADDING_BUCKET_BYTES);
    expect(padToBucket(new Uint8Array(300)).byteLength).toBe(PADDING_BUCKET_BYTES * 2);
  });

  it('makes different payload sizes indistinguishable', () => {
    const short = padToBucket(new Uint8Array(5));
    const longer = padToBucket(new Uint8Array(200));
    expect(short.byteLength).toBe(longer.byteLength);
  });

  it('round-trips exactly', () => {
    const payload = crypto.getRandomValues(new Uint8Array(137));
    expect(unpad(padToBucket(payload))).toEqual(payload);
  });

  it('round-trips a payload that ends in zero bytes', () => {
    // The reason padding is length-prefixed rather than zero-stripped.
    const payload = new Uint8Array([1, 2, 3, 0, 0, 0]);
    expect(unpad(padToBucket(payload))).toEqual(payload);
  });

  it('handles an exact bucket boundary', () => {
    const payload = new Uint8Array(PADDING_BUCKET_BYTES - 4);
    const padded = padToBucket(payload);
    expect(padded.byteLength).toBe(PADDING_BUCKET_BYTES);
    expect(unpad(padded)).toEqual(payload);
  });

  it('rejects a truncated or bogus payload rather than returning garbage', () => {
    expect(() => unpad(new Uint8Array(2))).toThrow();
    const lying = new Uint8Array(16);
    new DataView(lying.buffer).setUint32(0, 9999, false);
    expect(() => unpad(lying)).toThrow();
  });
});

describe('event envelopes', () => {
  it('seals and opens an event', async () => {
    const { dek } = await createVault('envelope round trip');
    const id = uuidv7();
    const event = { type: 'status_changed', to: 'interviewing', occurredAt: '2026-08-12T00:00:00Z' };

    const sealed = await sealEvent(dek, id, event);
    expect(await openEvent(dek, { id, ...sealed })).toEqual(event);
  }, 30_000);

  it('binds the ciphertext to its own id — no replay into another record', async () => {
    const { dek } = await createVault('aad binding');
    const sealed = await sealEvent(dek, uuidv7(), { secret: true });

    await expect(openEvent(dek, { id: uuidv7(), ...sealed })).rejects.toBeTruthy();
  }, 30_000);

  it('hides the payload size behind the bucket', async () => {
    const { dek } = await createVault('size hiding');

    const small = await sealEvent(dek, uuidv7(), { a: 1 });
    const larger = await sealEvent(dek, uuidv7(), { note: 'x'.repeat(150) });

    expect(small.ciphertext.length).toBe(larger.ciphertext.length);
  }, 30_000);
});

describe('wire schemas', () => {
  it('accepts a well-formed push', () => {
    expect(() =>
      PUSH_REQUEST.parse({
        events: [{ id: uuidv7(), deviceId: 'device-a', ciphertext: 'AAAA', iv: 'BBBB' }],
      }),
    ).not.toThrow();
  });

  it('rejects an empty push', () => {
    expect(() => PUSH_REQUEST.parse({ events: [] })).toThrow();
  });

  it('rejects a stored envelope missing the server-assigned fields', () => {
    expect(() =>
      STORED_ENVELOPE.parse({ id: 'x', deviceId: 'd', ciphertext: 'A', iv: 'B' }),
    ).toThrow();
  });

  it('measures the decoded byte cost for the quota', () => {
    // 4 base64 chars → 3 bytes.
    expect(envelopeBytes({ ciphertext: 'AAAA', iv: 'BBBB' })).toBe(6);
  });
});
