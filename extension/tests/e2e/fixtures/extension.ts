import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test as base, chromium, type BrowserContext, type Worker } from '@playwright/test';

/**
 * Loading the built extension into Chromium.
 *
 * Three constraints drive this file, all of them Chrome's rather than ours:
 *  - An unpacked extension needs `--load-extension`, which needs a persistent
 *    context, which means a real profile directory on disk.
 *  - MV3 extensions do not load in headless mode.
 *  - The extension id is not known until the service worker registers, so it is
 *    read back from the worker URL rather than hard-coded.
 */

const BUILD_DIR = resolve(process.cwd(), 'extension/.output/chrome-mv3');

export interface ExtensionFixtures {
  context: BrowserContext;
  extensionId: string;
  /** Ready-to-use options page URL. */
  optionsUrl: string;
}

export const test = base.extend<ExtensionFixtures>({
  // eslint-disable-next-line no-empty-pattern -- Playwright's fixture signature
  context: async ({}, use) => {
    const profileDir = await mkdtemp(join(tmpdir(), 'autofill-e2e-'));
    const context = await chromium.launchPersistentContext(profileDir, {
      headless: false,
      args: [
        `--disable-extensions-except=${BUILD_DIR}`,
        `--load-extension=${BUILD_DIR}`,
        '--no-first-run',
      ],
    });

    await use(context);

    await context.close();
    await rm(profileDir, { recursive: true, force: true });
  },

  extensionId: async ({ context }, use) => {
    const worker: Worker =
      context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
    // chrome-extension://<id>/background.js
    await use(new URL(worker.url()).host);
  },

  optionsUrl: async ({ extensionId }, use) => {
    await use(`chrome-extension://${extensionId}/options.html`);
  },
});

export const expect = test.expect;

/**
 * Ask the content script in `tabId` to fill.
 *
 * The toolbar button is not scriptable from Playwright, so the message is sent
 * from an extension page, which has the privileges to do it. This exercises the
 * same message the button sends — `content:fill` — so the path under test is
 * the real one.
 */
export async function triggerFill(context: BrowserContext, optionsUrl: string): Promise<void> {
  const page = await context.newPage();
  await page.goto(optionsUrl);
  await page.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (typeof tab?.id !== 'number') throw new Error('no active tab to fill');
    await chrome.tabs.sendMessage(tab.id, { kind: 'content:fill', payload: undefined });
  });
  await page.close();
}
