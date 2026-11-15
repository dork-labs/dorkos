/** CI-only native witness: no real profiles, sign-ins or outside websites. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { app, BrowserWindow, webContents } from 'electron';
import { chromium } from 'playwright-core';
import { startLocalBrowserBridge } from '../../src/main/local-browser';

const receipts = new Map<
  string,
  (value: { headers: Record<string, unknown>; js: Record<string, unknown> }) => void
>();
const echo = createServer((request, response) => {
  const phase = new URL(request.url!, 'http://localhost').searchParams.get('phase')!;
  if (request.method === 'POST') {
    let body = '';
    request.on('data', (chunk) => {
      body += chunk;
    });
    request.on('end', () => {
      receipts.get(phase)?.({ headers: request.headers, js: JSON.parse(body) });
      response.end('saved');
    });
  } else {
    response.setHeader('Content-Type', 'text/html');
    response.setHeader('Accept-CH', 'Sec-CH-UA-Full-Version-List, Sec-CH-UA-Platform-Version');
    response.end(`<h1>Made-up browser check</h1><script>
      fetch(location.href, { method: 'POST', body: JSON.stringify({
        ua: navigator.userAgent, brands: navigator.userAgentData?.brands,
        platform: navigator.userAgentData?.platform, webdriver: navigator.webdriver
      }) });
    </script>`);
  }
});

async function main(): Promise<void> {
  assert.equal(process.env.CI, 'true', 'Native browser witness is CI-only');
  assert.equal(process.platform, 'darwin');
  await app.whenReady();
  await new Promise<void>((resolve) => echo.listen(0, '127.0.0.1', resolve));
  const address = echo.address();
  assert(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  const host = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
  const bridge = await startLocalBrowserBridge(
    () => origin,
    () => host
  );
  const endpoint = process.env.DORKOS_LOCAL_BROWSER_BRIDGE!;
  const headers = {
    Authorization: `Bearer ${process.env.DORKOS_LOCAL_BROWSER_BRIDGE_TOKEN!}`,
    'Content-Type': 'application/json',
  };
  const call = async (operation: string) => {
    const response = await fetch(`${endpoint}/${operation}`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ connectionId: 'native-witness' }),
    });
    assert.equal(response.status, 200);
    return response;
  };
  const opened = (await (await call('open')).json()) as {
    endpoint: string;
    headers: Record<string, string>;
  };
  const guest = webContents
    .getAllWebContents()
    .find((contents) => contents.id !== host.webContents.id)!;
  assert(guest);
  let browser = await chromium.connectOverCDP(opened.endpoint, {
    headers: opened.headers,
    noDefaults: true,
  });
  assert.equal(guest.debugger.isAttached(), true);
  const observe = async (phase: string, attached: boolean) => {
    const receipt = new Promise<{ headers: Record<string, unknown>; js: Record<string, unknown> }>(
      (resolve) => receipts.set(phase, resolve)
    );
    // Native host navigation is the test witness, never a production agent channel.
    await guest.loadURL(`${origin}/?phase=${phase}`);
    const found = await receipt;
    assert.equal(guest.debugger.isAttached(), attached);
    for (const ua of [found.headers['user-agent'], found.js.ua]) {
      assert.equal(typeof ua, 'string');
      assert.doesNotMatch(String(ua), /electron|dorkos/i);
      assert.match(
        String(ua),
        new RegExp(`Chrome/${process.versions.chrome.split('.')[0]}\\.0\\.0\\.0`)
      );
    }
    const brands = found.js.brands as { brand: string; version: string }[];
    assert(
      brands?.some(
        (item) =>
          item.brand === 'Chromium' && item.version === process.versions.chrome.split('.')[0]
      )
    );
    assert(!brands.some((item) => /electron|dorkos|Google Chrome/i.test(item.brand)));
    const hint = String(found.headers['sec-ch-ua']);
    assert(hint.includes(`"Chromium";v="${process.versions.chrome.split('.')[0]}"`));
    assert.doesNotMatch(hint, /electron|dorkos|Google Chrome/i);
    assert.equal(found.js.platform, 'macOS');
    if (!attached) assert.equal(found.js.webdriver, false);
  };
  await observe('agent-before', true);
  await call('detach');
  await browser.close();
  assert(webContents.getAllWebContents().every((contents) => !contents.debugger.isAttached()));
  await observe('person', false);
  // A remembered page endpoint cannot attach during the person's handoff.
  await assert.rejects(
    chromium.connectOverCDP(opened.endpoint, {
      headers: opened.headers,
      timeout: 1000,
      noDefaults: true,
    })
  );
  await call('reattach');
  browser = await chromium.connectOverCDP(opened.endpoint, {
    headers: opened.headers,
    noDefaults: true,
  });
  await observe('agent-after', true);
  await call('detach');
  await browser.close();
  await observe('stopped', false);
  assert(webContents.getAllWebContents().every((contents) => !contents.debugger.isAttached()));
  await call('close');
  await bridge.close();
  await new Promise<void>((resolve) => echo.close(() => resolve()));
  host.destroy();
  console.log(
    'Embedded guest: reduced UA and hints agree; detached during handoff and Stop; fresh CDP after hand-back.'
  );
}
main()
  .then(() => app.exit(0))
  .catch((error) => {
    console.error(error);
    app.exit(1);
  });
