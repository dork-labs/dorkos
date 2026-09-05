import type { Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { test, expect } from '../../fixtures';
import {
  APP_READY,
  CONSOLE_MARKER,
  DEEP_PATH,
  openInCanvasBrowser,
  reserveClosedPort,
  startDevServer,
} from '../../pages/canvas-dev-server';

/**
 * Opening a dev server in the canvas browser.
 *
 * The failure this exists to catch is silent: the canvas used to fetch a
 * localhost URL through a path-prefixed proxy, so an app whose HTML asks for
 * `/main.js` asked the COCKPIT for it, got the cockpit's own page back, and
 * rendered a blank white rectangle with no message. Every Vite, Next and CRA dev
 * server is shaped that way. So the fixture is shaped that way too: a
 * root-absolute module script, and a deep path that serves the same HTML the way
 * a client-side router's fallback does. It lives in `pages/canvas-dev-server.ts`
 * because `tests/production/shipped-shell.spec.ts` re-drives this same surface
 * under the shipped Content-Security-Policy, and a fixture that has to stay
 * honest about what a dev server emits may not exist twice (DOR-1723).
 *
 * The first two tests assert only the promise to the user: a running dev server
 * renders, and a port with nothing on it says so. The third is about the
 * mechanism that now delivers it — a preview origin of its own, on a port
 * DorkOS opened, which the deep-path test proves survives the one-time
 * bootstrap redirect that moves the token into a cookie.
 *
 * The last one is about what the agent gets out of it (DOR-1305): the preview's
 * own `console.log` has to reach the conversation's capture buffer, which is the
 * buffer `browser_read_console` reads. That relay was dead in the browser app for
 * months — it asked a store field only the Obsidian embed ever writes — and no
 * test noticed, because every test of it ran with that field set by hand.
 */

test.describe('Canvas — a dev server running on this machine @smoke', () => {
  let devServer: Server;
  let devPort: number;

  test.beforeAll(async () => {
    const started = await startDevServer();
    devServer = started.server;
    devPort = started.port;
  });

  test.afterAll(async () => {
    await new Promise<void>((resolve) => devServer.close(() => resolve()));
  });

  test('renders a Vite-shaped app, including at a deep path', async ({ page, rightPanel }) => {
    await openInCanvasBrowser(page, rightPanel, `http://localhost:${devPort}${DEEP_PATH}`);

    // The app's own script ran and painted. On the pre-fix canvas this element
    // never appeared: the module request was answered by the cockpit's SPA
    // fallback instead of the dev server.
    const frame = page.frameLocator('iframe[title="Web Page"]');
    await expect(frame.getByTestId(APP_READY)).toBeVisible({ timeout: 15_000 });
  });

  test('serves the preview from an origin of its own, and keeps the deep path', async ({
    page,
    rightPanel,
  }) => {
    await openInCanvasBrowser(page, rightPanel, `http://localhost:${devPort}${DEEP_PATH}`);
    const frame = page.frameLocator('iframe[title="Web Page"]');
    await expect(frame.getByTestId(APP_READY)).toBeVisible({ timeout: 15_000 });

    const previewFrame = page
      .frames()
      .find((candidate) => candidate !== page.mainFrame() && candidate.url().startsWith('http'));
    expect(previewFrame).toBeDefined();
    const framed = new URL(previewFrame!.url());

    // A port DorkOS opened: not the cockpit's, and not the dev server's either.
    expect(framed.port).not.toBe(new URL(page.url()).port);
    expect(framed.port).not.toBe(String(devPort));
    // The page asked for is the page shown — the bootstrap redirect moved the
    // token into a cookie without losing the route on the way.
    expect(framed.pathname).toBe(DEEP_PATH);
    expect(framed.searchParams.get('__dorkos_preview')).toBeNull();
  });

  test('relays the preview’s console into the conversation an agent reads (DOR-1305)', async ({
    page,
    rightPanel,
  }) => {
    const sessionId = randomUUID();

    /** Every capture batch the cockpit posted, in the order it posted them. */
    const ingests: { url: string; body: unknown }[] = [];
    page.on('request', (request) => {
      if (request.method() !== 'POST' || !request.url().includes('/devtools/ingest')) return;
      ingests.push({ url: request.url(), body: request.postDataJSON() });
    });

    await openInCanvasBrowser(page, rightPanel, `http://localhost:${devPort}/`, sessionId);
    const frame = page.frameLocator('iframe[title="Web Page"]');
    await expect(frame.getByTestId(APP_READY)).toBeVisible({ timeout: 15_000 });

    // The whole path, end to end: the shim captured the page's own `console.log`,
    // posted it to the cockpit, and the cockpit relayed it to THIS conversation's
    // buffer — the one `browser_read_console` reads server-side. Before the fix
    // this array stayed empty in a browser, however long you waited.
    await expect
      .poll(
        () =>
          ingests.some((ingest) => {
            if (!ingest.url.includes(`/api/sessions/${sessionId}/devtools/ingest`)) return false;
            const entries =
              (ingest.body as { console?: { text?: string }[] } | null)?.console ?? [];
            return entries.some((entry) => entry.text?.includes(CONSOLE_MARKER));
          }),
        { timeout: 15_000 }
      )
      .toBe(true);
  });

  test('says nothing is listening rather than framing a dead port', async ({
    page,
    rightPanel,
  }) => {
    const deadPort = await reserveClosedPort();
    await openInCanvasBrowser(page, rightPanel, `http://localhost:${deadPort}/`);

    await expect(page.getByText(`Nothing is listening on localhost:${deadPort}.`)).toBeVisible({
      timeout: 15_000,
    });
    // No frame at all — a blank rectangle is the thing being replaced.
    await expect(page.locator('iframe[title="Web Page"]')).toHaveCount(0);
  });
});
