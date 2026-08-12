/**
 * Small shared helpers for the crypto module.
 *
 * WebCrypto only — no Node built-ins, no polyfills. `packages/core` runs in a
 * service worker, a browser tab and Vitest, and all three provide `crypto.subtle`.
 */

/** WebCrypto's BufferSource typing is stricter than it needs to be here. */
export const asBuffer = (bytes: Uint8Array): BufferSource => bytes as unknown as BufferSource;

export function randomBytes(length: number): Uint8Array {
  const out = new Uint8Array(length);
  crypto.getRandomValues(out);
  return out;
}

export function utf8(input: string): Uint8Array {
  return new TextEncoder().encode(input);
}

export function fromUtf8(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

export function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]!);
  return btoa(binary);
}

export function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

export function toHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Constant-time-ish comparison. Used for auth-key echoes, never for ciphertext. */
export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}
