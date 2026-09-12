import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Page } from '@playwright/test';
import type { RightPanelPage } from './RightPanelPage';

/**
 * A dev server shaped like every real one, and the clicks that frame it in the
 * embedded browser.
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
 * Open the embedded browser on `url`, the way a person does: open the right
 * panel, pick Browser, start a page from its empty state, then type the address.
 *
 * Browser rather than Canvas since the panel split into two views over one
 * document store (ADR 260911-200304): a page is a Browser-tab document, and the
 * Canvas tab no longer offers to open one.
 *
 * @param page - The page under test.
 * @param rightPanel - The right-panel page object, for the tab strip.
 * @param url - The address to type into the browser's address bar.
 * @param sessionId - Lands on a named conversation. The browser app keeps that
 *   in the URL, and it is what the capture relay reports captures under.
 * @param dir - The working directory to open the conversation in. A spec that
 *   goes on to SEND needs one from `POST /api/test/seed-agent`: a send into a
 *   directory outside the boundary is refused with a 400 and the spec then waits
 *   out its timeout on a message that was never accepted.
 */
export async function openInCanvasBrowser(
  page: Page,
  rightPanel: RightPanelPage,
  url: string,
  sessionId?: string,
  dir?: string
): Promise<void> {
  const query = [
    sessionId ? `session=${sessionId}` : '',
    dir ? `dir=${encodeURIComponent(dir)}` : '',
  ].filter(Boolean);
  await rightPanel.goto(query.length > 0 ? `/session?${query.join('&')}` : '/session');
  await rightPanel.ensureTabStripOpen();
  await rightPanel.browserTab.click();

  // The empty state's web-page action opens a browser document; its address bar
  // is how any page after the first one is reached.
  await page.getByRole('button', { name: /Web Page/i }).click();
  await page.getByRole('button', { name: /^Address:/ }).click();
  const address = page.getByRole('textbox', { name: 'Address' });
  await address.fill(url);
  await address.press('Enter');
}

/** The button an agent clicks in the driving fixture, by its accessible name. */
export const DRIVING_BUTTON = 'Mark as done';

/** What the driving fixture shows once that button has been clicked. */
export const DRIVING_DONE_TEXT = 'Done — 1 item';

const DRIVING_HTML = `<!doctype html>
<html>
  <head><title>Driving fixture</title></head>
  <body>
    <main>
      <h1>Inbox</h1>
      <p id="status">Nothing done yet</p>
      <button id="done" type="button">${DRIVING_BUTTON}</button>
      <button type="button" disabled>Archive</button>
    </main>
    <script src="/main.js"></script>
  </body>
</html>`;

const DRIVING_JS = `document.getElementById('done').addEventListener('click', function () {
  document.getElementById('status').textContent = '${DRIVING_DONE_TEXT}';
});`;

/**
 * A page an agent can actually use: one button that changes the page when it is
 * clicked, one disabled button beside it, and text that is only there afterwards.
 *
 * Deliberately small and deliberately real. The point of the driving spec is
 * that a click reaches a live document and changes it, so the fixture has to
 * make "before" and "after" distinguishable by looking at the page — which a
 * screenshot, an outline read and a human all do the same way.
 *
 * Served the way {@link startDevServer} serves its app, because the shim only
 * reaches a page DorkOS is serving or proxying.
 */
export async function startDrivingFixtureServer(): Promise<{ port: number; server: Server }> {
  const server = createServer((req, res) => {
    if (req.url === '/main.js') {
      res.setHeader('Content-Type', 'text/javascript; charset=utf-8');
      res.end(DRIVING_JS);
      return;
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(DRIVING_HTML);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { port: (server.address() as AddressInfo).port, server };
}
