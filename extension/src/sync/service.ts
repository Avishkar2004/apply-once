import { browser } from 'wxt/browser';
import {
  createHttpSyncApi,
  deriveKeys,
  fromBase64,
  SyncError,
  syncOnce,
  toBase64,
  unlockVault,
  type SyncOutcome,
} from '@autofill/core';
import { createLogger } from '@/shared/logger';
import { getVault, peekDek } from '@/storage/session';
import { clearSession, deviceId, hasSession, readSession, saveSession } from './credentials';
import { clearSyncState, dexieSyncStore } from './store';

const log = createLogger('sync');

/**
 * The sync service — W4 of WEB.md.
 *
 * Everything here is optional. ARCHITECTURE.md §6.1 is explicit that the
 * extension is local-first and needs no backend: with no sync account, every
 * function here no-ops and the rest of the product is unaffected.
 *
 * §4.4 cadence for the extension: "`chrome.alarms` every 15 min · immediately
 * after any capture · on browser startup."
 */

export const SYNC_ALARM = 'autofill:sync';
export const SYNC_INTERVAL_MINUTES = 15;

export type SyncState =
  | { status: 'signed-out' }
  | { status: 'locked'; email?: string }
  | { status: 'idle'; email: string; pending: number; events: number; highWater: number }
  | { status: 'syncing'; email: string }
  | { status: 'error'; email: string; message: string; retryable: boolean };

let inFlight: Promise<SyncOutcome | undefined> | undefined;
let lastError: { message: string; retryable: boolean } | undefined;

/**
 * Derive the auth key half and register an account (WEB.md §3.1, §7).
 *
 * The passphrase never leaves the device. What the server receives is the
 * second 32 bytes of a 600k-iteration PBKDF2, plus two wraps of a DEK it cannot
 * open.
 */
export async function signUp(email: string, passphrase: string, baseUrl: string): Promise<void> {
  const vault = await getVault();
  if (!vault) throw new Error('Set a passphrase in AutoFill before enabling sync.');

  // Signing up re-derives from the *existing* local vault, so the account's DEK
  // is the DEK already protecting this device's data. Creating a fresh one here
  // would orphan everything already stored.
  const { authKey } = await deriveKeys(passphrase, vault.salt, vault.iterations);
  // Prove the passphrase matches this vault before telling a server about it.
  await unlockVault(vault, passphrase);

  const response = await post(baseUrl, '/auth/signup', {
    email,
    authKey: toBase64(authKey),
    salt: toBase64(vault.salt),
    wrappedDek: toBase64(vault.wrappedDek),
    wrappedDekRecovery: toBase64(vault.wrappedDekRecovery),
    transport: 'bearer',
  });

  authKey.fill(0);
  await saveSession({
    token: (response as { sessionId: string }).sessionId,
    email,
    baseUrl,
    signedInAt: new Date().toISOString(),
  });
  await scheduleAlarm();
}

export async function signIn(email: string, passphrase: string, baseUrl: string): Promise<void> {
  // The salt is the server's; a device signing in for the first time has no
  // local vault to read it from. Unknown accounts get a deterministic fake
  // (§7), so this request answers nothing about who exists.
  const { salt } = (await get(baseUrl, `/auth/salt?email=${encodeURIComponent(email)}`)) as {
    salt: string;
  };

  const { authKey } = await deriveKeys(passphrase, fromBase64(salt));
  const response = (await post(baseUrl, '/auth/login', {
    email,
    authKey: toBase64(authKey),
    deviceId: await deviceId(),
    transport: 'bearer',
  })) as { sessionId: string; wrappedDek: string; salt: string };
  authKey.fill(0);

  await saveSession({
    token: response.sessionId,
    email,
    baseUrl,
    signedInAt: new Date().toISOString(),
  });
  await scheduleAlarm();
}

export async function signOut(): Promise<void> {
  const session = await readSession().catch(() => undefined);
  if (session) {
    await post(session.baseUrl, '/auth/logout', {}, session.token).catch(() => undefined);
  }
  await clearSession();
  // The local event log is NOT deleted. It is this device's data, and §5 is
  // clear that local-first survives the server being switched off.
  await clearSyncState();
  await browser.alarms.clear(SYNC_ALARM);
}

