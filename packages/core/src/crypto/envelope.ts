import { asBuffer, fromUtf8, randomBytes, utf8 } from './primitives';

/**
 * AES-GCM envelopes.
 *
 * WEB.md §3.1: "Every envelope binds its context as AES-GCM `additionalData` —
 * `af1:<kind>:<id>` — so a ciphertext lifted from one record cannot be replayed
 * into another."
 */

export const ENVELOPE_PREFIX = 'af1';
export const IV_BYTES = 12;

/** Record kinds that can be sealed. Part of the AAD, so this list is a wire contract. */
export type EnvelopeKind = 'profile' | 'document' | 'answer' | 'event' | 'blob' | 'settings';

export interface SealedEnvelope {
  iv: Uint8Array;
  ciphertext: Uint8Array;
}

export function additionalData(kind: EnvelopeKind, id: string): Uint8Array {
  return utf8(`${ENVELOPE_PREFIX}:${kind}:${id}`);
}

export async function seal(
  dek: CryptoKey,
  kind: EnvelopeKind,
  id: string,
  plaintext: Uint8Array,
): Promise<SealedEnvelope> {
  const iv = randomBytes(IV_BYTES);
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: asBuffer(iv), additionalData: asBuffer(additionalData(kind, id)) },
      dek,
      asBuffer(plaintext),
    ),
  );
  return { iv, ciphertext };
}

export async function open(
  dek: CryptoKey,
  kind: EnvelopeKind,
  id: string,
  envelope: SealedEnvelope,
): Promise<Uint8Array> {
  const plaintext = await crypto.subtle.decrypt(
    {
      name: 'AES-GCM',
      iv: asBuffer(envelope.iv),
      additionalData: asBuffer(additionalData(kind, id)),
    },
    dek,
    asBuffer(envelope.ciphertext),
  );
  return new Uint8Array(plaintext);
}

export async function sealJson(
  dek: CryptoKey,
  kind: EnvelopeKind,
  id: string,
  value: unknown,
): Promise<SealedEnvelope> {
  return seal(dek, kind, id, utf8(JSON.stringify(value)));
}

export async function openJson<T>(
  dek: CryptoKey,
  kind: EnvelopeKind,
  id: string,
  envelope: SealedEnvelope,
): Promise<T> {
  return JSON.parse(fromUtf8(await open(dek, kind, id, envelope))) as T;
}
