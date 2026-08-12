import { MAX_BYTES_PER_ACCOUNT, MAX_EVENTS_PER_ACCOUNT } from '@autofill/core';
import type { Env } from './env';
import { normaliseEmail } from './auth/salt';

/**
 * The accounts table (WEB.md §3.1, §8).
 *
 * Everything the server holds about a user is either public (the KDF salt),
 * a hash (the auth key), or a wrap it cannot open (the two DEK copies). §10:
 * "Server breach — database and blobs stolen → **Yes** [protected]. Ciphertext
 * plus a scrypt hash of a 600k-PBKDF2 output."
 */

export interface AccountRow {
  user_id: string;
  email: string;
  salt: ArrayBuffer;
  auth_hash: ArrayBuffer;
  auth_salt: ArrayBuffer;
  auth_iterations: number;
  wrapped_dek: ArrayBuffer;
  wrapped_dek_recovery: ArrayBuffer;
  event_count: number;
  byte_count: number;
  web_access: number;
  created_at: string;
  updated_at: string;
}

export async function findAccountByEmail(env: Env, email: string): Promise<AccountRow | undefined> {
  const row = await env.DB.prepare('SELECT * FROM accounts WHERE email = ?')
    .bind(normaliseEmail(email))
    .first<AccountRow>();
  return row ?? undefined;
}

export async function findAccountById(env: Env, userId: string): Promise<AccountRow | undefined> {
  const row = await env.DB.prepare('SELECT * FROM accounts WHERE user_id = ?')
    .bind(userId)
    .first<AccountRow>();
  return row ?? undefined;
}

export interface QuotaState {
  events: number;
  bytes: number;
  eventsRemaining: number;
  bytesRemaining: number;
}

/**
 * §8 — "Quota: 50 MB and 50,000 events per account, enforced at push. At the
 * projected ~2 MB and ~2,700 events for 300 applications this is a 20× headroom
 * that exists only to bound a runaway client."
 *
 * Read from running totals on the account row rather than `COUNT(*)`, so the
 * check is O(1) no matter how long the log gets.
 */
export function quotaFor(account: AccountRow): QuotaState {
  return {
    events: account.event_count,
    bytes: account.byte_count,
    eventsRemaining: Math.max(0, MAX_EVENTS_PER_ACCOUNT - account.event_count),
    bytesRemaining: Math.max(0, MAX_BYTES_PER_ACCOUNT - account.byte_count),
  };
}

export function wouldExceedQuota(
  account: AccountRow,
  addedEvents: number,
  addedBytes: number,
): boolean {
  return (
    account.event_count + addedEvents > MAX_EVENTS_PER_ACCOUNT ||
    account.byte_count + addedBytes > MAX_BYTES_PER_ACCOUNT
  );
}

export function toBytes(value: ArrayBuffer | Uint8Array | null): Uint8Array {
  if (!value) return new Uint8Array();
  return value instanceof Uint8Array ? value : new Uint8Array(value);
}

export function toBase64(value: ArrayBuffer | Uint8Array | null): string {
  const bytes = toBytes(value);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]!);
  return btoa(binary);
}

export function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
