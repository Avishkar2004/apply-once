import { browser } from 'wxt/browser';
import {
  createVault,
  rotatePassphrase,
  unlockVault,
  unlockVaultWithRecoveryCode,
  VaultLockedError,
  type VaultRecord,
} from '@autofill/core';
import type { RecoveryCodeDto, SessionStatus } from '@/shared/messages';
import { db, PROFILE_RECORD_ID, VAULT_META_KEY } from './db';

/**
 * Where the unlock key lives.
 *
 * ARCHITECTURE.md §6.2 asks for "unlocked per browser session, held in
 * service-worker memory only". Manifest V3 evicts an idle service worker after
 * ~30 seconds, which would mean re-typing the passphrase for every single fill.
 *
 * So: the `CryptoKey` is held in a module variable (the fast path), and its raw
 * bytes are mirrored into `chrome.storage.session` so a restarted worker can
 * rehydrate within the same browser session. `storage.session` is memory-backed,
 * cleared when the browser closes, and — with the default TRUSTED_CONTEXTS
 * access level — unreadable from content scripts. It never touches disk.
 *
 * This is a deliberate, documented widening of §6.2 from "worker memory" to
 * "extension-process memory". Anything stronger costs a passphrase prompt per
 * fill, which no one would use.
 */

const SESSION_DEK_KEY = 'autofill:dek';

let cachedDek: CryptoKey | undefined;

/** Uint8Array does not survive `storage.session`; move the bytes as a number array. */
type SerialisedKey = number[];

async function importDek(bytes: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', bytes as unknown as BufferSource, { name: 'AES-GCM' }, true, [
    'encrypt',
    'decrypt',
  ]);
}

async function stashDek(dek: CryptoKey): Promise<void> {
  cachedDek = dek;
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', dek));
  await browser.storage.session.set({ [SESSION_DEK_KEY]: Array.from(raw) as SerialisedKey });
}

async function rehydrateDek(): Promise<CryptoKey | undefined> {
  const stored = await browser.storage.session.get(SESSION_DEK_KEY);
  const raw = stored[SESSION_DEK_KEY] as SerialisedKey | undefined;
  if (!raw || raw.length === 0) return undefined;
  cachedDek = await importDek(Uint8Array.from(raw));
  return cachedDek;
}

export async function getVault(): Promise<VaultRecord | undefined> {
  const record = await db().meta.get(VAULT_META_KEY);
  return record?.value as VaultRecord | undefined;
}

async function putVault(vault: VaultRecord): Promise<void> {
  await db().meta.put({ key: VAULT_META_KEY, value: vault });
}

/** The DEK, or `undefined` when locked. */
export async function peekDek(): Promise<CryptoKey | undefined> {
  return cachedDek ?? (await rehydrateDek());
}

/** The DEK, or a `VaultLockedError`. Every store that reads PII goes through this. */
export async function requireDek(): Promise<CryptoKey> {
  const dek = await peekDek();
  if (!dek) throw new VaultLockedError('Unlock AutoFill to read your profile.');
  return dek;
}

export async function sessionStatus(): Promise<SessionStatus> {
  const [vault, dek, profile] = await Promise.all([
    getVault(),
    peekDek(),
    db().profile.get(PROFILE_RECORD_ID),
  ]);
  return { hasVault: !!vault, unlocked: !!dek, hasProfile: !!profile };
}

/**
 * First run: create the vault and hand back the Recovery Kit.
 * WEB.md §3.3 — the caller must not consider setup complete until the user has
 * confirmed they saved this code, and it is never retrievable again.
 */
export async function createSession(passphrase: string): Promise<RecoveryCodeDto> {
  if (await getVault()) throw new Error('A vault already exists on this device.');
  const { vault, dek, recoveryCode } = await createVault(passphrase);
  await putVault(vault);
  await stashDek(dek);
  return { canonical: recoveryCode.canonical, formatted: recoveryCode.formatted };
}

export async function unlockSession(passphrase: string): Promise<SessionStatus> {
  const vault = await getVault();
  if (!vault) throw new Error('No vault on this device yet — set a passphrase first.');
  await stashDek(await unlockVault(vault, passphrase));
  return sessionStatus();
}

export async function unlockSessionWithRecoveryCode(code: string): Promise<SessionStatus> {
  const vault = await getVault();
  if (!vault) throw new Error('No vault on this device yet — set a passphrase first.');
  await stashDek(await unlockVaultWithRecoveryCode(vault, code));
  return sessionStatus();
}

export async function lockSession(): Promise<SessionStatus> {
  cachedDek = undefined;
  await browser.storage.session.remove(SESSION_DEK_KEY);
  return sessionStatus();
}

/**
 * Passphrase change re-wraps the same DEK — no stored data is touched
 * (WEB.md §3.1).
 */
export async function rotateSessionPassphrase(current: string, next: string): Promise<void> {
  const vault = await getVault();
  if (!vault) throw new Error('No vault on this device yet.');
  await putVault(await rotatePassphrase(vault, current, next));
}

/** Test seam. */
export function __clearSessionCacheForTests(): void {
  cachedDek = undefined;
}
