/** CI-only loopback witness. Never runs against a real site, account or browser profile. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { BrowserContext } from 'playwright-core';
import { LocalBrowserService } from '../../../server/src/services/session/local-browser/service.js';
import { BrowserHandover } from '../../../server/src/services/session/local-browser/handover.js';
import {
  SignInWindow,
  SIGN_IN_SAVE_TIMEOUT_MS,
} from '../../../server/src/services/session/local-browser/sign-in-window.js';
import { productionBackend } from '../../../server/src/services/session/local-browser/playwright-backend.js';
import { LocalBrowserError } from '../../../server/src/services/session/local-browser/errors.js';

assert.equal(process.env.CI, 'true', 'This native witness runs only in sealed CI');
assert.equal(process.env.DORKOS_TEST_RUNTIME, 'true', 'Use a throwaway test home');
assert(process.env.DORK_HOME, 'QA must supply a fresh DORK_HOME');
assert(process.env.DORKOS_LOCAL_BROWSER_ARTIFACTS, 'QA must supply an artifact directory');
const artifacts = process.env.DORKOS_LOCAL_BROWSER_ARTIFACTS;
await mkdir(artifacts, { recursive: true });
const echo = createServer((request, response) => {
  response.setHeader('Content-Type', 'text/html');
  if (request.url === '/loop') {
    // Deliberately no accessible content or vendor title. Only real navigation events qualify it.
    response.end(
      '<!doctype html><title>Made-up page</title><body><script>' +
        'setTimeout(() => location.reload(), 1000)</script></body>'
    );
  } else if (request.url === '/blank') {
    response.end('<!doctype html><title>Made-up blank page</title><body></body>');
  } else if (request.url === '/popups') {
    response.end(`<!doctype html><title>Made-up popup page</title>
      <a href="/popup-opened" target="_blank">Open page</a><p id="popup-result"></p>
      <script>document.getElementById('popup-result').textContent =
      window.open('/unsolicited') === null ? 'blocked' : 'opened';</script>`);
  } else {
    response.end('<!doctype html><title>Made-up starting page</title><a href="/good">Continue</a>');
  }
});
let context: BrowserContext | undefined;
const backend = {
  ...productionBackend,
  async launch(...args: Parameters<typeof productionBackend.launch>) {
    return (context = await productionBackend.launch(...args));
  },
};
const service = new LocalBrowserService(process.env.DORK_HOME, undefined, backend);
const signIns = new SignInWindow();
const handover = new BrowserHandover(service, signIns, () => process.env.DORK_HOME!);
handover.useOutsideTurnCheck(async () => 'read_outside_text');
try {
  await new Promise<void>((resolve) => echo.listen(0, '127.0.0.1', resolve));
  const address = echo.address();
  assert(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  await service.open({ mode: 'new-window', sessionId: 'made-up-loop-witness', url: origin });
  const page = context!.pages()[0]!;
  const identity = await page.evaluate(() => ({
    webdriver: navigator.webdriver,
    ua: navigator.userAgent,
    cdcProperties: Object.getOwnPropertyNames(window).filter((name) => name.startsWith('cdc_')),
  }));
  assert.equal(identity.webdriver, true, 'The production pipe stays honest about automation');
  assert.deepEqual(identity.cdcProperties, []);
  await page.goto(`${origin}/popups`, { waitUntil: 'domcontentloaded' });
  assert.equal(await page.locator('#popup-result').textContent(), 'blocked');
  const nativeMedia = await page.evaluate(() => ({
    dark: matchMedia('(prefers-color-scheme: dark)').matches,
    reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
    forcedColors: matchMedia('(forced-colors: active)').matches,
    increasedContrast: matchMedia('(prefers-contrast: more)').matches,
  }));
  const popupRead = await service.observe();
  const popupOpened = context!.waitForEvent('page', { timeout: 5_000 });
  const [popup] = await Promise.all([
    popupOpened,
    service.action({
      kind: 'click',
      role: 'link',
      name: 'Open page',
      revision: popupRead.revision,
    }),
  ]);
  await popup.waitForURL(`${origin}/popup-opened`);
  await popup.close();
  await service.selectTab(popupRead.tabId);
  const moved = await service.action({
    kind: 'navigate',
    url: `${origin}/good`,
    revision: (await service.state()).revision,
  });
  assert.equal(moved.tabs.find((tab) => tab.id === moved.selectedTabId)?.url, `${origin}/good`);
  const link = await service.observe();
  const clicked = await service.action({
    kind: 'click',
    role: 'link',
    name: 'Continue',
    revision: link.revision,
  });
  assert.equal(clicked.tabs.find((tab) => tab.id === clicked.selectedTabId)?.url, `${origin}/good`);
  await page.goto(`${origin}/blank`, { waitUntil: 'domcontentloaded' });
  // This delay exercises the product's explicit two-second empty-document grace period.
  await new Promise((resolve) => setTimeout(resolve, 2_000));
  assert.equal((await service.observe()).refusal?.kind, 'blocked');
  // Four real new-document commits within the product's eight-second window.
  const started = performance.now();
  const committed = new Promise<void>((resolve, reject) => {
    let count = 0;
    const timer = setTimeout(() => {
      page.off('framenavigated', onFrame);
      reject(new Error('The looping fixture did not commit four documents within ten seconds'));
    }, 10_000);
    const onFrame = (frame: import('playwright-core').Frame) => {
      if (frame !== page.mainFrame() || page.url() !== `${origin}/loop`) return;
      if (++count < 4) return;
      clearTimeout(timer);
      page.off('framenavigated', onFrame);
      resolve();
    };
    page.on('framenavigated', onFrame);
  });
  await Promise.all([committed, page.goto(`${origin}/loop`, { waitUntil: 'commit' })]);
  const observation = await service.observe();
  assert.equal(observation.refusal?.kind, 'blocked');
  assert.equal(observation.refusal.host, new URL(origin).host);
  const blockedAfterMs = performance.now() - started;
  assert(blockedAfterMs < 10_000, 'A looping page must report blocked inside ten seconds');
  await assert.rejects(
    service.action({
      kind: 'click',
      role: 'link',
      name: 'Continue',
      revision: observation.revision,
    }),
    (error: unknown) => error instanceof LocalBrowserError && error.code === 'stale_page'
  );
  // A context lost during a reload is not evidence of actual fullscreen.
  try {
    await service.requireNotFullScreen();
  } catch (error) {
    assert(error instanceof LocalBrowserError);
    assert.equal(error.code, 'screen_state_unavailable');
  }
  const handed = await handover.ask('made-up-loop-witness', 'wall');
  assert.equal(handed.site, new URL(origin).host);
  assert.equal(signIns.current?.status, 'open');
  assert.equal((await service.state()).status, 'disconnected');
  await writeFile(
    path.join(artifacts, 'reload-wall-result.json'),
    JSON.stringify(
      {
        passed: true,
        nativeMedia,
        unsolicitedPopupBlocked: true,
        gesturePopupOpened: true,
        identity,
        refusal: observation.refusal,
        blockedAfterMs,
        plainWindowOpened: true,
        navigationSucceeded: true,
        clickSucceeded: true,
        emptyAfterLoadBlocked: true,
        realSiteUsed: false,
        realProfileUsed: false,
      },
      null,
      2
    )
  );
} finally {
  try {
    signIns.close();
    const deadline = performance.now() + SIGN_IN_SAVE_TIMEOUT_MS;
    while (signIns.active) {
      assert(performance.now() < deadline, 'The witness must release its plain-window profile');
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  } finally {
    try {
      await service.disconnect();
    } finally {
      echo.closeAllConnections();
      await new Promise<void>((resolve) => echo.close(() => resolve()));
    }
  }
}
