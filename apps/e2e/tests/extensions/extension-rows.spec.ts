import type { Page, Route } from '@playwright/test';
import { test, expect } from '../../fixtures';

/**
 * Settings → Extensions as one line per extension (compact rows, Nov 8).
 *
 * The list is served from a fixture through `page.route`, so every state the
 * rows draw is on screen at once without installing or approving anything:
 * what needs the person on top, the rest A–Z, search, the Off filter, opening
 * a row by click and by keyboard, Review moving focus to the panel's Allow, a
 * list that fails to load and then loads, and a phone width with nothing
 * spilling sideways. All names are made up. No turns, nothing billed.
 */

/** One extension record, as `GET /api/extensions` sends it. */
function ext(id: string, name: string, extra: Record<string, unknown> = {}) {
  const { manifest, ...rest } = extra as { manifest?: Record<string, unknown> };
  return {
    id,
    manifest: { id, name, version: '1.0.0', author: 'Example Co', ...manifest },
    status: 'active',
    scope: 'global',
    origin: 'user',
    bundleReady: true,
    hasServerEntry: false,
    hasDataProxy: false,
    approvedToRun: true,
    shadowedBy: null,
    isolation: null,
    ...rest,
  };
}

const LIST = [
  ext('orbit-calendar', 'Orbit Calendar', {
    approvedToRun: false,
    hasServerEntry: true,
    manifest: { summary: 'Shows your week beside chats.' },
  }),
  ext('lint-lantern', 'Lint Lantern', {
    status: 'activate_error',
    error: { code: 'ACTIVATE_ERROR', message: 'It threw on start.' },
    manifest: { summary: 'Runs code checks when an agent finishes.' },
  }),
  ext('field-notes', 'Field Notes', { manifest: { summary: 'Capture notes into a daily page.' } }),
  ext('customer-interview', 'Customer Interview Synthesizer For Product Discovery Teams', {
    manifest: { summary: 'Turns interview transcripts into themes and quotes.' },
  }),
  ext('clip-shelf', 'Clip Shelf', {
    status: 'disabled',
    manifest: { summary: 'A shelf for links.' },
  }),
  ext('dork-core', 'Core Thing', { origin: 'core', manifest: { summary: 'Comes with DorkOS.' } }),
];

/** Serve the list (or refuse it), and an empty approval queue. */
async function serveList(page: Page, answer: () => { status: number; body: unknown }) {
  await page.route(
    (url) => url.pathname === '/api/extensions',
    async (route: Route) => {
      if (route.request().method() !== 'GET') return route.continue();
      const { status, body } = answer();
      await route.fulfill({ status, json: body });
    }
  );
  await page.route(
    (url) => url.pathname === '/api/extensions/pending-approvals',
    (route: Route) => route.fulfill({ json: { approvals: [] } })
  );
}

/** The row names in one section, top to bottom. */
async function namesIn(page: Page, testId: string): Promise<string[]> {
  return page.getByTestId(testId).locator('[data-row-button] > span:first-child').allTextContents();
}

