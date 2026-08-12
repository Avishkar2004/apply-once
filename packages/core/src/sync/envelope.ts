import { z } from 'zod';
import { fromBase64, toBase64 } from '../crypto/primitives';
import { open, seal, type SealedEnvelope } from '../crypto/envelope';

/**
 * The sync wire format (WEB.md §4.1).
 *
 * ```ts
 * interface EventEnvelope {
 *   id: string;          // UUIDv7, client-generated — the dedup key
 *   userId: string;      // server-assigned
 *   seq: number;         // server-assigned, monotonic per user — the pull watermark
 *   deviceId: string;    // opaque, client-generated at install
 *   ciphertext: Uint8Array;  // AES-GCM(DEK, JSON(ApplicationEvent)), AAD = "af1:event:<id>"
 *   iv: Uint8Array;
 *   createdAt: string;   // server clock — used only for GC, never for ordering
 * }
 * ```
 *
 * Two things this file exists to make impossible:
 *
 *  - **Divergence.** §9: "the crypto, schema and projector must be
 *    byte-identical across clients". The codec lives in `core` so the extension,
 *    the API and any future web client encode the same bytes.
 *  - **Accidental plaintext.** Nothing here can construct an envelope without a
 *    `CryptoKey`. The server type has no path to the payload at all.
 *
 * JSON cannot carry raw bytes, so `ciphertext` and `iv` travel base64. WEB.md
 * does not name an encoding; base64 is the only sane choice for a JSON body and
 * costs 33% over the wire on an already-small payload.
 */

/** WEB.md §10/§12 — "pad envelopes to fixed 256-byte buckets" to blur sizes. */
export const PADDING_BUCKET_BYTES = 256;

/** §8 — "50 MB and 50,000 events per account, enforced at push." */
export const MAX_EVENTS_PER_ACCOUNT = 50_000;
export const MAX_BYTES_PER_ACCOUNT = 50 * 1024 * 1024;

/** §4.2 — the pull page size. */
export const DEFAULT_PULL_LIMIT = 500;
export const MAX_PULL_LIMIT = 1000;

/**
 * What a client sends. `userId`, `seq` and `createdAt` are the server's to
 * assign, so they are absent here by construction rather than by convention.
 */
export const PUSHED_ENVELOPE = z.object({
  id: z.string().min(1).max(64),
  deviceId: z.string().min(1).max(64),
  /** base64 of the AES-GCM ciphertext. */
  ciphertext: z.string().min(1),
  /** base64 of the 12-byte IV. */
  iv: z.string().min(1),
});
export type PushedEnvelope = z.infer<typeof PUSHED_ENVELOPE>;

/** What the server returns. Same bytes, plus the fields it owns. */
export const STORED_ENVELOPE = PUSHED_ENVELOPE.extend({
  userId: z.string(),
  seq: z.number().int().nonnegative(),
  createdAt: z.string(),
});
export type StoredEnvelope = z.infer<typeof STORED_ENVELOPE>;

export const PUSH_REQUEST = z.object({
  events: z.array(PUSHED_ENVELOPE).min(1).max(MAX_PULL_LIMIT),
});
export type PushRequest = z.infer<typeof PUSH_REQUEST>;

export const PUSH_RESPONSE = z.object({
  assigned: z.array(z.object({ id: z.string(), seq: z.number().int().nonnegative() })),
  highWater: z.number().int().nonnegative(),
});
export type PushResponse = z.infer<typeof PUSH_RESPONSE>;

export const PULL_RESPONSE = z.object({
  events: z.array(STORED_ENVELOPE),
  highWater: z.number().int().nonnegative(),
  more: z.boolean(),
});
export type PullResponse = z.infer<typeof PULL_RESPONSE>;

/**
 * Pad to the next 256-byte bucket so the server cannot read note length off the
 * ciphertext size (§10, "Metadata the server does learn").
 *
 * Length-prefixed rather than delimiter-stripped: a 4-byte big-endian length
 * followed by the payload and then zeros. Trailing-zero-stripping would corrupt
 * any payload that legitimately ends in a zero byte.
 */
export function padToBucket(payload: Uint8Array, bucket = PADDING_BUCKET_BYTES): Uint8Array {
  const total = Math.ceil((payload.byteLength + 4) / bucket) * bucket;
  const padded = new Uint8Array(total);
  new DataView(padded.buffer).setUint32(0, payload.byteLength, false);
  padded.set(payload, 4);
  return padded;
}

export function unpad(padded: Uint8Array): Uint8Array {
  if (padded.byteLength < 4) throw new Error('Padded payload is truncated');
  const length = new DataView(
    padded.buffer,
    padded.byteOffset,
    padded.byteLength,
  ).getUint32(0, false);
  if (length > padded.byteLength - 4) throw new Error('Padded payload declares a bogus length');
  return padded.slice(4, 4 + length);
}

/**
 * Seal an event for transport.
 *
 * The AAD is `af1:event:<id>` (§3.1), which binds the ciphertext to its own
 * record id — a blob lifted from one row cannot be replayed into another.
 */
export async function sealEvent(
  dek: CryptoKey,
  id: string,
  event: unknown,
  bucket = PADDING_BUCKET_BYTES,
): Promise<{ ciphertext: string; iv: string }> {
  const plaintext = new TextEncoder().encode(JSON.stringify(event));
  const sealed = await seal(dek, 'event', id, padToBucket(plaintext, bucket));
  return { ciphertext: toBase64(sealed.ciphertext), iv: toBase64(sealed.iv) };
}

export async function openEvent<T>(
  dek: CryptoKey,
  envelope: Pick<StoredEnvelope, 'id' | 'ciphertext' | 'iv'>,
): Promise<T> {
  const sealed: SealedEnvelope = {
    ciphertext: fromBase64(envelope.ciphertext),
    iv: fromBase64(envelope.iv),
  };
  const padded = await open(dek, 'event', envelope.id, sealed);
  return JSON.parse(new TextDecoder().decode(unpad(padded))) as T;
}

/** Byte cost of an envelope against the §8 quota — the ciphertext, decoded. */
export function envelopeBytes(envelope: Pick<PushedEnvelope, 'ciphertext' | 'iv'>): number {
  const base64Bytes = (value: string) => Math.floor((value.length * 3) / 4);
  return base64Bytes(envelope.ciphertext) + base64Bytes(envelope.iv);
}
