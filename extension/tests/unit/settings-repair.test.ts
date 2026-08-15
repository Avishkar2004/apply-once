import { beforeEach, describe, expect, it } from 'vitest';
import { browser } from 'wxt/browser';
import { DEFAULT_SETTINGS, getSettings, repairSettings, setSettings } from '@/storage/settings';
import type { Settings } from '@/shared/messages';

/**
 * `chrome.storage.sync` is untrusted input, not a typed store.
 *
 * Whatever comes back was written by *some* build of this extension — an older
 * one on this machine, or a newer one on another device that synced down — and
 * the `Settings` type only describes the version running right now.
 *
 * This is not hypothetical. Adding `llmModels` as a required field shipped an
 * options page that read `settings.llmModels[provider]` on a stored object that
 * predated the field, and the whole AI tab died with "Cannot read properties of
 * undefined". A required field in TypeScript is a claim about new code, not a
 * guarantee about old data.
 */

const put = async (value: unknown) => {
  await browser.storage.sync.set({ settings: value });
};

beforeEach(async () => {
  await browser.storage.sync.clear();
});

describe('reading settings written by another version', () => {
  it('fills in a field that did not exist when the settings were saved', async () => {
    // Exactly the pre-provider-layer shape.
    await put({ enabled: true, autoFill: true, theme: 'dark', disabledHosts: [], llmEnabled: true });

    const settings = await getSettings();
    expect(settings.llmModels).toEqual({});
    expect(settings.llmProvider).toBe(DEFAULT_SETTINGS.llmProvider);
    // Without erasing what was actually stored.
    expect(settings.theme).toBe('dark');
    expect(settings.llmEnabled).toBe(true);
  });

  it('survives a stored key whose value is explicitly undefined', async () => {
    // Spread copies `undefined` straight over a default — presence is not enough.
    await put({ ...DEFAULT_SETTINGS, llmModels: undefined, disabledHosts: undefined });

    const settings = await getSettings();
    expect(settings.llmModels).toEqual({});
    expect(settings.disabledHosts).toEqual([]);
  });

  it('replaces a value of the wrong type rather than passing it on', async () => {
    await put({ ...DEFAULT_SETTINGS, llmModels: 'nonsense', disabledHosts: 'acme.example' });

    const settings = await getSettings();
    expect(settings.llmModels).toEqual({});
    expect(settings.disabledHosts).toEqual([]);
  });

  it('keeps model overrides that are actually there', async () => {
    await put({ ...DEFAULT_SETTINGS, llmModels: { groq: { drafting: 'llama-3.3-70b-versatile' } } });

    expect((await getSettings()).llmModels.groq?.drafting).toBe('llama-3.3-70b-versatile');
  });

  it('never writes a broken value back out to every synced device', async () => {
    await setSettings({ llmModels: undefined } as Partial<Settings>);

    const raw = (await browser.storage.sync.get('settings')).settings as Settings;
    expect(raw.llmModels).toEqual({});
  });
});

describe('repairSettings', () => {
  it('is a pure function of the stored object', () => {
    expect(repairSettings({})).toEqual(DEFAULT_SETTINGS);
  });

  it('guards every field something else indexes into', () => {
    // `disabledHosts.includes()` in the orchestrator and `llmModels[provider]`
    // in the options page are the two unguarded reads; both must be safe.
    const repaired = repairSettings({ disabledHosts: null, llmModels: null } as never);
    expect(() => repaired.disabledHosts.includes('x')).not.toThrow();
    expect(repaired.llmModels.openrouter).toBeUndefined();
  });
});
