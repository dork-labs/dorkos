import { createServer, type Server } from 'node:http';
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
 */

/** What the fixture app writes into the page once its module script has run. */
const APP_READY = 'app-ready';

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
  '<h1 data-testid="${APP_READY}">hello from the dev server</h1>';`;

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
 */
async function openInCanvasBrowser(
  page: Page,
  rightPanel: RightPanelPage,
  url: string
): Promise<void> {
  await rightPanel.goto('/session');
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
