import { execFile } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { Page, Route } from '@playwright/test';
import { test, expect } from '../../fixtures';

/**
 * Choosing DorkOS credits in Runs on, in a real browser (ADR 261001-000811).
 *
 * Credits are one more entry in the lists a person already picks a Claude
 * account from: the account chip before a chat's first message, and the
 * default under Settings → Runtimes → Runs on.
 *
 * **Nothing here can spend.** The cloud is mocked at the browser: `GET
 * /api/config` is answered with the server's own config plus a credits entry
 * that says credits can be chosen, and the write that would record credits as
 * the default is answered in the browser, so it never reaches the server. No
 * message is ever sent; a route refuses any send outright, so a mistake fails
 * the test rather than starting a turn. No money-path flag reaches this run.
 */
test.describe.configure({ mode: 'serial' });

const run = promisify(execFile);

const CREDITS = {
  id: 'dorkos-credits',
  path: '/e2e/never-launched/runtimes/claude-code/credits',
  available: true,
  isDefault: false,
};

/** Answer `GET /api/config` with the server's own config plus a choosable credits entry. */
async function offerCredits(page: Page): Promise<void> {
  await page.route(/\/api\/config(\?|$)/, async (route: Route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    const response = await route.fetch();
    const body = (await response.json()) as { claudeCode?: Record<string, unknown> };
    body.claudeCode = {
      resolvedAccount: '/e2e/never-launched/.claude',
      inherited: true,
      accounts: [],
      ...body.claudeCode,
      credits: CREDITS,
    };
    await route.fulfill({ response, json: body });
  });
}

/** Refuse every message send, so nothing in this file can ever start a turn. */
async function refuseSends(page: Page): Promise<string[]> {
  const attempted: string[] = [];
  await page.route(/\/api\/sessions\/[^/]+\/messages(\?|$)/, async (route: Route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    attempted.push(route.request().url());
    await route.abort();
  });
  return attempted;
}

test.describe('DorkOS credits in Runs on @smoke', () => {
  // The routes above read the server's own answer before rewriting it; one
  // still in flight when a test ends must not fail the run after it passed.
  test.afterEach(async ({ page }) => {
    await page.unrouteAll({ behavior: 'ignoreErrors' });
  });

  test('the account chip offers DorkOS credits for this chat, and holds the pick', async ({
    page,
    basePage,
    roomsApi,
  }) => {
    test.setTimeout(120_000);
    const repo = join(roomsApi.agentRoot, `credits-repo-${roomsApi.runId}`);
    await mkdir(repo, { recursive: true });
    await run('git', ['init', '-q'], { cwd: repo });
    await offerCredits(page);
    const attempted = await refuseSends(page);

    await page.goto(`/session?dir=${encodeURIComponent(repo)}`);
    await basePage.waitForAppReady();

    // Before launch the chip IS the picker (see account-eligibility.spec.ts).
    const chip = page
      .getByRole('toolbar', { name: 'Session status' })
      .locator('button[data-state-tone]');
    await expect(chip).toBeVisible({ timeout: 30_000 });
    await expect(chip).toHaveAttribute('aria-haspopup', 'menu');
    await chip.click();

    const menu = page.getByRole('menu');
    const credits = menu.getByRole('menuitemradio', { name: /DorkOS credits/ });
    await expect(credits).toBeVisible();
    await credits.click();

    // The pick is held for this chat: the chip now names it.
    await expect(chip).toContainText('DorkOS credits');
    expect(attempted).toEqual([]);
  });

  test('Settings → Runtimes → Runs on records DorkOS credits as the default, chosen by you', async ({
    page,
    basePage,
    settingsPage,
  }) => {
    test.setTimeout(120_000);
    await offerCredits(page);
    await refuseSends(page);
    // The Claude Code card draws Runs on only for a ready runtime; a runner
    // with no Claude sign-in is told it is ready, since no turn is ever run.
    await page.route(/\/api\/system\/requirements(\?|$)/, async (route: Route) => {
      const response = await route.fetch();
      const body = (await response.json()) as { runtimes: Record<string, unknown> };
      body.runtimes['claude-code'] = {
        ...(body.runtimes['claude-code'] as object),
        state: 'ready',
        connect: undefined,
      };
      await route.fulfill({ response, json: body });
    });
    const chosen: unknown[] = [];
    await page.route(/\/api\/cloud\/credits\/default(\?|$)/, async (route: Route) => {
      chosen.push(route.request().postDataJSON());
      await route.fulfill({
        json: {
          enabled: true,
          killed: false,
          linked: true,
          ready: true,
          runtimes: { 'claude-code': 'wired', codex: 'follow-up', opencode: 'follow-up' },
          defaults: { 'claude-code': { chosenBy: 'user' } },
          notices: [],
        },
      });
    });

    await page.goto('/?settings=runtimes');
    await basePage.waitForAppReady();
    const card = settingsPage.runtimeCard('claude-code');
    await expect(card).toBeVisible({ timeout: 30_000 });
    const body = settingsPage.runtimeCardBody('claude-code');
    if (!(await body.isVisible())) await settingsPage.runtimeCardToggle('claude-code').click();
    await expect(body).toBeVisible();

    const section = body.getByTestId('claude-accounts-section');
    await expect(section.getByRole('heading', { name: 'Runs on' })).toBeVisible();
    await section.getByRole('combobox', { name: 'Default account' }).click();
    await page.getByRole('option', { name: 'DorkOS credits' }).click();

    await expect.poll(() => chosen).toEqual([{ runtime: 'claude-code', useCredits: true }]);
  });
});
