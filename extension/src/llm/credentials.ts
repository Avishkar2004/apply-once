import { browser } from 'wxt/browser';
import { openJson, sealJson } from '@autofill/core';
import { db } from '@/storage/db';
import { requireDek } from '@/storage/session';
import { getProvider, originForProvider, type ProviderId } from './providers';

/**
 * Bring-your-own-key credential storage (ARCHITECTURE.md §6.4).
 *
 * "Users can supply their own API key so requests go direct, with no
 * intermediary. The hosted proxy is opt-in convenience, not the default."
 *
 * An API key is a bearer credential with a billing account behind it, so it is
 * sealed with the DEK exactly like the profile — never `chrome.storage.sync`,
 * which leaves the device, and never `chrome.storage.local`, which does not.
 *
 * The record now names its provider. That is not bookkeeping: a key issued by
 * OpenRouter must never be sent to Groq because the user changed a dropdown, so
 * the provider travels *inside* the sealed payload where it is authenticated,
 * and the client refuses a key whose provider does not match the selected one.
 *
 * The provider is also mirrored beside the envelope in the clear, because the
 * options page has to answer "is there a key for this provider?" while the vault
 * is still locked. It reveals a vendor name, which the settings already hold.
 *
 * Reaching a provider's host needs a permission. It is declared **optional** so
 * a user who never enables the LLM tiers never grants one; the options page
 * requests it from a click (Chrome requires a user gesture).
 */

const CREDENTIAL_KEY = 'llm:credentials';

export interface StoredCredentials {
  provider: ProviderId;
  apiKey: string;
  /** Optional self-hosted proxy or non-default host. */
  baseUrl?: string;
  updatedAt: string;
}

interface SealedEnvelope {
  iv: Uint8Array;
  ciphertext: Uint8Array;
}

/** The envelope plus an unsealed provider tag — see the module note. */
type CredentialRecord = SealedEnvelope & { provider?: ProviderId };

export async function setApiKey(
  provider: ProviderId,
  apiKey: string,
  baseUrl?: string,
): Promise<void> {
  const dek = await requireDek();
  const payload: StoredCredentials = {
    provider,
    apiKey: apiKey.trim(),
    ...(baseUrl?.trim() ? { baseUrl: baseUrl.trim() } : {}),
    updatedAt: new Date().toISOString(),
  };
  const sealed = await sealJson(dek, 'settings', CREDENTIAL_KEY, payload);
  await db().meta.put({ key: CREDENTIAL_KEY, value: { ...sealed, provider } });
}

/**
 * The stored credential, or `undefined` when there is none.
 *
 * Records written before the provider layer existed hold `{ apiKey, baseUrl }`
 * and nothing else. They were, by construction, Anthropic keys — that was the
 * only provider — so they are read as such rather than being discarded, which
 * would silently log the user out of a feature they had already configured.
 */
export async function readCredentials(): Promise<StoredCredentials | undefined> {
  const record = await db().meta.get(CREDENTIAL_KEY);
  if (!record) return undefined;

  const dek = await requireDek();
  const payload = await openJson<Partial<StoredCredentials>>(
    dek,
    'settings',
    CREDENTIAL_KEY,
    record.value as SealedEnvelope,
  );
  // A keyless provider still has something worth storing: an Ollama on another
  // machine is a base URL and no key at all.
  if (!payload.apiKey && !payload.baseUrl) return undefined;

  return {
    provider: payload.provider ?? LEGACY_PROVIDER,
    apiKey: payload.apiKey ?? '',
    ...(payload.baseUrl ? { baseUrl: payload.baseUrl } : {}),
    updatedAt: payload.updatedAt ?? new Date(0).toISOString(),
  };
}

/** Before the provider layer there was only one. */
const LEGACY_PROVIDER: ProviderId = 'anthropic';

export async function clearApiKey(): Promise<void> {
  await db().meta.delete(CREDENTIAL_KEY);
}

/** True when a key is stored — checkable while locked, since it reads no plaintext. */
export async function hasApiKey(): Promise<boolean> {
  return (await db().meta.get(CREDENTIAL_KEY)) !== undefined;
}

/**
 * Which provider the stored key belongs to, readable while locked.
 *
 * Falls back to Anthropic for a pre-provider record, matching `readCredentials`.
 */
export async function storedKeyProvider(): Promise<ProviderId | undefined> {
  const record = await db().meta.get(CREDENTIAL_KEY);
  if (!record) return undefined;
  return (record.value as CredentialRecord).provider ?? LEGACY_PROVIDER;
}

/** Never log or display a key; show its shape instead. */
export function maskApiKey(apiKey: string): string {
  if (apiKey.length <= 12) return '••••';
  return `${apiKey.slice(0, 7)}…${apiKey.slice(-4)}`;
}

export async function hasApiHostPermission(origin: string): Promise<boolean> {
  return browser.permissions.contains({ origins: [origin] });
}

/** Must be called from a user gesture — Chrome rejects it otherwise. */
export async function requestApiHostPermission(origin: string): Promise<boolean> {
  return browser.permissions.request({ origins: [origin] });
}

export async function revokeApiHostPermission(origin: string): Promise<void> {
  await browser.permissions.remove({ origins: [origin] });
}

/** Convenience for the options page, which knows a provider rather than an origin. */
export function providerOrigin(provider: ProviderId, baseUrl?: string): string {
  return originForProvider(getProvider(provider).id, baseUrl);
}
