import type { BrowserContext, Page, Route } from '@playwright/test';
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
async function noClaudeSignIn(page: Page | BrowserContext): Promise<void> {
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
async function refuseSends(page: Page | BrowserContext): Promise<void> {
  await page.route(/\/api\/sessions\/[^/]+\/messages(\?|$)/, async (route: Route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    await route.abort();
  });
}

/**
 * One fake DorkOS link server for every tab in a browser context: it waits on
 * one code at a time, a new start replaces the last one, and it records which
 * page made each credits choice. Nothing reaches the real cloud.
 */
async function fakeLinkServer(context: BrowserContext) {
  // One server for both tabs: it waits on one code at a time, and a new
  // start replaces the last one, as the real one does.
  const codes = ['CODE1111', 'CODE2222'];
  let state: 'idle' | 'pending' | 'linked' = 'idle';
  let waitingOn: string | null = null;
  let approved: string | null = null;
  const choicesFrom: Page[] = [];
  const codeFor = (userCode: string) => ({
    userCode,
    verificationUri: 'https://dorkos.ai/activate',
    expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
  });
  await context.route(/\/api\/cloud\/credits(\?|$)/, (route: Route) =>
    route.fulfill({
      json: {
        enabled: state === 'linked',
        killed: false,
        linked: state === 'linked',
        ready: state === 'linked',
        runtimes: { 'claude-code': 'wired', codex: 'follow-up', opencode: 'follow-up' },
        defaults: {},
        notices: [],
      },
    })
  );
  await context.route(/\/api\/cloud\/credits\/default(\?|$)/, (route: Route) => {
    choicesFrom.push(route.request().frame().page());
    return route.fulfill({
      json: {
        enabled: true,
        killed: false,
        linked: true,
        ready: true,
        runtimes: { 'claude-code': 'wired', codex: 'follow-up', opencode: 'follow-up' },
        defaults: { 'claude-code': { runsOn: 'credits', chosenBy: 'user' } },
        notices: [],
      },
    });
  });
  await context.route(/\/api\/cloud\/status(\?|$)/, (route: Route) =>
    route.fulfill({
      json: {
        linked: state === 'linked',
        accountLabel: state === 'linked' ? 'kai@dork.dev' : null,
        lastHeartbeatAt: null,
      },
    })
  );
  await context.route(/\/api\/cloud\/plan(\?|$)/, (route: Route) =>
    route.fulfill({ json: { available: false } })
  );
  await context.route(/\/api\/cloud\/link\/start(\?|$)/, (route: Route) => {
    waitingOn = codes.shift() ?? 'CODE9999';
    state = 'pending';
    return route.fulfill({ json: codeFor(waitingOn) });
  });
  // Tab B stops the code it was shown and starts its own. The server is told
  // to stop, answers idle, and starts waiting on the next code at once.
  await context.route(/\/api\/cloud\/link\/cancel(\?|$)/, (route: Route) => {
    waitingOn = null;
    return route.fulfill({ json: { state: 'idle' } });
  });
  await context.route(/\/api\/cloud\/link\/status(\?|$)/, (route: Route) =>
    route.fulfill({
      json:
        state === 'pending' && waitingOn
          ? { state, pending: codeFor(waitingOn) }
          : state === 'pending'
            ? { state }
            : state === 'linked'
              ? { state, accountLabel: 'kai@dork.dev', approvedCode: approved }
              : { state },
    })
  );
  return {
    choicesFrom,
    approve(userCode: string) {
      approved = userCode;
      state = 'linked';
    },
  };
}

/**
 * Bring a tab back to the front the way a person returning to it does: the
 * page is shown, and it hears the `visibilitychange` that comes with that.
 * Firing the event here is what makes the step deterministic on a loaded
 * runner, where a background page's own visibility change may never arrive.
 */
async function showTab(tab: Page): Promise<void> {
  await tab.bringToFront();
  await tab.evaluate(() => window.dispatchEvent(new Event('visibilitychange')));
}

/** The next link-status answer `tab` reads that matches `match`. */
function statusReply(tab: Page, match: (body: Record<string, unknown> | null) => boolean) {
  return tab.waitForResponse(
    async (response) =>
      /\/api\/cloud\/link\/status(\?|$)/.test(response.url()) &&
      match(await response.json().catch(() => null)),
    { timeout: 30_000 }
  );
}

/** The next link-status answer `tab` reads that names `userCode` as waiting. */
function statusNaming(tab: Page, userCode: string) {
  return statusReply(
    tab,
    (body) => (body?.pending as { userCode?: string } | undefined)?.userCode === userCode
  );
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

  test('two tabs: approving the code one tab started never carries the other tab on', async ({
    page,
    basePage,
  }) => {
    test.setTimeout(150_000);
    const context = page.context();
    await noClaudeSignIn(context);
    await refuseSends(context);

    const server = await fakeLinkServer(context);

    const tabA = page;
    await tabA.goto('/?settings=runtimes');
    await basePage.waitForAppReady();
    const offerIn = (tab: Page) =>
      tab
        .getByTestId('default-first-claude-code')
        .getByRole('button', { name: 'Use DorkOS credits' });
    // Tab A starts the first code.
    await offerIn(tabA).click();
    await expect(tabA.getByText('CODE1111')).toBeVisible();

    // Tab B opens Settings while that code waits. Opening reads the link state
    // at once, so it shows the same code rather than offering a second start.
    // Driven by that read, not by a poll interval, so a loaded runner waits
    // for the answer instead of a clock.
    const tabB = await context.newPage();
    const tabBRead = statusNaming(tabB, 'CODE1111');
    await tabB.goto('/?settings=runtimes');
    await tabB.waitForSelector('[data-testid="app-shell"]', { timeout: 30_000 });
    await tabBRead;
    // Soft, so a tab that cannot show the shared code still goes on to show
    // the failure this test exists for: carrying on for a code it did not start.
    const shared = tabB.getByText('CODE1111');
    await expect.soft(shared).toBeVisible();
    if (await shared.isVisible()) {
      await tabB
        .getByTestId('default-first-claude-code')
        .getByRole('button', { name: 'Cancel' })
        .click();
    }

    // Tab B starts its own code, which replaces the first on the server.
    const tabARead = statusNaming(tabA, 'CODE2222');
    await offerIn(tabB).click();
    await expect(tabB.getByText('CODE2222')).toBeVisible();
    // Tab A, still waiting on its code, reads the server's answer and follows
    // it to the one code it waits on.
    await tabARead;
    await expect.soft(tabA.getByText('CODE2222')).toBeVisible();

    // The code tab B started is approved.
    server.approve('CODE2222');
    await expect.poll(() => server.choicesFrom.length, { timeout: 15_000 }).toBe(1);
    // Tab A must read that the computer is linked too, and still not act: it
    // is shown again (so it reads at once), its own reply says linked, and
    // only then is the record checked, after a moment for anything it would
    // (wrongly) do on that reply.
    const tabALinked = statusReply(tabA, (body) => body?.state === 'linked');
    await showTab(tabA);
    await tabALinked;
    await tabA.waitForTimeout(500);
    expect(server.choicesFrom).toEqual([tabB]);
    await tabB.close();
  });

  test('a tab already open shows the code another tab started once it is shown again', async ({
    page,
    basePage,
  }) => {
    test.setTimeout(150_000);
    const context = page.context();
    await noClaudeSignIn(context);
    await refuseSends(context);
    await fakeLinkServer(context);

    // Both tabs are open and idle before any code exists.
    const tabA = page;
    await tabA.goto('/?settings=runtimes');
    await basePage.waitForAppReady();
    const tabB = await context.newPage();
    await tabB.goto('/?settings=runtimes');
    await tabB.waitForSelector('[data-testid="app-shell"]', { timeout: 30_000 });
    const offerIn = (tab: Page) =>
      tab
        .getByTestId('default-first-claude-code')
        .getByRole('button', { name: 'Use DorkOS credits' });
    await expect(offerIn(tabB)).toBeVisible();

    // Tab A starts a code while tab B sits in the background.
    await showTab(tabA);
    await offerIn(tabA).click();
    await expect(tabA.getByText('CODE1111')).toBeVisible();

    // The person goes back to tab B: it reads the link state at once, even
    // though it read it moments ago, and shows that code, not a second start.
    const tabBRead = statusNaming(tabB, 'CODE1111');
    await showTab(tabB);
    await tabBRead;
    await expect(tabB.getByText('CODE1111')).toBeVisible();
    await expect(offerIn(tabB)).toBeHidden();
    await tabB.close();
  });
});
