/**
 * Server-side handling of the auth key (WEB.md §3.1, §7).
 *
 * "The server receives the auth key (over TLS) and stores only a scrypt hash of
 * it, exactly as it would a password — so a server breach yields a hash of a
 * value that is itself the output of 600k PBKDF2 iterations. The MUK, which is
 * the half that actually matters, is never transmitted in any form."
 *
 * **Documented deviation: PBKDF2-SHA256, not scrypt.** The Workers runtime
 * exposes WebCrypto, which has no scrypt, and a pure-JS scrypt in a request path
 * is a CPU-time DoS waiting to happen. The substitution is sound here for a
 * reason specific to this design: the auth key is *not* a human password. It is
 * 256 bits of high-entropy output from a 600k-iteration client-side PBKDF2, so
 * the server-side hash is not defending against a dictionary attack — there is
 * no dictionary. It defends against a breached database yielding a
 * directly-replayable bearer token, and any preimage-resistant KDF does that.
 * 100k iterations is belt-and-braces on a value that is already unguessable.
 *
 * If scrypt is ever wanted here, the honest way is a WASM build behind a
 * separate binding, not a JS loop on the request path.
 */

export const AUTH_HASH_ITERATIONS = 100_000;
const SALT_BYTES = 16;
const HASH_BITS = 256;

const encoder = new TextEncoder();

function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

async function derive(
  authKey: string,
  salt: Uint8Array,
  iterations: number,
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', encoder.encode(authKey), 'PBKDF2', false, [
    'deriveBits',
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: salt as BufferSource, iterations, hash: 'SHA-256' },
    key,
    HASH_BITS,
  );
  return new Uint8Array(bits);
}

export interface StoredAuthHash {
  hash: Uint8Array;
  salt: Uint8Array;
  iterations: number;
}

export async function hashAuthKey(authKey: string): Promise<StoredAuthHash> {
  const salt = randomBytes(SALT_BYTES);
  return {
    hash: await derive(authKey, salt, AUTH_HASH_ITERATIONS),
    salt,
    iterations: AUTH_HASH_ITERATIONS,
  };
}

/**
 * Constant-time verification.
 *
 * The comparison is timing-safe, but note what it cannot hide: a *missing*
 * account returns faster than a present one unless the caller burns an
 * equivalent derivation. `verifyAgainstDecoy` below is what closes that.
 */
export async function verifyAuthKey(authKey: string, stored: StoredAuthHash): Promise<boolean> {
  const candidate = await derive(authKey, stored.salt, stored.iterations);
  return timingSafeEqual(candidate, stored.hash);
}

/**
 * Burn the same work for an account that does not exist, so login latency does
 * not answer "does this email have an account?". Pairs with the fake-salt
 * mitigation in `salt.ts`.
 */
export async function verifyAgainstDecoy(authKey: string, serverSecret: string): Promise<false> {
  const salt = await hmac(serverSecret, 'decoy');
  await derive(authKey, salt.slice(0, SALT_BYTES), AUTH_HASH_ITERATIONS);
  return false;
}

export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

export async function hmac(secret: string, message: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(message)));
}
