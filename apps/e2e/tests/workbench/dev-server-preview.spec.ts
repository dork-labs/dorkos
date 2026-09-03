import { createServer, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { test, expect } from '../../fixtures';
import type { Page } from '@playwright/test';
import type { RightPanelPage } from '../../pages/RightPanelPage';

/**
 * Opening a dev server in the canvas browser.
 *
 * The failure this exists to catch is silent: the canvas used to fetch a
 * localhost URL through a path-prefixed proxy, so an app whose HTML asks for
 * `/main.js` asked the COCKPIT for it, got the cockpit's own page back, and
 * rendered a blank white rectangle with no message. Every Vite, Next and CRA dev
 * server is shaped that way. So the fixture below is shaped that way too: a
 * root-absolute module script, and a deep path that serves the same HTML the way
 * a client-side router's fallback does.
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

/** What the fixture app writes into the page once its module script has run. */
const APP_READY = 'app-ready';

/**
 * What the fixture app logs to its own console, for the relay test to find in the
 * batch the cockpit posts to the session's capture buffer.
 */
const CONSOLE_MARKER = 'dev-server-console-marker';

/** A deep path the fixture serves the same HTML for, as a client-side router does. */
const DEEP_PATH = '/projects/promo/edit';

const INDEX_HTML = `<!doctype html>
<html>
  <head>
    <title>Fixture dev server</title>
    <!-- Root-absolute, and a module — exactly what a Vite dev server emits, and
         exactly what the old path-prefixed proxy could not deliver. -->
    <script type="module" src="/main.js"></script>
  </head>
  <body><div id="root"></div></body>
</html>`;

const MAIN_JS = `document.getElementById('root').innerHTML =
  '<h1 data-testid="${APP_READY}">hello from the dev server</h1>';
console.log('${CONSOLE_MARKER}');`;

/** Start a Vite-shaped static server on an ephemeral port. */
async function startDevServer(): Promise<{ port: number; server: Server }> {
  const server = createServer((req, res) => {
    if (req.url === '/main.js') {
      res.setHeader('Content-Type', 'text/javascript; charset=utf-8');
      res.end(MAIN_JS);
      return;
    }
    // Everything else is the app shell, the way a dev server's SPA fallback is.
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(INDEX_HTML);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { port: (server.address() as AddressInfo).port, server };
}

/** Claim a port and hand it back closed, so "nothing is listening" is a fact. */
async function reserveClosedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

/**
 * Open the canvas browser on `url`, the way a person does: open the right panel,
 * pick Canvas, start a web page from the splash, then type the address.
 *
 * Pass `sessionId` to land on a named conversation — the browser app keeps that
 * in the URL, and it is what the capture relay reports captures under.
 */
async function openInCanvasBrowser(
  page: Page,
  rightPanel: RightPanelPage,
  url: string,
  sessionId?: string
): Promise<void> {
  await rightPanel.goto(sessionId ? `/session?session=${sessionId}` : '/session');
  await rightPanel.ensureTabStripOpen();
  await rightPanel.header.getByRole('tab', { name: 'Canvas' }).click();

  // The splash's web-page action opens a browser document; its address bar is
  // how any page after the first one is reached.
  await page.getByRole('button', { name: /Web Page/i }).click();
  await page.getByRole('button', { name: /^Address:/ }).click();
  const address = page.getByRole('textbox', { name: 'Address' });
  await address.fill(url);
  await address.press('Enter');
}

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
