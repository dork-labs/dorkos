import { test, expect, type APIRequestContext, type Page, type Route } from '@playwright/test';
import { appFrame, appPage } from '../../pages/app-frame.js';

/**
 * A direct load of an app's own page while the app is still starting (QA's
 * page-state harness, 0.135.1 re-gate). The page must say "Starting…" while the
 * app loads, "isn't working" with Try again if its bundle never finishes, and
 * "doesn't have this page" only once the app has loaded without it.
 *
 * Each case holds `hello-world`'s bundle by hand, so the order of the loads is
 * fixed rather than left to timing: QA's C3 only showed when the reload's import
 * outlasted the first load's, which made it a CI flake.
 *
 * Runs in `chromium-extension-seams`, on its one worker: it turns `hello-world`
 * on and off, like the other files there.
 */

// eslint-disable-next-line no-restricted-syntax -- E2E test config; no env.ts available
const MOCK_PORT = process.env.DORKOS_MOCK_PORT || '4243';
const API_URL = `http://localhost:${MOCK_PORT}`;
const HELLO = 'hello-world';
const BUNDLE = (url: URL) => url.pathname === `/api/extensions/${HELLO}/bundle`;
const LIST = (url: URL) => url.pathname === '/api/extensions';

/** Turn a core extension on or off through the same route Settings uses. */
async function setEnabled(request: APIRequestContext, enabled: boolean) {
  const response = await request.post(
    `${API_URL}/api/extensions/${HELLO}/${enabled ? 'enable' : 'disable'}`
  );
  expect(response.ok(), `${enabled ? 'enable' : 'disable'}: ${await response.text()}`).toBe(true);
}

/** What the page has said so far, watched from before the app boots. */
interface Seen {
  starting: boolean;
  said: string[];
}

/** Record every "isn't available" sentence and whether "Starting…" showed. */
async function watchPage(page: Page) {
  await page.addInitScript(() => {
    const seen = { starting: false, said: [] as string[] };
    (window as Window & { __seen?: typeof seen }).__seen = seen;
    const read = () => {
      const text = document.body?.innerText ?? '';
      if (text.includes('Starting…')) seen.starting = true;
      const empty = document.querySelector('[data-slot="empty-state"]')?.textContent ?? '';
      if (empty && !seen.said.includes(empty)) seen.said.push(empty);
    };
    new MutationObserver(read).observe(document, {
      childList: true,
      subtree: true,
      characterData: true,
    });
  });
}

async function seen(page: Page): Promise<Seen> {
  return (await page.evaluate(() => (window as Window & { __seen?: Seen }).__seen))!;
}

/** Bundle requests, each held until the test lets it through. */
function holdBundles(page: Page) {
  const held: Array<{ route: Route; release: () => Promise<void> }> = [];
  const arrivals: Array<() => void> = [];
  const handler = (route: Route) =>
    new Promise<void>((done) => {
      held.push({
        route,
        release: async () => {
          await route.continue().catch(() => {});
          done();
        },
      });
      arrivals.shift()?.();
    });
  return {
    async install() {
      await page.route(BUNDLE, handler);
    },
    /** Resolves once the `n`th bundle request (1-based) has arrived. */
    async arrived(n: number) {
      while (held.length < n) await new Promise<void>((resolve) => arrivals.push(resolve));
    },
    release: (n: number) => held[n - 1]!.release(),
    async done() {
      await page.unroute(BUNDLE, handler);
      for (const request of held) await request.release();
    },
  };
}

/** The app's page heading, drawn inside its own sandboxed frame (DOR-3293). */
function pageHeading(page: Page) {
  return appFrame(appPage(page), 'Hello World').getByRole('heading', { name: 'Hello, there' });
}
const NOT_AVAILABLE = /isn’t available/;