/**
 * Run one sync (§4.3).
 *
 * Re-entrant by design: the 15-minute alarm can fire while a capture-triggered
 * sync is still running, and two concurrent loops would race on the cursor and
 * the push queue. The second caller joins the first instead.
 */
export async function runSync(reason: string): Promise<SyncOutcome | undefined> {
  if (inFlight) {
    log.debug(`sync already running; ${reason} joins it`);
    return inFlight;
  }

  inFlight = (async () => {
    try {
      // Sealed credentials mean a locked vault cannot sync. Not an error —
      // the next unlock triggers one.
      if (!(await peekDek())) {
        if (await hasSession()) log.debug(`sync skipped (${reason}): vault is locked`);
        return undefined;
      }

      const session = await readSession();
      if (!session) return undefined;

      const api = createHttpSyncApi({
        baseUrl: session.baseUrl,
        token: () => session.token,
      });

      const outcome = await syncOnce({ store: dexieSyncStore, api });

      if (outcome.stoppedBecause) {
        lastError = {
          message: outcome.stoppedBecause.message,
          retryable: outcome.stoppedBecause.retryable,
        };
        // A dead session should not keep firing every 15 minutes forever.
        if (outcome.stoppedBecause.kind === 'unauthenticated') await clearSession();
        log.warn(`sync stopped (${reason}): ${outcome.stoppedBecause.kind}`);
      } else {
        lastError = undefined;
        log.info(`sync ok (${reason}): +${outcome.pushed} pushed, +${outcome.pulled} pulled`);
      }

      return outcome;
    } finally {
      inFlight = undefined;
    }
  })();

  return inFlight;
}

export async function syncState(): Promise<SyncState> {
  if (!(await hasSession())) return { status: 'signed-out' };
  if (!(await peekDek())) return { status: 'locked' };

  const session = await readSession();
  if (!session) return { status: 'signed-out' };
  if (inFlight) return { status: 'syncing', email: session.email };

  if (lastError) {
    return {
      status: 'error',
      email: session.email,
      message: lastError.message,
      retryable: lastError.retryable,
    };
  }

  return {
    status: 'idle',
    email: session.email,
    pending: await dexieSyncStore.countPending(),
    events: await dexieSyncStore.countEvents(),
    highWater: await dexieSyncStore.highWater(),
  };
}

/**
 * Register the cadence (§4.4).
 *
 * `chrome.alarms` survives service-worker eviction — a `setInterval` in a
 * worker does not, which is why the spec names alarms specifically.
 */
export async function scheduleAlarm(): Promise<void> {
  await browser.alarms.create(SYNC_ALARM, { periodInMinutes: SYNC_INTERVAL_MINUTES });
}

export function registerSyncTriggers(): void {
  browser.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === SYNC_ALARM) void runSync('alarm');
  });

  // "on browser startup" (§4.4). Usually a no-op because the vault is locked,
  // but it costs nothing and covers a browser restarted while unlocked.
  browser.runtime.onStartup.addListener(() => void runSync('startup'));

  void hasSession().then((present) => {
    if (present) void scheduleAlarm();
  });
}

// ── HTTP helpers ────────────────────────────────────────────────────────────

async function post(baseUrl: string, path: string, body: unknown, token?: string) {
  return request(baseUrl, path, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
}

async function get(baseUrl: string, path: string) {
  return request(baseUrl, path, { method: 'GET' });
}

async function request(baseUrl: string, path: string, init: RequestInit): Promise<unknown> {
  const response = await fetch(`${baseUrl.replace(/\/$/, '')}${path}`, init);
  if (response.ok) return response.json();

  const detail = await response.text().catch(() => '');
  let message = detail;
  try {
    message = (JSON.parse(detail) as { error?: string }).error ?? detail;
  } catch {
    /* not JSON — use the raw text */
  }
  throw new SyncError(
    response.status === 401 ? 'unauthenticated' : response.status >= 500 ? 'transient' : 'rejected',
    message || response.statusText,
    response.status,
  );
}

