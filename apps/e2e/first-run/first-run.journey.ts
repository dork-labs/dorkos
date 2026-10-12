import { test, expect, type Page } from '@playwright/test';

/**
 * The one-minute first run (spec `one-minute-onboarding` §8, ADR 261010-143210).
 *
 * The clock runs from the Welcome screen to DorkBot's FIRST REAL reply in
 * #team after a chip is pressed — not the scripted welcome, which costs no
 * model at all. The bar is under 60 seconds.
 *
 * Runs only under `playwright.first-run.config.ts`, each path against its own
 * never-onboarded server with the test-mode Cloud: the approval page approves
 * the code when the tab the app opens loads it, the credits token is a fake,
 * and the model behind it answers with one canned line, posted to the room the
 * way a real model posts. Nothing leaves the machine.
 */

/** The bar, from Welcome to DorkBot's first real reply. */
const ONE_MINUTE_MS = 60_000;

/** What the test-mode model answers every turn with (`fake-inference.ts`). */
const FAKE_MODEL_REPLY = 'Hi! I can build that for you.';

/** What TestModeRuntime posts under its default scenario: the message, echoed. */
const TEST_RUNTIME_REPLY = /^Echo: .*Build me a tracker for my customers/;

/** Names the DorkOS path must never show: no runtime, model or vendor. */
const VENDOR_NAMES = ['Claude', 'Anthropic', 'OpenAI', 'GPT', 'Codex', 'OpenCode', 'Gemini', 'Doe'];

/** Fail with the name and where it showed, if any vendor name is on screen. */
async function expectNoVendorNames(page: Page, where: string) {
  const text = await page.locator('body').innerText();
  for (const name of VENDOR_NAMES) {
    expect(text, `"${name}" is visible on ${where}`).not.toMatch(new RegExp(`\\b${name}\\b`));
  }
}

/** Wait for the Welcome screen and start the clock the moment it can be used. */
async function openWelcome(page: Page): Promise<number> {
  await page.goto('/');
  const button = page.getByRole('button', { name: 'Continue with DorkOS' });
  await expect(button).toBeEnabled({ timeout: 30_000 });
  return Date.now();
}

/** Press the first chip under DorkBot's welcome and wait for the reply it starts. */
async function pressFirstChipAndWaitForReply(page: Page, reply: string | RegExp) {
  const chips = page.getByTestId('first-run-chips');
  await expect(chips).toBeVisible({ timeout: 30_000 });
  await chips.getByRole('button', { name: 'Build me a tracker for my customers' }).click();
  await expect(page.getByText(reply).first()).toBeVisible({ timeout: 45_000 });
}

test('Continue with DorkOS reaches a real DorkBot reply in under a minute', async ({
  page,
  context,
}) => {
  const started = await openWelcome(page);
  await expectNoVendorNames(page, 'Welcome');

  // The app opens the approval page in a new tab, in the click itself. Loading
  // it is what approves the code in the test-mode Cloud.
  const popup = context.waitForEvent('page');
  await page.getByRole('button', { name: 'Continue with DorkOS' }).click();
  const approval = await popup;
  await approval.waitForURL(/\/api\/test\/fake-cloud\/approve\?code=/, { timeout: 15_000 });
  await approval.close();

  await expect(page.getByTestId('onboarding-connecting')).toBeVisible();
  await expectNoVendorNames(page, 'Connecting');

  // No click: the screen moves on once credits report ready.
  await expect(page.getByTestId('first-run-chips')).toBeVisible({ timeout: 30_000 });
  await expectNoVendorNames(page, '#team');

  await pressFirstChipAndWaitForReply(page, FAKE_MODEL_REPLY);
  const elapsed = Date.now() - started;
  console.log(`[first-run] DorkOS path: ${elapsed} ms from Welcome to DorkBot's first reply`);
  expect(elapsed).toBeLessThan(ONE_MINUTE_MS);
  await expectNoVendorNames(page, '#team after the reply');
});

test('Use my own AI (an AI app you sign in to) reaches a real DorkBot reply in under a minute', async ({
  page,
}) => {
  const started = await openWelcome(page);
  await page.getByRole('button', { name: 'Use my own AI' }).click();
  await expect(page.getByTestId('onboarding-own-ai')).toBeVisible();

  // The test-mode DorkOS runtime runs only on credits, so a key or a local
  // model would be refused before a turn; the AI-app row is the own-AI path a
  // test-mode server can answer for free (a claude-code-typed TestModeRuntime).
  await page.getByRole('button', { name: /An AI app you sign in to/ }).click();
  await page.getByTestId('onboarding-ai-app-continue').click({ timeout: 30_000 });

  await pressFirstChipAndWaitForReply(page, TEST_RUNTIME_REPLY);
  const elapsed = Date.now() - started;
  console.log(`[first-run] Own AI path: ${elapsed} ms from Welcome to DorkBot's first reply`);
  expect(elapsed).toBeLessThan(ONE_MINUTE_MS);
});
