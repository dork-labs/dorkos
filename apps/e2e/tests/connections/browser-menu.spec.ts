import type { Page, Route } from '@playwright/test';
import { test, expect } from '../../fixtures';
import { LocalBrowserPage } from '../../pages/LocalBrowserPage';

/**
 * The Agent browser's ⋯ menu in the real app (DOR-4429). Only the browser's own
 * state and answers are intercepted, with made-up pages: a live browser is
 * covered by the desktop smoke and the installed proof.
 */

function sharedWith(sessionId: string) {
  return {
    connectionId: 'c1',
    sessionId,
    mode: 'new-window',
    status: 'connected',
    paused: false,
    tabs: [
      { id: 't1', url: 'https://northwind.example/fares?to=LIS', title: 'Fares to Lisbon' },
      { id: 't2', url: 'https://accounts.northwind.example/signin', title: 'Sign in' },
    ],
    selectedTabId: 't1',
    revision: 1,
    preparation: null,
    signIn: null,
    handoff: null,
  };
}

/** Open a chat with one finished turn whose browser is shared with it, then its panel. */
async function chatWithBrowser(
  page: Page,
  chatPage: { goto: (id?: string, opts?: { dir: string }) => Promise<void> } & {
    sendMessage: (text: string) => Promise<void>;
  }
) {
  const seed = await page.request.post('/api/test/seed-agent');
  expect(seed.ok()).toBe(true);
  const { agentDir } = (await seed.json()) as { agentDir: string };
  await page.request.patch('/api/config', {
    data: { onboarding: { dismissedAt: new Date().toISOString() } },
  });
  await chatPage.goto(undefined, { dir: agentDir });
  await chatPage.sendMessage('Find the cheapest fare to Lisbon.');
  await expect(page.getByTestId('transcript-feed').getByText(/Echo:/).first()).toBeVisible();
  const sessionId = new URL(page.url()).searchParams.get('session')!;
  const answers: string[] = [];
  const shared = sharedWith(sessionId);
  let state: Record<string, unknown> = shared;
  await page.route('**/api/local-browser/**', async (route: Route) => {
    const url = new URL(route.request().url()).pathname;
    if (url.endsWith('/capabilities') || url.endsWith('/profiles')) return route.fallback();
    if (route.request().method() === 'POST') {
      answers.push(url);
      if (url.endsWith('/disconnect'))
        state = { ...shared, status: 'disconnected', connectionId: null, tabs: [] };
    }
    return route.fulfill({ json: state });
  });
  await page.reload();
  const browser = new LocalBrowserPage(page);
  await browser.open();
  return { browser, answers };
}

test.describe('Agent browser ⋯ menu', () => {
  // Every test uses the seeded agent's one chat, so they take turns.
  test.describe.configure({ mode: 'default', timeout: 60_000 });

  test('holds the page actions, and nothing above the page repeats them', async ({
    page,
    chatPage,
  }) => {
    const { browser, answers } = await chatWithBrowser(page, chatPage);
    await expect(browser.controls.getByRole('combobox')).toHaveCount(0);
    await expect(browser.controls.getByRole('button', { name: 'Disconnect' })).toHaveCount(0);
    await expect(browser.controls.getByLabel('Saved sign-ins')).toHaveCount(0);
    await browser.controls.getByRole('button', { name: 'Browser menu', exact: true }).click();
    const menu = page.getByRole('menu');
    await expect(menu.getByRole('menuitemradio')).toHaveText(['Fares to Lisbon', 'Sign in']);
    await expect(menu.getByRole('menuitemradio', { name: 'Fares to Lisbon' })).toBeChecked();
    for (const name of [
      'Copy address',
      'Open in your browser',
      'Forget saved sign-ins…',
      'Close browser',
    ])
      await expect(menu.getByRole('menuitem', { name, exact: true })).toBeVisible();
    // The menu sits at the row's end, inside the window.
    const box = (await menu.boundingBox())!;
    expect(box.x + box.width).toBeLessThanOrEqual(page.viewportSize()!.width);

    await menu.getByRole('menuitem', { name: 'Close browser', exact: true }).click();
    await expect(
      browser.controls.getByRole('button', { name: /Reconnect|Open browser/ })
    ).toBeVisible();
    expect(answers).toContain('/api/local-browser/disconnect');
  });

  test('Forget saved sign-ins… opens the confirm dialog', async ({ page, chatPage }) => {
    const { browser } = await chatWithBrowser(page, chatPage);
    await browser.controls.getByRole('button', { name: 'Browser menu', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Forget saved sign-ins…', exact: true }).click();
    const dialog = page.getByRole('alertdialog', { name: 'Forget saved sign-ins?' });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toHaveCount(0);
    await expect(
      browser.controls.getByRole('button', { name: 'Browser menu', exact: true })
    ).toBeFocused();
  });

  test('at 390 it opens as a bottom sheet with Forward in it', async ({ page, chatPage }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const { browser } = await chatWithBrowser(page, chatPage);
    await browser.controls.getByRole('button', { name: 'Browser menu', exact: true }).click();
    const sheet = page.locator('[data-slot="drawer-content"]').last();
    await expect(sheet).toBeVisible();
    for (const name of ['Forward', 'Copy address', 'Close browser'])
      await expect(sheet.getByRole('button', { name, exact: true })).toBeInViewport();
    // Page history isn't built yet, so Forward waits, disabled (DOR-4449).
    await expect(sheet.getByRole('button', { name: 'Forward', exact: true })).toBeDisabled();
    const box = (await sheet.boundingBox())!;
    // Anchored to the bottom edge (the drawer runs past it, under the home bar).
    expect(box.y + box.height).toBeGreaterThanOrEqual(844);
    expect(box.y).toBeGreaterThan(844 / 3);
  });
});
