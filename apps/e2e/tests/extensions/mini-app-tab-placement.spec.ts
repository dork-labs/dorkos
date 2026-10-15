import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { RightPanelPage } from '../../pages/RightPanelPage.js';

/**
 * Where a mini app's right-panel tab shows (spec `mini-app-placement`), seen in
 * a real browser: the panel header's "Mini app options" menu hides the tab on
 * one page, brings it back, keeps the hide to that page, and opens the mini
 * app's full page.
 *
 * Runs in the `chromium-extension-seams` project against the test-mode leg,
 * beside `extension-seams.spec.ts` and `start-work.spec.ts`. All three turn
 * `hello-world` on for their tests and off in `afterAll`, which is why that
 * project is one worker. This file also writes `ui.panelTabs`, so it puts the
 * placement back to nothing before each test and after the last one: a hide
 * left behind would take the tab away from every later spec on the leg.
 */

// eslint-disable-next-line no-restricted-syntax -- E2E test config; no env.ts available
const MOCK_PORT = process.env.DORKOS_MOCK_PORT || '4243';
const API_URL = `http://localhost:${MOCK_PORT}`;

/** The id the core extension ships under. */
const HELLO = 'hello-world';
/** Its right-panel tab's namespaced contribution id, as `ui.panelTabs` stores it. */
const HELLO_TAB = 'hello-world:hello-panel';

/** Turn a core extension on or off through the same route Settings uses. */
async function setEnabled(request: APIRequestContext, id: string, enabled: boolean) {
  const response = await request.post(
    `${API_URL}/api/extensions/${id}/${enabled ? 'enable' : 'disable'}`
  );
  expect(response.ok(), `${enabled ? 'enable' : 'disable'} ${id}: ${await response.text()}`).toBe(
    true
  );
}

/** Forget every saved tab placement, so each tab is back to its own default. */
async function resetPlacements(request: APIRequestContext) {
  const response = await request.patch(`${API_URL}/api/config`, {
    data: { ui: { panelTabs: [] } },
  });
  expect(response.ok(), `reset ui.panelTabs: ${await response.text()}`).toBe(true);
}

/** The saved placement for one tab, as the server returns it. */
interface SavedPlacementWire {
  tab: string;
  show: { agents: string[]; rooms: string[]; pages: string[] };
  hide: { agents: string[]; rooms: string[]; pages: string[] };
}

/** Read the saved placements back from the server, not from the page's cache. */
async function savedPlacements(request: APIRequestContext): Promise<SavedPlacementWire[]> {
  const response = await request.get(`${API_URL}/api/config`);
  expect(response.ok(), `GET /api/config: ${await response.text()}`).toBe(true);
  const body = (await response.json()) as { ui?: { panelTabs?: SavedPlacementWire[] } };
  return body.ui?.panelTabs ?? [];
}

/** Open a page with the right panel showing its tab strip. */
async function openPanelOn(page: Page, path: string): Promise<RightPanelPage> {
  const panel = new RightPanelPage(page);
  await panel.goto(path);
  await panel.ensureTabStripOpen();
  return panel;
}

/** The hello-world tab in the panel's strip. */
function helloTab(panel: RightPanelPage) {
  return panel.header.getByRole('tab', { name: 'Hello', exact: true });
}

/** Open the panel header's "⋯" menu. */
async function openMenu(page: Page, panel: RightPanelPage) {
  await panel.header.getByRole('button', { name: 'Add-on tab options' }).click();
  return page.getByRole('menu');
}

/** Select the hello-world tab and hide it on this page through the menu. */
async function hideHelloHere(page: Page, panel: RightPanelPage) {
  await helloTab(panel).click();
  await expect(helloTab(panel)).toHaveAttribute('aria-selected', 'true');
  const menu = await openMenu(page, panel);
  await menu.getByRole('menuitem', { name: 'Hide here' }).click();
  await expect(helloTab(panel)).toHaveCount(0);
}