test.describe('Settings → Extensions rows', () => {
  test('orders, searches, filters, and opens rows by click and keyboard', async ({
    page,
    settingsPage,
  }) => {
    await serveList(page, () => ({ status: 200, body: LIST }));
    await page.goto('/');
    await settingsPage.open();
    await settingsPage.switchTab('Extensions');
    const dialog = settingsPage.dialog;

    await expect(dialog.getByTestId('extensions-count')).toHaveText('5 installed · 2 need you');
    expect(await namesIn(page, 'needs-you-section')).toEqual(['Orbit Calendar', 'Lint Lantern']);
    expect(await namesIn(page, 'installed-extensions-section')).toEqual([
      'Clip Shelf',
      'Customer Interview Synthesizer For Product Discovery Teams',
      'Field Notes',
    ]);

    // A long name stays in its column: every purpose line starts at one x.
    const purposeX = async (id: string) =>
      (await dialog
        .getByTestId(`extension-card-${id}`)
        .locator('[data-row-button] > span:nth-child(2)')
        .boundingBox())!.x;
    expect(await purposeX('customer-interview')).toBe(await purposeX('field-notes'));

    // Waiting for an OK: Review, never a switch; Review lands on Allow.
    const orbit = dialog.getByTestId('extension-card-orbit-calendar');
    await expect(orbit.getByRole('switch')).toHaveCount(0);
    await orbit.getByRole('button', { name: 'Review Orbit Calendar' }).click();
    await expect(orbit.getByRole('button', { name: 'Allow' })).toBeFocused();
    await expect(orbit).toContainText('Orbit Calendar wants to run on this computer.');
    await page.keyboard.press('Escape');
    await expect(orbit.locator('[data-row-button]')).toBeFocused();
    await expect(orbit.locator('[data-row-button]')).toHaveAttribute('aria-expanded', 'false');

    // Keyboard: down to the next row, Enter opens it.
    await page.keyboard.press('ArrowDown');
    const lint = dialog.getByTestId('extension-card-lint-lantern');
    await expect(lint.locator('[data-row-button]')).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(lint).toContainText('It stopped working.');

    // Search narrows; nothing matching says so.
    const search = dialog.getByRole('searchbox', { name: 'Search extensions' });
    await search.fill('daily page');
    await expect(dialog.getByTestId('extension-card-field-notes')).toBeVisible();
    await expect(dialog.getByTestId('extension-card-clip-shelf')).toHaveCount(0);
    await search.fill('zebra');
    await expect(dialog.getByTestId('extensions-no-match')).toContainText(
      'Nothing matches “zebra”'
    );
    await dialog.getByRole('button', { name: 'Clear search' }).click();

    // Off shows only what is off.
    await dialog.getByRole('button', { name: 'Off 1' }).click();
    await expect(dialog.getByTestId('extension-card-clip-shelf')).toBeVisible();
    await expect(dialog.getByTestId('extension-card-field-notes')).toHaveCount(0);
  });

  test('the Extensions tab opens no row by itself; a link that names one still does', async ({
    page,
    settingsPage,
  }) => {
    await serveList(page, () => ({ status: 200, body: LIST }));
    await page.goto('/');
    await settingsPage.open();
    await settingsPage.switchTab('Extensions');
    const dialog = settingsPage.dialog;

    await expect(dialog.getByTestId('extension-card-orbit-calendar')).toBeVisible();
    // Long enough for a deep-link scroll's frame and the URL write before it.
    await page.waitForTimeout(500);
    expect(new URL(page.url()).searchParams.get('settingsSection')).toBeNull();
    await expect(dialog.locator('[data-row-button][aria-expanded="true"]')).toHaveCount(0);
    await expect(dialog.getByTestId('needs-you-section')).toBeInViewport();

    // A link that names a row opens that row, and only that one.
    await page.goto('/?settings=extensions&settingsSection=field-notes');
    const notes = settingsPage.dialog.getByTestId('extension-card-field-notes');
    await expect(notes.locator('[data-row-button]')).toHaveAttribute('aria-expanded', 'true');
    await expect(
      settingsPage.dialog.locator('[data-row-button][aria-expanded="true"]')
    ).toHaveCount(1);
  });

  test('⌘K, "settings", Enter opens Settings with no section', async ({ page, settingsPage }) => {
    await serveList(page, () => ({ status: 200, body: LIST }));
    await page.goto('/');
    // An app with a page also gets a "{App} settings" row, and when one of
    // those won this, Settings opened on that app's row. The fixture's apps
    // have no pages, so the ranking itself is pinned in
    // `apps-palette-rows.test.ts`.
    await page.getByRole('button', { name: 'Open command palette' }).click();
    const search = page.getByTestId('command-palette-input');
    await search.fill('settings');
    await search.press('Enter');
    await settingsPage.dialog.waitFor({ state: 'visible' });
    expect(new URL(page.url()).searchParams.get('settingsSection')).toBeNull();
  });

  test('says it couldn’t load, never "none installed", and tries again', async ({
    page,
    settingsPage,
  }) => {
    let refuse = true;
    await serveList(page, () =>
      refuse ? { status: 500, body: { error: 'boom' } } : { status: 200, body: LIST }
    );
    await page.goto('/');
    await settingsPage.open();
    await settingsPage.switchTab('Extensions');

    const alert = settingsPage.dialog.getByRole('alert');
    await expect(alert).toContainText('Couldn’t load your extensions', { timeout: 15_000 });
    await expect(alert).toContainText('They’re still installed, and nothing was turned off.');
    await expect(settingsPage.dialog.getByTestId('no-extensions')).toHaveCount(0);

    refuse = false;
    await alert.getByRole('button', { name: 'Try again' }).click();
    await expect(settingsPage.dialog.getByTestId('extension-card-field-notes')).toBeVisible();
  });

  test('fits a phone: nothing spills sideways', async ({ page, settingsPage }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await serveList(page, () => ({ status: 200, body: LIST }));
    await page.goto('/');
    await settingsPage.open();
    // On a phone Settings is a list that drills in, not a row of tabs.
    await settingsPage.dialog.getByRole('button', { name: 'Extensions' }).click();
    // The drawer takes the tab's name once it drills in, so find the list by itself.
    const list = page.locator('[data-extension-list]');
    await expect(list.getByTestId('extension-card-field-notes')).toBeVisible();
    await list.getByTestId('extension-card-orbit-calendar').locator('[data-row-button]').click();

    const overflow = await list.evaluate((el) => el.scrollWidth - el.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  });
});
