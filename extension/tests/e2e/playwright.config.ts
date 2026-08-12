import { defineConfig } from '@playwright/test';

/**
 * Playwright E2E (ARCHITECTURE.md §10).
 *
 * "Drive the real Greenhouse/Lever demo boards. Assert the DOM after fill, not
 * the intent. Catches framework-revert bugs, which unit tests structurally
 * cannot."
 *
 * These are **not** part of `npm test`. They need three things the unit suite
 * does not: a Chromium download, a headed browser (MV3 extensions do not load
 * in headless mode), and a live job posting to drive.
 *
 *     npx playwright install chromium
 *     npm run build                       # the spec loads .output/chrome-mv3
 *     AUTOFILL_E2E_URL='https://job-boards.greenhouse.io/…' npm run test:e2e
 *
 * Without `AUTOFILL_E2E_URL` the specs skip rather than fail — a suite that
 * goes red because someone took a job posting down teaches nobody anything.
 */
export default defineConfig({
  testDir: './specs',
  // A real application form takes seconds to fill by design (§3.3 pacing).
  timeout: 120_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list']],
  use: {
    // MV3 service workers require a persistent context; see fixtures/extension.ts.
    headless: false,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
});