test.describe('Mini app tab placement — hide here, show here, open full page', () => {
  // One enable/disable around the whole file: the tests share the extension.
  test.describe.configure({ mode: 'serial' });

  test.beforeAll(async ({ request }) => {
    await setEnabled(request, HELLO, true);
  });

  test.beforeEach(async ({ request }) => {
    await resetPlacements(request);
  });

  test.afterAll(async ({ request }) => {
    await setEnabled(request, HELLO, false);
    await resetPlacements(request);
  });

  test('hides its tab here, saves that on the server, and shows it again', async ({
    page,
    request,
  }) => {
    const panel = await openPanelOn(page, '/activity');
    await expect(helloTab(panel)).toBeVisible();

    await hideHelloHere(page, panel);

    // Saved in server config, so it holds on every device: one hide entry for
    // this page, and nowhere else.
    await expect
      .poll(async () => (await savedPlacements(request)).find((p) => p.tab === HELLO_TAB)?.hide)
      .toEqual({ agents: [], rooms: [], pages: ['activity'] });

    // The menu stays, now offering the hidden tab back.
    const menu = await openMenu(page, panel);
    await expect(menu.getByText('Show here', { exact: true })).toBeVisible();
    await menu.getByRole('menuitem', { name: 'Hello', exact: true }).click();

    await expect(helloTab(panel)).toBeVisible();
    await expect(helloTab(panel)).toHaveAttribute('aria-selected', 'true');
    await expect
      .poll(async () => (await savedPlacements(request)).find((p) => p.tab === HELLO_TAB)?.hide)
      .toEqual({ agents: [], rooms: [], pages: [] });
  });

  test('a tab hidden on Activity still shows on Scheduled', async ({ page, request }) => {
    const activity = await openPanelOn(page, '/activity');
    await hideHelloHere(page, activity);
    // The hide is on the server before the next page reads it.
    await expect
      .poll(async () => (await savedPlacements(request)).find((p) => p.tab === HELLO_TAB)?.hide)
      .toEqual({ agents: [], rooms: [], pages: ['activity'] });

    const tasks = await openPanelOn(page, '/tasks');
    await expect(helloTab(tasks)).toBeVisible();
  });

  test('closes only the local view and restores it through + without changing placement', async ({
    page,
    request,
  }) => {
    const panel = await openPanelOn(page, '/activity');
    await helloTab(panel).click();
    await expect(helloTab(panel)).toHaveAttribute('aria-selected', 'true');
    const body = page.getByRole('tabpanel').filter({ hasText: 'Toggle Tab Dot' });
    await expect(body).toBeVisible();
    const placementBefore = await savedPlacements(request);

    await panel.header.getByRole('button', { name: 'Close Hello view', exact: true }).click();
    await expect(helloTab(panel)).toHaveCount(0);
    await expect(body).toHaveCount(0);
    expect(await savedPlacements(request)).toEqual(placementBefore);

    await panel.header.getByRole('button', { name: 'Add view', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Hello', exact: true }).click();
    await expect(helloTab(panel)).toHaveAttribute('aria-selected', 'true');
    await expect(body).toBeVisible();
    expect(await savedPlacements(request)).toEqual(placementBefore);
  });

  test('unloads the active mini app live and falls back to a working built-in view', async ({
    page,
    request,
  }) => {
    const panel = await openPanelOn(page, '/activity');
    await helloTab(panel).click();
    await expect(helloTab(panel)).toHaveAttribute('aria-selected', 'true');
    const body = page.getByRole('tabpanel').filter({ hasText: 'Toggle Tab Dot' });
    await expect(body).toBeVisible();

    try {
      await setEnabled(request, HELLO, false);
      // The live extension reload must unregister its contribution, without navigation/reload.
      await expect(helloTab(panel)).toHaveCount(0);
      await expect(body).toHaveCount(0);
      await expect(panel.pulseTab).toHaveAttribute('aria-selected', 'true');
      await expect(panel.pulsePanel).toBeVisible();
      await panel.header.getByRole('button', { name: 'Add view', exact: true }).click();
      await expect(page.getByRole('menu')).toBeVisible();
      await expect(page.getByRole('menuitem', { name: 'Hello', exact: true })).toHaveCount(0);
      await page.keyboard.press('Escape');
      await expect(page).toHaveURL(/\/activity$/);
    } finally {
      // Preserve the shared serial fixture even when an assertion fails.
      await setEnabled(request, HELLO, true);
    }
    await expect(helloTab(panel)).toBeVisible();
  });

  test('opens the mini app’s full page from its tab', async ({ page }) => {
    const panel = await openPanelOn(page, '/activity');
    await helloTab(panel).click();
    await expect(helloTab(panel)).toHaveAttribute('aria-selected', 'true');

    const menu = await openMenu(page, panel);
    await menu.getByRole('menuitem', { name: 'Open full page' }).click();

    await expect(page).toHaveURL(/\/x\/hello-world$/);
    await expect(page.getByRole('heading', { name: 'Hello, there' })).toBeVisible();
  });

  test.describe('on a phone', () => {
    test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

    test('reaches +, mini-app options and its full page by touch', async ({ page, request }) => {
      const panel = await openPanelOn(page, '/activity');
      await helloTab(panel).tap();
      await expect(helloTab(panel)).toHaveAttribute('aria-selected', 'true');
      await expect(page.getByRole('tabpanel').filter({ hasText: 'Toggle Tab Dot' })).toBeVisible();

      const add = panel.header.getByRole('button', { name: 'Add view', exact: true });
      await expect(add).toBeInViewport();
      await add.tap();
      await expect(page.getByRole('menuitem', { name: 'Hello', exact: true })).toBeVisible();
      await page.getByRole('menuitem', { name: 'Hello', exact: true }).tap();
      await expect(helloTab(panel)).toHaveAttribute('aria-selected', 'true');

      const options = panel.header.getByRole('button', { name: 'Add-on tab options' });
      await expect(options).toBeInViewport();
      await options.tap();
      const fullPage = page.getByRole('menuitem', { name: 'Open full page' });
      await expect(fullPage).toBeInViewport();
      await fullPage.tap();
      await expect(page).toHaveURL(/\/x\/hello-world$/);
      await expect(page.getByRole('heading', { name: 'Hello, there' })).toBeVisible();
      expect(await savedPlacements(request)).toEqual([]);
    });
  });
});
