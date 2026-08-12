/**
 * Hashing.
 *
 * Two distinct needs, two distinct functions:
 *
 * - `stableHash` — synchronous, non-cryptographic. Produces `FieldDescriptor.id`
 *   and `FieldDescriptor.signature` (ARCHITECTURE.md §3.1). The scanner runs this
 *   once per field inside a DOM walk, so it must not be async and must not be
 *   expensive. Collision resistance against an adversary is not a requirement —
 *   these are cache keys for the local machine.
 * - `sha256Hex` — async, cryptographic. Content-addresses blobs and derives the
 *   Answer Bank question hash.
 */

/** FNV-1a over 64 bits, emulated with two 32-bit lanes. Returns 16 hex chars. */
export function stableHash(input: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0xc9dc5118;
  for (let i = 0; i < input.length; i += 1) {
    const code = input.charCodeAt(i);
    h1 ^= code;
    h1 = Math.imul(h1, 0x01000193) >>> 0;
    h2 ^= code + i;
    h2 = Math.imul(h2, 0x85ebca6b) >>> 0;
  }
  return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
}

/** SHA-256 of a UTF-8 string or raw bytes, lowercase hex. */
export async function sha256Hex(input: string | ArrayBuffer | Uint8Array): Promise<string> {
  const bytes =
    typeof input === 'string'
      ? new TextEncoder().encode(input)
      : input instanceof Uint8Array
        ? input
        : new Uint8Array(input);
  const digest = await crypto.subtle.digest('SHA-256', bytes as unknown as BufferSource);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
