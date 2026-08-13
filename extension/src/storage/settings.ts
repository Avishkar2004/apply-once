import { browser } from 'wxt/browser';
import type { Settings } from '@/shared/messages';

/**
 * Non-sensitive preferences only (ARCHITECTURE.md §4): theme, enabled sites,
 * LLM on/off. `chrome.storage.sync` leaves the device, so nothing that could
 * identify the user goes in here — no email, no company names, no field data.
 */

const KEY = 'settings';

export const DEFAULT_SETTINGS: Settings = {
  enabled: true,
  // On by default: the point of the product is not typing. A fill is always
  // reviewable and never submits, so the cost of doing it unasked is low.
  autoFill: true,
  theme: 'system',
  disabledHosts: [],
  // Off until the user configures a key; Tier 3 and answer drafts are opt-in (§6.3–6.4).
  llmEnabled: false,
  // Voluntary self-identification is never filled unless the user asks for it (§4).
  fillEeo: false,
};

export async function getSettings(): Promise<Settings> {
  const stored = await browser.storage.sync.get(KEY);
  return { ...DEFAULT_SETTINGS, ...((stored[KEY] as Partial<Settings> | undefined) ?? {}) };
}

export async function setSettings(patch: Partial<Settings>): Promise<Settings> {
  const next = { ...(await getSettings()), ...patch };
  await browser.storage.sync.set({ [KEY]: next });
  return next;
}

export async function isHostEnabled(hostname: string): Promise<boolean> {
  const settings = await getSettings();
  return settings.enabled && !settings.disabledHosts.includes(hostname);
}
