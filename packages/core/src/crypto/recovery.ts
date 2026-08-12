import { deriveKeys, PBKDF2_ITERATIONS } from './derive';
import { randomBytes } from './primitives';

/**
 * The Recovery Kit — WEB.md §3.3.
 *
 * There is no password reset. A random recovery code derives a second KEK that
 * independently wraps the same DEK, so losing the passphrase is survivable and
 * losing both is not.
 *
 * Format: 8 groups of 4 base32 characters, exactly as printed in WEB.md §3.3.
 * 32 base32 characters carry 160 bits, which meets the documented 128-bit
 * minimum with room to spare and divides evenly into the printed layout.
 */

/** RFC 4648 base32. Uppercase, no padding in the rendered form. */
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const GROUP_SIZE = 4;
const GROUP_COUNT = 8;
const CODE_CHARS = GROUP_SIZE * GROUP_COUNT; // 32
const ENTROPY_BYTES = 20; // 160 bits → exactly 32 base32 chars

export interface RecoveryCode {
  /** Canonical form: 32 uppercase base32 characters, no separators. */
  canonical: string;
  /** Display form: 8 groups of 4, e.g. "K7M2 9QXF …". */
  formatted: string;
}

function encodeBase32(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function formatRecoveryCode(canonical: string): string {
  const groups: string[] = [];
  for (let i = 0; i < canonical.length; i += GROUP_SIZE) {
    groups.push(canonical.slice(i, i + GROUP_SIZE));
  }
  return groups.join(' ');
}

/**
 * Accept whatever the user typed — spaces, dashes, lowercase — and return the
 * canonical form, or null if it is not a well-formed code.
 */
export function normalizeRecoveryCode(input: string): string | null {
  const canonical = input.toUpperCase().replace(/[^A-Z2-7]/g, '');
  return canonical.length === CODE_CHARS ? canonical : null;
}

export function generateRecoveryCode(): RecoveryCode {
  const canonical = encodeBase32(randomBytes(ENTROPY_BYTES)).slice(0, CODE_CHARS);
  return { canonical, formatted: formatRecoveryCode(canonical) };
}

/**
 * Derive the recovery KEK. Reuses `deriveKeys` so the recovery path and the
 * passphrase path share one audited implementation; only the MUK half is used.
 */
export async function deriveRecoveryKek(
  canonicalCode: string,
  salt: Uint8Array,
  iterations = PBKDF2_ITERATIONS,
): Promise<CryptoKey> {
  const { muk, authKey } = await deriveKeys(canonicalCode, salt, iterations);
  authKey.fill(0);
  return muk;
}