test.describe('An app’s page while the app is still starting', () => {
  test.describe.configure({ mode: 'serial' });

  test.beforeAll(async ({ request }) => {
    await setEnabled(request, true);
  });

  test.afterAll(async ({ request }) => {
    await setEnabled(request, false);
  });

  test('says Starting… while a slow bundle loads, then shows the page (A)', async ({ page }) => {
    await watchPage(page);
    const bundles = holdBundles(page);
    await bundles.install();
    try {
      await page.goto(`/x/${HELLO}`);
      await bundles.arrived(1);
      await expect(page.getByTestId('extension-page-loading').getByText('Starting…')).toBeVisible();
      await bundles.release(1);
    } finally {
      await bundles.done();
    }
    await expect(pageHeading(page)).toBeVisible();
    const what = await seen(page);
    expect(what.starting).toBe(true);
    expect(what.said, 'never said the page was unavailable').toEqual([]);
  });

  test('says the app isn’t working when its bundle never finishes, and Try again loads it (B)', async ({
    page,
  }) => {
    // The client gives one bundle 15 seconds.
    test.setTimeout(60_000);
    await watchPage(page);
    const bundles = holdBundles(page);
    await bundles.install();
    try {
      await page.goto(`/x/${HELLO}`);
      await bundles.arrived(1);
      const notWorking = page.getByTestId('extension-page-not-working');
      await expect(notWorking).toContainText('Hello World isn’t working.', { timeout: 25_000 });
      await expect(page.getByText(NOT_AVAILABLE)).toHaveCount(0);

      // Try again imports it afresh; let that one through.
      await notWorking.getByRole('button', { name: 'Try again' }).click();
      await bundles.arrived(2);
      await bundles.release(2);
      await expect(pageHeading(page)).toBeVisible();
    } finally {
      await bundles.done();
    }
    expect((await seen(page)).said, 'never said the page was unavailable').toEqual([]);
  });

  test('keeps waiting when a hot reload’s import outlasts the first load (C3)', async ({
    page,
    request,
  }) => {
    await watchPage(page);
    const bundles = holdBundles(page);
    await bundles.install();
    try {
      await page.goto(`/x/${HELLO}`);
      await bundles.arrived(1);
      // Turned off and on while the first import is held: the reload imports
      // the bundle again.
      await setEnabled(request, false);
      await setEnabled(request, true);
      await bundles.arrived(2);

      // The first load finishes first; the reload is still importing.
      await bundles.release(1);
      await page.waitForTimeout(1_000);
      await expect(page.getByText(NOT_AVAILABLE)).toHaveCount(0);
      await expect(page.getByTestId('extension-page-loading')).toBeVisible();

      await bundles.release(2);
    } finally {
      await bundles.done();
    }
    await expect(pageHeading(page)).toBeVisible();
    expect((await seen(page)).said, 'never said the page was unavailable').toEqual([]);
  });

  test('keeps “isn’t allowed to run yet” when the app’s files change mid-load (C2)', async ({
    page,
    request,
  }) => {
    // From the change on, the server says the app waits on a person again —
    // what editing an approved app's files does. Faked here so the shared
    // server's core extension is never edited.
    let changed = false;
    await page.route(LIST, async (route) => {
      if (!changed) return route.continue();
      const response = await route.fetch();
      const list = (await response.json()) as Array<{ id: string; approvedToRun: boolean }>;
      await route.fulfill({
        response,
        json: list.map((record) =>
          record.id === HELLO ? { ...record, approvedToRun: false } : record
        ),
      });
    });
    await watchPage(page);
    const bundles = holdBundles(page);
    await bundles.install();
    try {
      await page.goto(`/x/${HELLO}`);
      await bundles.arrived(1);
      changed = true;
      // The change reaches the window as a hot reload.
      await setEnabled(request, false);
      await setEnabled(request, true);
      await expect(page.getByText('Hello World isn’t allowed to run yet.')).toBeVisible();

      // The first load's import comes back late, with the list it read before.
      await bundles.release(1);
      await page.waitForTimeout(1_500);
      await expect(page.getByText('Hello World isn’t allowed to run yet.')).toBeVisible();
      await expect(page.getByText(/doesn’t have this page/)).toHaveCount(0);
    } finally {
      await bundles.done();
      await page.unroute(LIST);
    }
    expect((await seen(page)).said.some((said) => said.includes('doesn’t have this page'))).toBe(
      false
    );
  });
});
