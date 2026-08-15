import { browser } from 'wxt/browser';
import { DEFAULT_PROVIDER } from '@/llm/providers/types';
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
  llmProvider: DEFAULT_PROVIDER,
  // Empty means "whatever the selected provider defaults to" — see
  // `resolveModel`. Storing the defaults here would freeze them at install.
  llmModels: {},
  // Voluntary self-identification is never filled unless the user asks for it (§4).
  fillEeo: false,
};

/**
 * Read the preferences, repairing anything that does not match the current shape.
 *
 * `chrome.storage.sync` is **untrusted input**, not a typed store. What comes
 * back was written by some build of this extension — an older one on this
 * machine, or a newer one on another device that synced down — and the `Settings`
 * type is only a claim about the version that happens to be running now.
 *
 * A plain `{ ...DEFAULT_SETTINGS, ...stored }` is not enough on its own: spread
 * copies a key whose value is `undefined` straight over the default, so a stored
 * object that merely *mentions* a field can erase it. That is how a required
 * field reaches the options page missing and crashes it on the first nested
 * read — `settings.llmModels[provider]` with no `llmModels`.
 *
 * So every field that anything indexes into is checked for its type rather than
 * its presence. Cheap, and it means no consumer has to defend itself.
 */
export async function getSettings(): Promise<Settings> {
  const stored = await browser.storage.sync.get(KEY);
  return repairSettings((stored[KEY] as Partial<Settings> | undefined) ?? {});
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export function repairSettings(stored: Partial<Settings>): Settings {
  const merged = { ...DEFAULT_SETTINGS, ...stored };

  return {
    ...merged,
    enabled: typeof merged.enabled === 'boolean' ? merged.enabled : DEFAULT_SETTINGS.enabled,
    autoFill: typeof merged.autoFill === 'boolean' ? merged.autoFill : DEFAULT_SETTINGS.autoFill,
    llmEnabled:
      typeof merged.llmEnabled === 'boolean' ? merged.llmEnabled : DEFAULT_SETTINGS.llmEnabled,
    fillEeo: typeof merged.fillEeo === 'boolean' ? merged.fillEeo : DEFAULT_SETTINGS.fillEeo,
    theme: merged.theme ?? DEFAULT_SETTINGS.theme,
    // Both of these are indexed into without a guard elsewhere — the orchestrator
    // calls `.includes()` on one and the options page reads a provider key off
    // the other. Neither may be absent.
    disabledHosts: Array.isArray(merged.disabledHosts)
      ? merged.disabledHosts
      : DEFAULT_SETTINGS.disabledHosts,
    llmProvider: merged.llmProvider ?? DEFAULT_SETTINGS.llmProvider,
    llmModels: isObject(merged.llmModels) ? merged.llmModels : {},
  };
}

/**
 * Repaired on the way out as well as in: a caller that spreads a partially built
 * object can hand us `{ llmModels: undefined }`, and writing that would put the
 * broken value on every device this profile syncs to.
 */
export async function setSettings(patch: Partial<Settings>): Promise<Settings> {
  const next = repairSettings({ ...(await getSettings()), ...patch });
  await browser.storage.sync.set({ [KEY]: next });
  return next;
}

export async function isHostEnabled(hostname: string): Promise<boolean> {
  const settings = await getSettings();
  return settings.enabled && !settings.disabledHosts.includes(hostname);
}
