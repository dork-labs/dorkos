/**
 * CI-only native witness: the page steps aside for app layers drawn over it,
 * and only for those (DOR-4417, DOR-4418). No real profiles, sign-ins or
 * outside websites; the host page is `overlay-page.tsx`, served from here.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { app, BrowserWindow, WebContentsView } from 'electron';
import { chromium } from 'playwright-core';
import {
  LOCAL_BROWSER_BOUNDS_CHANNEL,
  startLocalBrowserBridge,
} from '../../src/main/local-browser';

const CONNECTION = 'overlay-witness';
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function main(): Promise<void> {
  assert.equal(process.env.CI, 'true', 'Overlay witness is CI-only');
  assert.equal(process.platform, 'darwin');
  // overlay-preload.ts sends this literal; it cannot import the bridge module.
  assert.equal(LOCAL_BROWSER_BOUNDS_CHANNEL, 'local-browser:set-bounds');
  const script = readFileSync(process.env.DORKOS_OVERLAY_PAGE!, 'utf8');
  const server = createServer((request, response) => {
    if (request.url === '/page.js') {
      response.setHeader('Content-Type', 'text/javascript');
      response.end(script);
      return;
    }
    response.setHeader('Content-Type', 'text/html');
    // The shared parts style themselves with Tailwind, which this page does not
    // load; only the backdrops' full-window box matters to the check.
    response.end(`<!doctype html><style>
      html, body { margin: 0; height: 100%; }
      [data-slot$="-overlay"] { position: fixed; inset: 0; }
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
  const shown = async (want: boolean, step: string) => {
    for (const deadline = Date.now() + 5_000; Date.now() < deadline; await delay(50)) {
      if (page().getVisible() === want) return;
    }
    throw new Error(`${step}: the page is ${want ? 'hidden' : 'still showing'} after 5 s`);
  };
  const open = (layer: string) =>
    host.webContents.executeJavaScript(`window.__overlay(${JSON.stringify(layer)})`);
  const mounted = async (selector: string, step: string) => {
    for (const deadline = Date.now() + 5_000; Date.now() < deadline; await delay(50)) {
      if (await host.webContents.executeJavaScript(`!!document.querySelector('${selector}')`))
        return;
    }
    throw new Error(`${step}: ${selector} never rendered`);
  };

  await host.loadURL(origin);
  await shown(true, 'Start');

  // 1. A tooltip away from the page leaves it on screen the whole time.
  await open('tooltip-away');
  await mounted('[data-radix-popper-content-wrapper]', 'Tooltip away');
  for (const until = Date.now() + 1_000; Date.now() < until; await delay(50)) {
    assert.equal(page().getVisible(), true, 'Tooltip away: the page disappeared');
  }
  await open('none');

  // 2. A tooltip over the page hides it, and closing it brings the page back.
  await open('tooltip-over');
  await shown(false, 'Tooltip over');
  await open('none');
  await shown(true, 'Tooltip over, closed');

  // 3. A Settings-style dialog hides the page, wherever its box sits.
  await open('dialog');
  await mounted('[data-slot="dialog-overlay"]', 'Dialog');
  await shown(false, 'Dialog');
  await open('none');
  await shown(true, 'Dialog, closed');

  // 4. On a narrow window, the bottom drawer hides the page too.
  host.setContentSize(390, 800);
  await shown(true, 'Narrow');
  await open('drawer');
  await mounted('[data-slot="drawer-overlay"]', 'Drawer');
  await shown(false, 'Drawer');
  await open('none');
  await shown(true, 'Drawer, closed');

  await browser.close();
  await bridge.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  host.destroy();
  console.log(
    'Embedded page: stays for a tooltip elsewhere; steps aside for a tooltip over it, a dialog and a drawer, and comes back after each.'
  );
}
main()
  .then(() => app.exit(0))
  .catch((error) => {
    console.error(error);
    app.exit(1);
  });
