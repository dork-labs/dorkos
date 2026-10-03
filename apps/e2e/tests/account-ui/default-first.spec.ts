import type { Page, Route } from '@playwright/test';
import { test, expect } from '../../fixtures';

/**
 * DorkOS credits offered first where nothing works yet, in a real browser
 * (spec `dorkos-account-by-default` §3, DOR-2630).
 *
 * Claude Code is told it has no sign-in at all, and the server is told credits
 * are wired for it on a computer that is not linked. Its connect step in
 * Settings → Runtimes then leads with "Use DorkOS credits", with the runtime's
 * own sign-in and a key as visible rows under it and the privacy line beside
 * them. Choosing credits starts the ONE link flow in place, and Settings ›
 * DorkOS account shows the same code.
 *
 * **Nothing here can spend or reach the cloud.** Every cloud answer is given in
 * the browser — the link start, the flow state, the credits report — so no
 * request leaves this machine, and a route refuses any message send outright.
 * No money-path flag reaches this run.
 */
test.describe.configure({ mode: 'serial' });

const CODE = 'WXYZ7890';

/** Tell the browser Claude Code is installed but has no sign-in at all. */
async function noClaudeSignIn(page: Page): Promise<void> {
  await page.route(/\/api\/system\/requirements(\?|$)/, async (route: Route) => {
    const response = await route.fetch();
    const body = (await response.json()) as { runtimes: Record<string, unknown> };
    body.runtimes['claude-code'] = {
      state: 'connect',
      connect: { kind: 'login', label: 'Connect Claude Code' },
      dependencies: [
        { name: 'Claude Code CLI', description: 'Powers agent sessions.', status: 'satisfied' },
        { name: 'Claude Code authentication', description: 'Sign-in.', status: 'missing' },
      ],
    };
    await route.fulfill({ response, json: body });
  });
}

/**
 * Answer every cloud read and the link flow in the browser: not linked,
 * credits wired for Claude Code, and a link that waits once started.
 */
async function fakeCloud(page: Page): Promise<{ starts: number }> {
  const seen = { starts: 0 };
  let state: 'idle' | 'pending' = 'idle';
  await page.route(/\/api\/cloud\/credits(\?|$)/, (route: Route) =>
    route.fulfill({
      json: {
        enabled: false,
        killed: false,
        linked: false,
        ready: false,
        runtimes: { 'claude-code': 'wired', codex: 'follow-up', opencode: 'follow-up' },
        defaults: {},
        notices: [],
      },
    })
  );
  await page.route(/\/api\/cloud\/status(\?|$)/, (route: Route) =>
    route.fulfill({ json: { linked: false, accountLabel: null, lastHeartbeatAt: null } })
  );
  await page.route(/\/api\/cloud\/link\/start(\?|$)/, (route: Route) => {
    seen.starts += 1;
    state = 'pending';
    return route.fulfill({
      json: {
        userCode: CODE,
        verificationUri: 'https://dorkos.ai/activate',
        expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
      },
    });
  });
  await page.route(/\/api\/cloud\/link\/status(\?|$)/, (route: Route) =>
    route.fulfill({ json: { state } })
  );
  await page.route(/\/api\/cloud\/link\/cancel(\?|$)/, (route: Route) => {
    state = 'idle';
    return route.fulfill({ json: { state } });
  });
  return seen;
}

/** Refuse every message send, so nothing in this file can ever start a turn. */
async function refuseSends(page: Page): Promise<void> {
  await page.route(/\/api\/sessions\/[^/]+\/messages(\?|$)/, async (route: Route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    await route.abort();
  });
}

test.describe('DorkOS credits first where nothing works yet @smoke', () => {
  test.afterEach(async ({ page }) => {
    await page.unrouteAll({ behavior: 'ignoreErrors' });
  });

  test('the connect step leads with credits, other ways under it, and links in place', async ({
    page,
    basePage,
    settingsPage,
  }) => {
    test.setTimeout(120_000);
    await noClaudeSignIn(page);
    const cloud = await fakeCloud(page);
    await refuseSends(page);

    await page.goto('/?settings=runtimes');
    await basePage.waitForAppReady();
    const card = settingsPage.runtimeCard('claude-code');
    await expect(card).toBeVisible({ timeout: 30_000 });
    const body = settingsPage.runtimeCardBody('claude-code');
    if (!(await body.isVisible())) await settingsPage.runtimeCardToggle('claude-code').click();

    const step = page.getByTestId('default-first-claude-code');
    const offer = step.getByRole('button', { name: 'Use DorkOS credits' });
    const signIn = step.getByRole('button', { name: 'Sign in with Claude' });
    const key = step.getByRole('button', { name: 'Paste a key' });
    await expect(offer).toBeVisible();
    await expect(signIn).toBeVisible();
    await expect(key).toBeVisible();
    await expect(step.getByText('One account for Claude Code.')).toBeVisible();
    await expect(
      step.getByText('Prefer to keep everything on this computer? Use your own sign-in.')
    ).toBeVisible();
    // DorkOS first, then the runtime's own sign-in, then a key.
    const [o, s, k] = await Promise.all([offer, signIn, key].map((b) => b.boundingBox()));
    expect(o!.y).toBeLessThan(s!.y);
    expect(s!.y).toBeLessThan(k!.y);

    // Signed out: choosing credits starts the link right here.
    await offer.click();
    await expect(step.getByText(CODE)).toBeVisible();
    expect(cloud.starts).toBe(1);

    // The same code, not a second one, in Settings › DorkOS account.
    await settingsPage.switchTab('DorkOS account');
    await expect(settingsPage.activePanel.getByText(CODE)).toBeVisible();
    expect(cloud.starts).toBe(1);

    // Stop waiting, so nothing is left pending behind the run.
    await settingsPage.activePanel.getByRole('button', { name: 'Cancel' }).click();
  });

  test('on a phone-width screen the offer and every other way fit without sideways scroll', async ({
    page,
    basePage,
    settingsPage,
  }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: 320, height: 700 });
    await noClaudeSignIn(page);
    await fakeCloud(page);
    await refuseSends(page);

    await page.goto('/?settings=runtimes');
    await basePage.waitForAppReady();
    // On a phone, Settings opens on its list of sections.
    const runtimes = settingsPage.dialog.getByRole('button', { name: /^Runtimes/ });
    if (await runtimes.isVisible()) await runtimes.click();
    // A runtime that is not connected opens with its connect step showing.
    const step = page.getByTestId('default-first-claude-code');
    await expect(step).toBeVisible({ timeout: 30_000 });
    for (const name of ['Use DorkOS credits', 'Sign in with Claude', 'Paste a key']) {
      const button = step.getByRole('button', { name });
      await button.scrollIntoViewIfNeeded();
      await expect(button).toBeInViewport();
      const box = await button.boundingBox();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(320);
    }
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth
    );
    expect(overflow).toBeLessThanOrEqual(0);
  });
});
