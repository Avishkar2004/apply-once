import { openJson, sealJson, uuidv7 } from '@autofill/core';
import { db } from '@/storage/db';
import { requireDek } from '@/storage/session';

/**
 * Sync account credentials on the device.
 *
 * ARCHITECTURE.md §6.2 requires data encrypted at rest, and a session token is a
 * credential — so it is sealed with the DEK exactly like the profile and the
 * Anthropic API key.
 *
 * **This is a deliberate trade.** A sealed token means background sync only runs
 * while the vault is unlocked, so the `chrome.alarms` tick of WEB.md §4.4 is a
 * no-op on a locked browser. The alternative — plaintext in `storage.local` so a
 * locked browser can still sync — would put a token that can push, pull and
 * *delete the account* on disk in the clear, which is the wrong side of §10's
 * "stolen phone, locked → protected". Sync-on-unlock closes most of the gap.
 *
 * The device id is **not** a credential: it is an opaque per-install label the
 * server records on each event (§4.1). It stays in the clear so it survives a
 * locked start and stays stable across passphrase changes.
 */

const SESSION_KEY = 'sync:session';
const DEVICE_KEY = 'sync:deviceId';

export interface SyncSession {
  /** Bearer token — see api/src/middleware.ts for why not a cookie. */
  token: string;
  email: string;
  baseUrl: string;
  signedInAt: string;
}

export async function saveSession(session: SyncSession): Promise<void> {
  const dek = await requireDek();
  const sealed = await sealJson(dek, 'settings', SESSION_KEY, session);
  await db().meta.put({ key: SESSION_KEY, value: sealed });
}

export async function readSession(): Promise<SyncSession | undefined> {
  const record = await db().meta.get(SESSION_KEY);
  if (!record) return undefined;

  const dek = await requireDek();
  return openJson<SyncSession>(
    dek,
    'settings',
    SESSION_KEY,
    record.value as { iv: Uint8Array; ciphertext: Uint8Array },
  );
}

export async function clearSession(): Promise<void> {
  await db().meta.delete(SESSION_KEY);
}

/** Checkable while locked — it reads no plaintext. */
export async function hasSession(): Promise<boolean> {
  return (await db().meta.get(SESSION_KEY)) !== undefined;
}

/**
 * A stable per-install identifier (§4.1 `deviceId`).
 *
 * Generated once and kept. It is not a secret and identifies an installation,
 * not a person — the server already knows which account a request belongs to.
 */
export async function deviceId(): Promise<string> {
  const existing = await db().meta.get(DEVICE_KEY);
  if (typeof existing?.value === 'string') return existing.value;

  const generated = uuidv7();
  await db().meta.put({ key: DEVICE_KEY, value: generated });
  return generated;
}
