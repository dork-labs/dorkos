import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Page } from '@playwright/test';
import type { RightPanelPage } from './RightPanelPage';

/**
 * A dev server shaped like every real one, and the clicks that frame it in the
 * canvas browser.
 *
 * Shared by the two specs that drive this surface, which need the SAME fixture
 * for different reasons: `tests/workbench/dev-server-preview.spec.ts` proves the
 * feature works, and `tests/production/shipped-shell.spec.ts` proves the shipped
 * Content-Security-Policy does not quietly take it away (DOR-560, DOR-1723). Two
 * copies of a fixture that has to stay honest about what a dev server emits is
 * one copy too many — the root-absolute module script below is the whole reason
 * the original bug was invisible, so it is stated once.
 *
 * @module pages/canvas-dev-server
 */

/** What the fixture app writes into the page once its module script has run. */
export const APP_READY = 'app-ready';

/**
 * What the fixture app logs to its own console, for the console-relay test to
 * find in the batch the cockpit posts to the session's capture buffer.
 */
export const CONSOLE_MARKER = 'dev-server-console-marker';

/** A deep path the fixture serves the same HTML for, as a client-side router does. */
export const DEEP_PATH = '/projects/promo/edit';

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
export async function startDevServer(): Promise<{ port: number; server: Server }> {
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
export async function reserveClosedPort(): Promise<number> {
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
 * @param page - The page under test.
 * @param rightPanel - The right-panel page object, for the tab strip.
 * @param url - The address to type into the browser's address bar.
 * @param sessionId - Lands on a named conversation. The browser app keeps that
 *   in the URL, and it is what the capture relay reports captures under.
 */
export async function openInCanvasBrowser(
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
