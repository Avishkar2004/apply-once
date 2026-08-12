import { expect, test, triggerFill } from '../fixtures/extension';

/**
 * The end-to-end fill (ARCHITECTURE.md §10).
 *
 * "Assert the DOM after fill, not the intent. Catches framework-revert bugs,
 * which unit tests structurally cannot."
 *
 * That last sentence is the whole reason this file exists. The fixture suite in
 * `../mapping.test.ts` proves the *mapping* is right; only a real browser
 * driving a real React form can prove the value is still in the input a second
 * after we wrote it.
 */

const BOARD_URL = process.env.AUTOFILL_E2E_URL;
const PASSPHRASE = 'e2e-passphrase-not-a-real-secret';

const PROFILE = {
  firstName: 'Ada',
  lastName: 'Lovelace',
  email: 'ada@example.com',
  phone: '5550134000',
};

test.skip(!BOARD_URL, 'Set AUTOFILL_E2E_URL to a live application form to run this suite.');

test.describe('filling a real application form', () => {
  test.beforeEach(async ({ context, optionsUrl }) => {
    const options = await context.newPage();
    await options.goto(optionsUrl);

    // First run: create the vault and acknowledge the Recovery Kit (WEB.md §3.3
    // makes that acknowledgement mandatory, so the E2E has to do it too).
    await options.getByLabel('Passphrase', { exact: true }).fill(PASSPHRASE);
    await options.getByLabel('Confirm passphrase').fill(PASSPHRASE);
    await options.getByRole('button', { name: 'Create vault' }).click();
    await options.getByRole('checkbox').check();
    await options.getByRole('button', { name: 'Continue' }).click();

    await options.getByLabel('First name').fill(PROFILE.firstName);
    await options.getByLabel('Last name').fill(PROFILE.lastName);
    await options.getByLabel('Email').fill(PROFILE.email);
    await options.getByLabel('Phone', { exact: true }).fill(PROFILE.phone);
    await options.getByRole('button', { name: 'Save profile' }).click();
    await expect(options.getByText('Profile saved.')).toBeVisible();

    await options.close();
  });

  test('writes values that survive the framework', async ({ context, optionsUrl }) => {
    const page = await context.newPage();
    await page.goto(BOARD_URL!, { waitUntil: 'domcontentloaded' });
    await page.bringToFront();

    await triggerFill(context, optionsUrl);

    // The executor paces itself at 30–80ms per field (§3.3); a 40-field form is
    // 2–4 seconds. Give it room, then assert on the DOM.
    const firstName = page.locator(
      'input[name="first_name"], input#first_name, input[autocomplete="given-name"]',
    );
    await expect(firstName.first()).toHaveValue(PROFILE.firstName, { timeout: 30_000 });

    // The bug this suite exists to catch: React reverting a programmatic write
    // on its next render. Re-assert after the page has had time to re-render.
    await page.waitForTimeout(2000);
    await expect(firstName.first()).toHaveValue(PROFILE.firstName);

    const email = page.locator('input[type="email"], input[name="email"]');
    await expect(email.first()).toHaveValue(PROFILE.email);
  });

  test('never submits the application', async ({ context, optionsUrl }) => {
    const page = await context.newPage();
    await page.goto(BOARD_URL!, { waitUntil: 'domcontentloaded' });
    await page.bringToFront();

    const urlBefore = page.url();
    let navigated = false;
    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame() && page.url() !== urlBefore) navigated = true;
    });

    await triggerFill(context, optionsUrl);
    await page.waitForTimeout(8000);

    // §6.7 is architectural. If a fill ever navigates, something clicked submit.
    expect(navigated).toBe(false);
    expect(page.url()).toBe(urlBefore);
  });
});
