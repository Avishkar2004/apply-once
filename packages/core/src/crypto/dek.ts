import { asBuffer } from './primitives';

/**
 * The Data Encryption Key — the key that actually encrypts profile, documents and
 * answers. Generated once, wrapped by the MUK (and, separately, by the recovery
 * key), and never persisted in the clear (WEB.md §3.1).
 *
 * It is generated *extractable* on purpose: `wrapKey` requires it, and passphrase
 * rotation must be able to re-wrap the same DEK under a new MUK. It is held in
 * service-worker memory only and is never serialised outside a wrap.
 */

export const DEK_ALGORITHM = { name: 'AES-GCM', length: 256 } as const;

export function generateDek(): Promise<CryptoKey> {
  return crypto.subtle.generateKey(DEK_ALGORITHM, true, ['encrypt', 'decrypt']);
}

/** AES-KW wrap. Output is 40 bytes for a 256-bit key. */
export async function wrapDek(kek: CryptoKey, dek: CryptoKey): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.wrapKey('raw', dek, kek, 'AES-KW'));
}

export function unwrapDek(kek: CryptoKey, wrapped: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.unwrapKey('raw', asBuffer(wrapped), kek, 'AES-KW', DEK_ALGORITHM, true, [
    'encrypt',
    'decrypt',
  ]);
}
