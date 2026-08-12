import { browser } from 'wxt/browser';
import { openJson, sealJson } from '@autofill/core';
import { db } from '@/storage/db';
import { requireDek } from '@/storage/session';

/**
 * Bring-your-own-key credential storage (ARCHITECTURE.md §6.4).
 *
 * "Users can supply their own Anthropic API key so requests go direct, with no
 * intermediary. The hosted proxy is opt-in convenience, not the default."
 *
 * An API key is a bearer credential with a billing account behind it, so it is
 * sealed with the DEK exactly like the profile — never `chrome.storage.sync`,
 * which leaves the device, and never `chrome.storage.local`, which does not.
 *
 * Reaching `api.anthropic.com` needs a host permission. It is declared
 * **optional** so a user who never enables the LLM tiers never grants it; the
 * options page requests it from a click (Chrome requires a user gesture).
 */

const CREDENTIAL_KEY = 'llm:credentials';

export const ANTHROPIC_ORIGIN = 'https://api.anthropic.com/*';

interface StoredCredentials {
  apiKey: string;
  /** Optional self-hosted proxy. Empty means talk to Anthropic directly. */
  baseUrl?: string;
  updatedAt: string;
}

export async function setApiKey(apiKey: string, baseUrl?: string): Promise<void> {
  const dek = await requireDek();
  const payload: StoredCredentials = {
    apiKey: apiKey.trim(),
    ...(baseUrl?.trim() ? { baseUrl: baseUrl.trim() } : {}),
    updatedAt: new Date().toISOString(),
  };
  const sealed = await sealJson(dek, 'settings', CREDENTIAL_KEY, payload);
  await db().meta.put({ key: CREDENTIAL_KEY, value: sealed });
}

export async function readCredentials(): Promise<StoredCredentials | undefined> {
  const record = await db().meta.get(CREDENTIAL_KEY);
  if (!record) return undefined;
  const dek = await requireDek();
  return openJson<StoredCredentials>(
    dek,
    'settings',
    CREDENTIAL_KEY,
    record.value as { iv: Uint8Array; ciphertext: Uint8Array },
  );
}

export async function clearApiKey(): Promise<void> {
  await db().meta.delete(CREDENTIAL_KEY);
}

/** True when a key is stored — checkable while locked, since it reads no plaintext. */
export async function hasApiKey(): Promise<boolean> {
  return (await db().meta.get(CREDENTIAL_KEY)) !== undefined;
}

/** Never log or display a key; show its shape instead. */
export function maskApiKey(apiKey: string): string {
  if (apiKey.length <= 12) return '••••';
  return `${apiKey.slice(0, 7)}…${apiKey.slice(-4)}`;
}

export async function hasApiHostPermission(origin = ANTHROPIC_ORIGIN): Promise<boolean> {
  return browser.permissions.contains({ origins: [origin] });
}

/** Must be called from a user gesture — Chrome rejects it otherwise. */
export async function requestApiHostPermission(origin = ANTHROPIC_ORIGIN): Promise<boolean> {
  return browser.permissions.request({ origins: [origin] });
}

export async function revokeApiHostPermission(origin = ANTHROPIC_ORIGIN): Promise<void> {
  await browser.permissions.remove({ origins: [origin] });
}
