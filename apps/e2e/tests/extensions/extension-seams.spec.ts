import { test, expect, type APIRequestContext } from '@playwright/test';
import { BasePage } from '../../pages/BasePage.js';
import { ChatPage } from '../../pages/ChatPage.js';
import { RightPanelPage } from '../../pages/RightPanelPage.js';
import { openFromCommandPalette } from '../../pages/command-palette.js';
import { PHONE } from '../rooms/room-sheet-helpers.js';

/**
 * The extension seams, seen in a real browser (spec `flow-multiproject` §12,
 * phase 2): an extension's page, its status-bar item and its tab dot.
 *
 * **Two halves, one file.** The first half drives the `hello-world` core
 * extension, which is the worked example of the client seams (DOR-2525). The
 * second half — a raised decision under its project heading, answered with 👍
 * — belongs to the inbox fixture extension and lands with DOR-2523 as a second
 * `describe` below; nothing in the first half assumes it is alone.
 *
 * Runs in the `chromium-extension-seams` project against the test-mode leg, so
 * the chat it opens can never start a billable turn. `hello-world` ships turned
 * off; the suite turns it on for its own tests and back off afterwards, because
 * the server is shared with every other test-mode project and a page, a status
 * item and a right-panel tab nobody asked for must not outlive this file.
 */

// eslint-disable-next-line no-restricted-syntax -- E2E test config; no env.ts available
const MOCK_PORT = process.env.DORKOS_MOCK_PORT || '4243';
const API_URL = `http://localhost:${MOCK_PORT}`;

/** The id the core extension ships under. */
const HELLO = 'hello-world';

/** Turn a core extension on or off through the same route Settings uses. */
async function setEnabled(request: APIRequestContext, id: string, enabled: boolean) {
  const response = await request.post(
    `${API_URL}/api/extensions/${id}/${enabled ? 'enable' : 'disable'}`
  );
  expect(response.ok(), `${enabled ? 'enable' : 'disable'} ${id}: ${await response.text()}`).toBe(
    true
  );
}

test.describe('Extension seams — hello-world’s page, status item and tab dot', () => {
  // One enable/disable around the whole half: the tests share the extension.
  test.describe.configure({ mode: 'serial' });

  test.beforeAll(async ({ request }) => {
    await setEnabled(request, HELLO, true);
  });

  test.afterAll(async ({ request }) => {
    await setEnabled(request, HELLO, false);
  });

  test('opens its page from the command palette, and a reload lands back on it', async ({
    page,
  }) => {
    await page.goto('/');
    await new BasePage(page).waitForAppReady();

    await openFromCommandPalette(page, 'Hello');
    await expect(page).toHaveURL(/\/x\/hello-world$/);
    await expect(page.getByRole('heading', { name: 'Hello, there' })).toBeVisible();

    // Something bookmarkable in the page's own query survives the reload too.
    await page.getByLabel('Your name').fill('Kai');
    await expect(page).toHaveURL(/\/x\/hello-world\?name=Kai$/);

    // Reload: the address arrives before the extension has loaded, so the
    // route must draw a skeleton — never "not available" — and then the page.
    // Both are transient, so a recorder installed before the app boots watches
    // every frame of the load instead of hoping a locator looks at the right
    // moment.
    await page.addInitScript(() => {
      const seen = { skeleton: false, unavailable: false, said: '' };
      (window as Window & { __pageLoadSeen?: typeof seen }).__pageLoadSeen = seen;
      new MutationObserver(() => {
        if (document.querySelector('[data-testid="extension-page-skeleton"]')) seen.skeleton = true;
        if (document.body?.textContent?.includes("This page isn't available")) {
          seen.unavailable = true;
          // What it said, so a failure names which empty state flashed.
          seen.said ||= document.querySelector('[data-slot="empty-state"]')?.textContent ?? '';
        }
      }).observe(document, { childList: true, subtree: true, characterData: true });
    });
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Hello, Kai' })).toBeVisible();
    const seen = (await page.evaluate(
      () =>
        (
          window as Window & {
            __pageLoadSeen?: { skeleton: boolean; unavailable: boolean; said: string };
          }
        ).__pageLoadSeen
    ))!;
    expect(seen.skeleton, 'the reload drew the loading skeleton first').toBe(true);
    expect(seen.said, 'the reload never said the page was unavailable').toBe('');
    expect(seen.unavailable).toBe(false);
    await expect(page.getByTestId('extension-page-skeleton')).toHaveCount(0);
  });

  test('shows its item in a chat’s status bar', async ({ page }) => {
    const chat = new ChatPage(page);
    await chat.goto();
    // The item shows only for a chat with a folder, and a chat has one once it
    // has started. On this leg the reply is scripted, so nothing is billed.
    // Unique per run: a retry reopens the same chat, and the send is matched by text.
    await chat.sendAndLand(`Say hello to the status bar (${Date.now()})`);

    const statusLine = page.getByTestId('status-line');
    const item = statusLine.getByRole('group', { name: 'Hello World' });
    await expect(item).toBeVisible();
    await expect(item).toHaveText(/^Hello/);
  });

  test('marks its right-panel tab with a dot, and clears it', async ({ page }) => {
    const chat = new ChatPage(page);
    await chat.goto();
    const panel = new RightPanelPage(page);
    await panel.ensureTabStripOpen();
    await expect(panel.header.getByRole('tab', { name: 'Hello', exact: true })).toBeVisible();

    await openFromCommandPalette(page, 'Hello World: Toggle Tab Dot');
    const marked = panel.header.getByRole('tab', { name: 'Hello, something needs you' });
    await expect(marked).toBeVisible();
    await expect(marked.locator('[data-slot="right-panel-tab-marker"]')).toBeVisible();

    await openFromCommandPalette(page, 'Hello World: Toggle Tab Dot');
    await expect(panel.header.getByRole('tab', { name: 'Hello', exact: true })).toBeVisible();
    await expect(panel.header.locator('[data-slot="right-panel-tab-marker"]')).toHaveCount(0);
  });

  test.describe('on a phone', () => {
    test.use({ viewport: PHONE, hasTouch: true, isMobile: true });

    test('lists its page under Add-ons in the You tab, and opens it', async ({ page }) => {
      await page.goto('/');
      await new BasePage(page).waitForAppReady();

      await page.getByTestId('mobile-tab-you').click();
      const you = page.getByTestId('mobile-tab-panel-you');
      await expect(you.getByRole('heading', { name: 'Add-ons' })).toBeVisible();

      await you.getByRole('button', { name: 'Hello', exact: true }).click();
      await expect(page).toHaveURL(/\/x\/hello-world$/);
      await expect(page.getByRole('heading', { name: 'Hello, there' })).toBeVisible();
    });
  });
});
