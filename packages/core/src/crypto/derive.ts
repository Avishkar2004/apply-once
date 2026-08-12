import { asBuffer, utf8 } from './primitives';

/**
 * Key derivation — WEB.md §3.1.
 *
 *   passphrase → PBKDF2-SHA256(600k, per-account salt) → 512 bits
 *                bytes 0–31  → Master Unlock Key (AES-KW, never leaves the device)
 *                bytes 32–63 → Auth Key (sent to the server; it stores only a hash)
 *
 * The MUK only ever wraps the Data Encryption Key. That indirection is what makes
 * a passphrase change a single-row update instead of a full re-encryption.
 */

/** WEB.md §3.1. Changing this number invalidates every existing vault. */
export const PBKDF2_ITERATIONS = 600_000;

export const SALT_BYTES = 16;

export interface DerivedKeys {
  /** Wraps/unwraps the DEK. Non-extractable: its bytes never become readable. */
  muk: CryptoKey;
  /** Bytes 32–63. Sent to the server over TLS at signup/login; never stored locally. */
  authKey: Uint8Array;
}

export async function deriveKeys(
  passphrase: string,
  salt: Uint8Array,
  iterations = PBKDF2_ITERATIONS,
): Promise<DerivedKeys> {
  const base = await crypto.subtle.importKey('raw', asBuffer(utf8(passphrase)), 'PBKDF2', false, [
    'deriveBits',
  ]);

  const bits = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: 'PBKDF2', salt: asBuffer(salt), iterations, hash: 'SHA-256' },
      base,
      512,
    ),
  );

  const muk = await crypto.subtle.importKey('raw', asBuffer(bits.slice(0, 32)), 'AES-KW', false, [
    'wrapKey',
    'unwrapKey',
  ]);

  const authKey = bits.slice(32, 64);

  bits.fill(0);
  return { muk, authKey };
}
