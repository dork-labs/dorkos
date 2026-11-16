/**
 * CI-only native witness for the browser chrome's tooltips (DOR-4427): over the
 * Agent browser's native page, a tooltip opens only once a still of the page is
 * drawn in its place, so the page never blinks out; with no still, the button
 * keeps a plain hint and the page stays. It moves a real pointer onto Back,
 * checks that order frame by frame, and saves window pictures for design review
 * in light and dark, idle and with an agent driving. No real profiles, sign-ins
 * or outside websites: the page is made up, and the host is
 * `chrome-tooltip-page.tsx`, served from here.
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { promisify } from 'node:util';
import { app, BrowserWindow, WebContentsView, ipcMain } from 'electron';
import { chromium } from 'playwright-core';
import { LOCAL_BROWSER_STILL_CHANNEL, startLocalBrowserBridge } from '../../src/main/local-browser';

const CONNECTION = 'chrome-tooltip-witness';
/** The chrome's tooltip delay; the "before" frame is taken well inside it. */
const TOOLTIP_DELAY_MS = 500;
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function main(): Promise<void> {
  assert.equal(process.env.CI, 'true', 'Chrome tooltip witness is CI-only');
  assert.equal(process.platform, 'darwin');
  const script = readFileSync(process.env.DORKOS_CHROME_PAGE!, 'utf8');
  const css = process.env.DORKOS_CHROME_CSS
    ? readFileSync(process.env.DORKOS_CHROME_CSS, 'utf8')
    : '';
  const proofDir = process.env.DORKOS_CHROME_PROOF_DIR!;
  mkdirSync(proofDir, { recursive: true });
  const server = createServer((request, response) => {
    if (request.url === '/page.js') {
      response.setHeader('Content-Type', 'text/javascript');
      response.end(script);
      return;
    }
    if (request.url === '/app.css') {
      response.setHeader('Content-Type', 'text/css');
      response.end(css);
      return;
    }
    response.setHeader('Content-Type', 'text/html');
    // The app's own built stylesheet, so the frames show the real chrome.
    response.end(`<!doctype html><link rel="stylesheet" href="/app.css"><style>
      html, body { margin: 0; height: 100%; }
    </style><div id="root"></div><script src="/page.js"></script>`);
  });
  await app.whenReady();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  const host = new BrowserWindow({
    width: 1200,
    height: 800,
    show: true,
    webPreferences: {
      sandbox: true,
      preload: process.env.DORKOS_OVERLAY_PRELOAD!,
      backgroundThrottling: false,
    },
  });
  const bridge = await startLocalBrowserBridge(
    () => origin,
    () => host
  );
  const opened = (await (
    await fetch(`${process.env.DORKOS_LOCAL_BROWSER_BRIDGE!}/open`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.DORKOS_LOCAL_BROWSER_BRIDGE_TOKEN!}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ connectionId: CONNECTION }),
    })
  ).json()) as { endpoint: string; headers: Record<string, string> };
  // An attached agent keeps the guest past the bridge's unclaimed-page timer.
  const browser = await chromium.connectOverCDP(opened.endpoint, {
    headers: opened.headers,
    noDefaults: true,
  });
  const page = () => {
    const view = host.contentView.children.find(
      (child) => child instanceof WebContentsView && child.webContents.id !== host.webContents.id
    );
    assert(view, 'The native page is not attached to the host window');
    return view;
  };
  const js = <T>(code: string) => host.webContents.executeJavaScript(code) as Promise<T>;
  const stillDrawn = () =>
    js<boolean>(`(() => { const still = document.querySelector('[data-slot="native-browser-still"]');
      return !!still && still.complete && still.naturalWidth > 0; })()`);
  const tooltipOpen = () => js<boolean>(`!!document.querySelector('[role="tooltip"]')`);
  const shown = async (want: boolean, step: string) => {
    for (const deadline = Date.now() + 5_000; Date.now() < deadline; await delay(50)) {
      if (page().getVisible() === want) return;
    }
    throw new Error(`${step}: the page is ${want ? 'hidden' : 'still showing'} after 5 s`);
  };
  // The whole window as macOS draws it, native page included.
  const windowId = host.getMediaSourceId().split(':')[1];
  // A picture is evidence for design review, not the check: the asserts are. A
  // runner that cannot take one says so and the witness goes on.
  const frame = async (name: string) => {
    await delay(150);
    try {
      await promisify(execFile)('/usr/sbin/screencapture', [
        '-x',
        '-o',
        '-l',
        windowId,
        path.join(proofDir, `${name}.png`),
      ]);
    } catch (error) {
      console.warn(`Chrome tooltips: no picture for ${name}: ${String(error)}`);
    }
  };
  const back = async () =>
    js<{ x: number; y: number }>(`(() => {
      const box = document.querySelector('button[aria-label="Back"]').getBoundingClientRect();
      return { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) };
    })()`);
  const pointer = (x: number, y: number) =>
    host.webContents.sendInputEvent({ type: 'mouseMove', x, y });
  // Somewhere on the left half, away from the chrome and the page.
  const away = () => pointer(100, 400);

  // A made-up page with something to see, so its still has pixels to compare.
  await (page() as WebContentsView).webContents.loadURL(
    'data:text/html,<body style="margin:0;font:32px system-ui;padding:40px;background:rgb(32,96,200);color:white">Made-up pricing page</body>'
  );
  await host.loadURL(origin);
  host.focus();
  await shown(true, 'Start');

  /**
   * Hover Back: no tooltip inside the delay, then the still is drawn before the
   * page hides. The chrome sits at the window's top edge here, so the tooltip
   * flips below Back and over the page: the case that needs the still.
   */
  const hoverWithStill = async (name: string) => {
    away();
    await shown(true, `${name}: start`);
    const target = await back();
    pointer(target.x, target.y);
    await delay(TOOLTIP_DELAY_MS / 2);
    assert.equal(await tooltipOpen(), false, `${name}: the tooltip opened inside the delay`);
    assert.equal(page().getVisible(), true, `${name}: the page hid inside the delay`);
    await frame(`${name}-1-before`);
    // Frame by frame until the page steps aside: the still must already be there.
    for (const deadline = Date.now() + 5_000; page().getVisible(); await delay(16)) {
      assert(Date.now() < deadline, `${name}: the page never stepped aside for the tooltip`);
    }
    assert.equal(await stillDrawn(), true, `${name}: the page hid before its still was drawn`);
    for (const deadline = Date.now() + 2_000; !(await tooltipOpen()); await delay(50)) {
      assert(Date.now() < deadline, `${name}: the tooltip never opened`);
    }
    await frame(`${name}-2-during`);
    away();
    await shown(true, `${name}: after`);
  };

  /** With no still to be had, the page never hides and Back keeps its plain hint. */
  const hoverWithoutStill = async (name: string) => {
    away();
    await shown(true, `${name}: start`);
    const target = await back();
    pointer(target.x, target.y);
    for (const until = Date.now() + TOOLTIP_DELAY_MS + 1_000; Date.now() < until; await delay(16)) {
      assert.equal(page().getVisible(), true, `${name}: the page blinked out with no still`);
    }
    assert.equal(await tooltipOpen(), false, `${name}: a tooltip opened with no still under it`);
    assert.equal(
      await js<string | null>(
        `document.querySelector('button[aria-label="Back"]').getAttribute('title')`
      ),
      'Back',
      `${name}: Back lost its plain hint`
    );
    await frame(`${name}-during`);
    away();
  };

  for (const dark of [false, true]) {
    const theme = dark ? 'dark' : 'light';
    for (const agentDriving of [false, true]) {
      await js(`window.__scene(${JSON.stringify({ dark, agentDriving })})`);
      await hoverWithStill(`${theme}-${agentDriving ? 'agent-driving' : 'idle'}`);
    }
  }

  // No still to be had: the bridge answers none, as a page it cannot capture does.
  ipcMain.removeHandler(LOCAL_BROWSER_STILL_CHANNEL);
  ipcMain.handle(LOCAL_BROWSER_STILL_CHANNEL, () => null);
  for (const dark of [false, true]) {
    await js(`window.__scene(${JSON.stringify({ dark, agentDriving: false })})`);
    await hoverWithoutStill(`${dark ? 'dark' : 'light'}-no-still`);
  }

  await browser.close();
  await bridge.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  host.destroy();
  console.log(
    'Chrome tooltips: none inside 500 ms; the page steps aside only onto its still; with no still it stays and Back keeps its hint.'
  );
}
main()
  .then(() => app.exit(0))
  .catch((error) => {
    console.error(error);
    app.exit(1);
  });
