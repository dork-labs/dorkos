import { expect, request, test } from '@playwright/test';

/**
 * The release smoke's one browser check (DOR-5123, design §6): the `dorkos`
 * tarball a release is about to publish, installed from npm's own format into
 * a clean prefix, serves the app, and a chat started there gets a reply.
 *
 * The server runs the built-in test runtime (`DORKOS_TEST_RUNTIME=true`) on a
 * throwaway home, so no model is reached and nothing is spent. This spec
 * imports nothing from the e2e package, so the smoke job installs Playwright
 * and nothing else.
 */
// eslint-disable-next-line no-restricted-syntax -- set by the smoke job, not read by the app
const VERSION = process.env.RELEASE_SMOKE_VERSION ?? '';

test.beforeAll(async ({ baseURL }) => {
  const api = await request.newContext({ baseURL });
  try {
    const health = await api.get('/api/health');
    expect(health.ok()).toBe(true);
    expect(((await health.json()) as { version?: string }).version).toBe(VERSION);
    // Settle the first-run moments a fresh install shows, as global-setup.ts does.
    const now = new Date().toISOString();
    const settled = await api.patch('/api/config', {
      data: {
        onboarding: { dismissedAt: now },
        profile: { rolePromptDismissedAt: now, identityPromptDismissedAt: now },
        telemetry: { userHasDecided: true },
        ui: { trustNoticeSeenAt: now },
      },
    });
    expect(settled.ok()).toBe(true);
  } finally {
    await api.dispose();
  }
});

test('a chat on the installed release gets a reply', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('app-shell')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('chat-panel')).toBeVisible({ timeout: 30_000 });

  const input = page.getByRole('combobox', { name: /^(message |send a message)/i });
  const text = `release smoke ${VERSION}`;
  await expect(input).toBeEnabled({ timeout: 30_000 });
  await input.fill(text);
  const send = page.getByRole('button', { name: /send message/i });
  await expect(send).toBeEnabled({ timeout: 30_000 });
  await send.click();

  const sent = page
    .locator('[data-testid="message-item"][data-role="user"]')
    .filter({ hasText: text });
  await expect(sent).toBeVisible({ timeout: 30_000 });
  const reply = sent
    .locator('xpath=following::*[@data-testid="message-item"][@data-role="assistant"]')
    .first();
  await expect(reply).toBeVisible({ timeout: 60_000 });
  await expect(reply).not.toHaveText('');
});
