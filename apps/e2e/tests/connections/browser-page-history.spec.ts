import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Page, Route } from '@playwright/test';
import { test, expect } from '../../fixtures';
import { LocalBrowserPage } from '../../pages/LocalBrowserPage';
import {
  cdpPageHistory,
  historyAvailability,
  stepPageHistory,
} from '../../../server/src/services/session/local-browser/history/page-history.js';
import { historyAddressAllowed } from '../../../server/src/services/session/local-browser/errors.js';

/**
 * Back and Forward in the Agent browser (DOR-4449).
 *
 * Two halves. The first drives the server's own history step against a real
 * Chromium page and a made-up local site, because the Security Must lives
 * there: an entry that was fine when it was visited can redirect somewhere
 * refused today, and Back or Forward onto it must be refused before it loads.
 * The second is the panel in the real app, with the browser's state faked as
 * the handoff spec does: a real Agent browser opens a real Chrome window.
 */

/** A made-up site whose pages can be told to redirect, counting what it served. */
async function madeUpSite() {
  const redirects = new Map<string, string>();
  const served: string[] = [];
  const server: Server = createServer((request, response) => {
    const path = request.url ?? '/';
    served.push(path);
    const to = redirects.get(path);
    // no-store keeps a page out of the back-forward cache, so Back really loads it.
    if (to) return response.writeHead(302, { Location: to, 'Cache-Control': 'no-store' }).end();
    response
      .writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' })
      .end(`<!doctype html><title>${path}</title><h1>Northwind ${path}</h1>`);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    origin,
    redirects,
    served,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

test.describe('Agent browser history steps in real Chromium', () => {
  let site: Awaited<ReturnType<typeof madeUpSite>>;
  // Stands in for this DorkOS app: the address every step must stay off.
  let app: Awaited<ReturnType<typeof madeUpSite>>;
  let allowed: (url: string) => boolean;

  test.beforeEach(async () => {
    site = await madeUpSite();
    app = await madeUpSite();
    allowed = (url) => historyAddressAllowed(url, [app.origin]);
  });
  test.afterEach(async () => {
    await site.close();
    await app.close();
  });

  const step = (page: Page, direction: 'back' | 'forward') =>
    stepPageHistory(page as never, cdpPageHistory(), direction, allowed);

  test('Back and Forward move the real history, and say when they can', async ({ page }) => {
    await page.goto(`${site.origin}/fares`);
    await page.goto(`${site.origin}/fares/lisbon`);
    const history = cdpPageHistory();
    expect(await historyAvailability(page as never, history, allowed)).toEqual({
      canGoBack: true,
      canGoForward: false,
    });
    await step(page, 'back');
    expect(page.url()).toBe(`${site.origin}/fares`);
    expect(await historyAvailability(page as never, history, allowed)).toEqual({
      canGoBack: true,
      canGoForward: true,
    });
    await step(page, 'forward');
    expect(page.url()).toBe(`${site.origin}/fares/lisbon`);
  });

  test('Back onto an allowed page that now redirects to DorkOS is refused before it loads', async ({
    page,
  }) => {
    await page.goto(`${site.origin}/fares`);
    await page.goto(`${site.origin}/fares/lisbon`);
    site.redirects.set('/fares', `${app.origin}/session`);
    await expect(step(page, 'back')).rejects.toMatchObject({ code: 'history_refused' });
    // The redirect never reached DorkOS, and the person is still where they were.
    expect(app.served).toEqual([]);
    expect(page.url()).toBe(`${site.origin}/fares/lisbon`);
    await expect(page.getByRole('heading', { name: 'Northwind /fares/lisbon' })).toBeVisible();
  });

  test('Forward onto an allowed page that now redirects to DorkOS is refused too', async ({
    page,
  }) => {
    await page.goto(`${site.origin}/fares`);
    await page.goto(`${site.origin}/fares/lisbon`);
    await step(page, 'back');
    site.redirects.set('/fares/lisbon', `${app.origin}/`);
    await expect(step(page, 'forward')).rejects.toMatchObject({ code: 'history_refused' });
    expect(app.served).toEqual([]);
    expect(page.url()).toBe(`${site.origin}/fares`);
  });

  test('a refused entry is skipped, never landed on', async ({ page }) => {
    await page.goto(`${site.origin}/fares`);
    // A person's typed visit to the app's own address, from before the rules.
    await page.goto(`${app.origin}/session`);
    await page.goto(`${site.origin}/fares/lisbon`);
    const before = app.served.length;
    await step(page, 'back');
    expect(page.url()).toBe(`${site.origin}/fares`);
    expect(app.served.length).toBe(before);
  });
});

test.describe('Agent browser Back and Forward in the panel', () => {
  test.describe.configure({ mode: 'default', timeout: 60_000 });

  /** Open a chat whose Agent browser shows a page with history on both sides. */
  async function panelWithHistory(
    page: Page,
    chatPage: { goto: (id?: string, opts?: { dir: string }) => Promise<void> } & {
      sendMessage: (text: string) => Promise<void>;
    },
    answer: (direction: string) => { status: number; json: unknown }
  ) {
    const seed = await page.request.post('/api/test/seed-agent');
    expect(seed.ok()).toBe(true);
    const { agentDir } = (await seed.json()) as { agentDir: string };
    await page.request.patch('/api/config', {
      data: { onboarding: { dismissedAt: new Date().toISOString() } },
    });
    await chatPage.goto(undefined, { dir: agentDir });
    await chatPage.sendMessage('Compare fares to Lisbon.');
    await expect(page.getByTestId('transcript-feed').getByText(/Echo:/).first()).toBeVisible();
    const sessionId = new URL(page.url()).searchParams.get('session')!;
    const state = (url: string, canGoBack: boolean, canGoForward: boolean, paused = false) => ({
      connectionId: 'c1',
      sessionId,
      mode: 'new-window',
      status: 'connected',
      paused,
      tabs: [{ id: 't1', url, title: 'Fares', canGoBack, canGoForward }],
      selectedTabId: 't1',
      revision: 1,
      preparation: null,
      signIn: null,
      handoff: null,
    });
    let current = state('https://northwind.example/fares/lisbon', true, false);
    const steps: string[] = [];
    await page.route('**/api/local-browser/**', async (route: Route) => {
      const path = new URL(route.request().url()).pathname;
      if (path.endsWith('/capabilities')) return route.fallback();
      if (path.endsWith('/history')) {
        const { direction } = route.request().postDataJSON() as { direction: string };
        steps.push(direction);
        const { status, json } = answer(direction);
        if (status === 200) current = json as typeof current;
        return route.fulfill({ status, json });
      }
      return route.fulfill({ json: current });
    });
    await page.reload();
    const browser = new LocalBrowserPage(page);
    await browser.open();
    return { browser, steps, state };
  }

  test('Back moves the page and Forward comes alive; neither says coming soon', async ({
    page,
    chatPage,
  }) => {
    let answers: Record<string, unknown> = {};
    const { browser, steps, state } = await panelWithHistory(page, chatPage, (direction) => ({
      status: 200,
      json: answers[direction],
    }));
    answers = {
      back: state('https://northwind.example/fares', false, true, true),
      forward: state('https://northwind.example/fares/lisbon', true, false, true),
    };
    const back = browser.controls.getByRole('button', { name: 'Back', exact: true });
    await expect(back).toBeEnabled();
    // Forward sits in the row, or in the ⋯ menu below 480px of chrome (spec §12).
    await expect.poll(() => browser.forwardEnabled()).toBe(false);
    await expect(browser.controls.getByText(/coming soon/i)).toHaveCount(0);
    await back.click();
    await expect(
      browser.controls.getByRole('button', { name: 'Address: northwind.example/fares' })
    ).toBeVisible();
    await expect.poll(() => browser.forwardEnabled()).toBe(true);
    await expect(back).toBeDisabled();
    await browser.goForward();
    await expect(
      browser.controls.getByRole('button', { name: 'Address: northwind.example/fares/lisbon' })
    ).toBeVisible();
    expect(steps).toEqual(['back', 'forward']);
  });

  test('a refused step says why and leaves the page where it was', async ({ page, chatPage }) => {
    const { browser, steps } = await panelWithHistory(page, chatPage, () => ({
      status: 409,
      json: {
        error: 'DorkOS doesn’t open that page here, so you stayed on this one.',
        code: 'history_refused',
      },
    }));
    await browser.controls.getByRole('button', { name: 'Back', exact: true }).click();
    await expect(browser.controls.getByRole('alert')).toContainText(
      'DorkOS doesn’t open that page here, so you stayed on this one.'
    );
    await expect(
      browser.controls.getByRole('button', { name: 'Address: northwind.example/fares/lisbon' })
    ).toBeVisible();
    expect(steps).toEqual(['back']);
  });
});
