import { hmac } from './credentials';

/**
 * The account-existence oracle, and its mitigation (WEB.md §7, §12).
 *
 * "`salt` is fetched **before** login by email, which is an account-existence
 * oracle. Mitigate by returning a deterministic fake salt derived from
 * `HMAC(serverSecret, email)` for unknown accounts, so probing is
 * uninformative."
 *
 * Deterministic matters as much as fake: a random salt per request would make
 * the same unknown email return different salts on two probes, which is itself
 * the signal. The HMAC gives a stable, unguessable, per-email value that is
 * indistinguishable from a real one.
 */

export const SALT_BYTES = 16;

export async function fakeSaltFor(serverSecret: string, email: string): Promise<Uint8Array> {
  const digest = await hmac(serverSecret, `salt:${normaliseEmail(email)}`);
  return digest.slice(0, SALT_BYTES);
}

/**
 * Emails are matched case-insensitively so `Ada@Example.com` and
 * `ada@example.com` are one account — otherwise a user who capitalises
 * differently on a new device silently creates a second, empty one.
 */
export function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}
