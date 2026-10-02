/* eslint-disable no-restricted-syntax -- The isolated fixture must set its temporary home and origin before importing server singletons. */
import { test, expect } from '../../fixtures';
import express from 'express';
import type { Server } from 'node:http';
import { mkdtemp, realpath, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

let root: string;
let server: Server;
let desktop: Server;
let origin: string;
let desktopOrigin: string;
let servedUrl: string;
let attempts: { method: string; cookie: string | undefined }[] = [];
let writes = 0;
const environmentKeys = [
  'DORK_HOME',
  'NODE_ENV',
  'DORKOS_TEST_RUNTIME',
  'DORKOS_CORS_ORIGIN',
] as const;
let previousEnvironment: (string | undefined)[];

/** A real listener on an OS-assigned port, never an operator/test-leg port. */
async function listen(app: express.Express): Promise<Server> {
  return new Promise((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
}

/** The address actually allocated by the OS. */
function address(listener: Server): string {
  return `http://127.0.0.1:${(listener.address() as AddressInfo).port}`;
}

/** Shut down all connections before deleting the isolated home. */
async function close(listener: Server): Promise<void> {
  listener.closeAllConnections();
  await new Promise<void>((resolve, reject) =>
    listener.close((err) => (err ? reject(err) : resolve()))
  );
}

type ServerModules = {
  app: { createApp: (options: { admission: unknown }) => express.Express };
  'services/core/config-manager': { initConfigManager: (home: string) => unknown };
  'lib/boundary': { initBoundary: (root: string) => Promise<void> };
  'services/core/lifecycle/main-request-admission': { MainRequestAdmission: new () => unknown };
  'services/core/runtime-registry': { runtimeRegistry: { register: (runtime: unknown) => void } };
  'services/runtimes/test-mode/test-mode-runtime': { TestModeRuntime: new () => unknown };
};

/**
 * Load real server source after setting the isolated environment. Keep the
 * package boundary dynamic: e2e's declaration compiler must not try to emit
 * declarations for the server's entire source graph (server typecheck owns it).
 */
async function serverModule<K extends keyof ServerModules>(name: K): Promise<ServerModules[K]> {
  return import(`../../../server/src/${name}.ts`);
}

test.beforeAll(async () => {
  previousEnvironment = environmentKeys.map((key) => process.env[key]);
  attempts = [];
  writes = 0;
  root = await realpath(await mkdtemp(path.join(tmpdir(), 'served-isolation-')));
  process.env.DORK_HOME = path.join(root, 'home');
  process.env.NODE_ENV = 'test';
  process.env.DORKOS_TEST_RUNTIME = 'true';
  const [{ createApp }, { initConfigManager }, { initBoundary }, { MainRequestAdmission }] =
    await Promise.all([
      serverModule('app'),
      serverModule('services/core/config-manager'),
      serverModule('lib/boundary'),
      serverModule('services/core/lifecycle/main-request-admission'),
    ]);
  initConfigManager(process.env.DORK_HOME);
  const [{ runtimeRegistry }, { TestModeRuntime }] = await Promise.all([
    serverModule('services/core/runtime-registry'),
    serverModule('services/runtimes/test-mode/test-mode-runtime'),
  ]);
  runtimeRegistry.register(new TestModeRuntime());
  await initBoundary(root);
  await writeFile(
    path.join(root, 'asset.js'),
    "document.body.dataset.asset = 'loaded'; console.log('isolation-shim-control');"
  );
  await writeFile(path.join(root, 'style.css'), 'body { color: rgb(1, 2, 3) }');
  const attack = `async function probe() {
    const result = {};
    for (const [name, read] of Object.entries({cookie: () => document.cookie,
      storage: () => localStorage.getItem('operator'), app: () => opener.document.body.dataset.operator})) {
      try { result[name] = read(); } catch { result[name] = 'blocked'; }
    }
    for (const method of ['GET', 'POST']) {
      try { result[method] = await (await fetch('/api/isolation-control', {method, credentials:'include'})).text(); }
      catch { result[method] = 'blocked'; }
    }
    document.body.dataset.results = JSON.stringify(result);
  } probe();`;
  await writeFile(
    path.join(root, 'index.html'),
    `<html><head><link rel="stylesheet" href="style.css"></head><body><h1>Served document</h1><script src="asset.js"></script><script>${attack}</script></body></html>`
  );
  await writeFile(
    path.join(root, 'image.svg'),
    `<svg xmlns="http://www.w3.org/2000/svg"><script><![CDATA[
    fetch('/api/isolation-control', {credentials:'include'}).then(r => r.text()).then(t => document.documentElement.setAttribute('data-result', t)).catch(() => document.documentElement.setAttribute('data-result','blocked'));
  ]]></script></svg>`
  );
  const app = createApp({ admission: new MainRequestAdmission() });
  app.get('/isolation-host', (_req, res) =>
    res.send('<body data-operator="private"><h1>App control</h1></body>')
  );
  app.all('/api/isolation-control', (req, res) => {
    if (req.method === 'POST') writes++;
    res.send('operator-secret');
  });
  // Count at ingress, before the real application's CORS rejection. A zero
  // endpoint count alone could mean the hostile script never ran.
  const counted = express();
  counted.use((req, _res, next) => {
    if (req.path === '/api/isolation-control')
      attempts.push({ method: req.method, cookie: req.headers.cookie });
    next();
  });
  counted.use(app);
  server = await listen(counted);
  origin = address(server);
  const desktopApp = express();
  desktopApp.get('/', (_req, res) => res.send('<body><h1>Desktop origin control</h1></body>'));
  desktop = await listen(desktopApp);
  desktopOrigin = address(desktop);
  process.env.DORKOS_CORS_ORIGIN = desktopOrigin;
  const signed = await fetch(`${origin}/api/workbench/sign`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind: 'serve', cwd: root }),
  });
  expect(signed.status).toBe(200);
  servedUrl = (await signed.json()).url;
});

test.afterAll(async () => {
  if (desktop) await close(desktop);
  if (server) await close(server);
  if (root) await rm(root, { recursive: true, force: true });
  environmentKeys.forEach((key, index) => {
    if (previousEnvironment[index] === undefined) delete process.env[key];
    else process.env[key] = previousEnvironment[index];
  });
});

test('direct HTML navigation cannot read/write the app, cookies, storage or opener @smoke', async ({
  page,
  context,
}) => {
  await page.goto(`${origin}/isolation-host`);
  await context.addCookies([{ name: 'operator', value: 'private', url: origin }]);
  await page.evaluate(() => localStorage.setItem('operator', 'private'));
  // Positive control runs inside Chromium, through exactly the same real app.
  expect(await page.evaluate(async () => (await fetch('/api/isolation-control')).text())).toBe(
    'operator-secret'
  );
  expect(
    await page.evaluate(async () =>
      (await fetch('/api/isolation-control', { method: 'POST' })).text()
    )
  ).toBe('operator-secret');
  expect(writes).toBe(1);
  attempts = [];
  const popupPromise = context.waitForEvent('page');
  await page.evaluate((url) => window.open(url), servedUrl);
  const popup = await popupPromise;
  await expect(popup.locator('body')).toHaveAttribute('data-results', /POST/);
  const results = await popup.locator('body').getAttribute('data-results');
  expect(JSON.parse(results!)).toEqual({
    cookie: 'blocked',
    storage: 'blocked',
    app: 'blocked',
    GET: 'blocked',
    POST: 'blocked',
  });
  expect(attempts.map((attempt) => attempt.method)).toEqual(['GET', 'POST']);
  expect(attempts.every((attempt) => attempt.cookie === undefined)).toBe(true);
  expect(writes).toBe(1);
  await expect(popup.locator('body')).toHaveAttribute('data-asset', 'loaded');
  expect(await popup.locator('body').evaluate((body) => getComputedStyle(body).color)).toBe(
    'rgb(1, 2, 3)'
  );
});

test('direct SVG navigation is opaque too @smoke', async ({ page }) => {
  attempts = [];
  await page.goto(servedUrl.replace('index.html', 'image.svg'));
  await expect(page.locator('svg')).toHaveAttribute('data-result', 'blocked');
  expect(attempts.map((attempt) => attempt.method)).toEqual(['GET']);
});

test('app and desktop iframe origins render assets and run the actual injected shim @smoke', async ({
  page,
}) => {
  for (const host of [`${origin}/isolation-host`, desktopOrigin]) {
    await page.goto(host);
    await page.evaluate((url) => {
      (window as unknown as { reports: unknown[] }).reports = [];
      window.addEventListener('message', (event) => {
        (window as unknown as { reports: unknown[] }).reports.push(event.data);
        if (event.data?.__dorkosDevtools === 'hello') {
          (event.source as Window).postMessage({ __dorkosDevtools: 'ack' }, '*');
        }
      });
      const frame = document.createElement('iframe');
      frame.title = 'Served document';
      frame.sandbox.add('allow-scripts', 'allow-forms', 'allow-popups', 'allow-modals');
      frame.src = url;
      document.body.append(frame);
    }, servedUrl);
    const frame = page.frameLocator('iframe');
    await expect(frame.getByRole('heading', { name: 'Served document' })).toBeVisible();
    await expect(frame.locator('body')).toHaveAttribute('data-asset', 'loaded');
    await expect
      .poll(() =>
        page.evaluate(() => JSON.stringify((window as unknown as { reports: unknown[] }).reports))
      )
      .toContain('isolation-shim-control');
  }
});

test('an untrusted embedding origin is refused @smoke', async ({ page }) => {
  const untrusted = await listen(
    express().get('/', (_req, res) => res.send('<body>Untrusted host</body>'))
  );
  try {
    await page.goto(address(untrusted));
    await page.evaluate((url) => {
      const frame = document.createElement('iframe');
      frame.src = url;
      document.body.append(frame);
    }, servedUrl);
    await expect
      .poll(
        () =>
          page.frames().filter((frame) => frame.url() === 'chrome-error://chromewebdata/').length
      )
      .toBe(1);
  } finally {
    await close(untrusted);
  }
});

test('an already-open legacy host receives telemetry, action and capture from the new shim @smoke', async ({
  page,
}) => {
  const lib = await readFile(
    path.resolve(process.cwd(), '../client/node_modules/html-to-image/dist/html-to-image.js'),
    'utf8'
  );
  await page.goto(`${origin}/isolation-host`);
  await page.evaluate((url) => {
    (window as unknown as { reports: unknown[] }).reports = [];
    window.addEventListener('message', (event) => {
      (window as unknown as { reports: unknown[] }).reports.push(event.data);
      if (event.data?.__dorkosDevtools === 'hello')
        (event.source as Window).postMessage({ __dorkosDevtools: 'ack' }, '*');
    });
    const frame = document.createElement('iframe');
    frame.sandbox.add('allow-scripts', 'allow-forms');
    frame.src = url;
    document.body.append(frame);
  }, servedUrl);
  await expect
    .poll(() =>
      page.evaluate(() => JSON.stringify((window as unknown as { reports: unknown[] }).reports))
    )
    .toContain('isolation-shim-control');
  await page.evaluate((lib) => {
    const child = document.querySelector('iframe')!.contentWindow!;
    child.postMessage(
      {
        __dorkosDevtools: 'act-request',
        requestId: 'legacy-action',
        command: { action: 'read_page', maxChars: 4000 },
      },
      '*'
    );
    child.postMessage(
      { __dorkosDevtools: 'capture-request', requestId: 'legacy-capture', lib },
      '*'
    );
  }, lib);
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const reports = (
            window as unknown as {
              reports: {
                requestId?: string;
                ok?: boolean;
                outline?: string;
                dataUrl?: string;
                bridgeGeneration?: string;
              }[];
            }
          ).reports;
          const action = reports.find((r) => r.requestId === 'legacy-action');
          const capture = reports.find((r) => r.requestId === 'legacy-capture');
          return {
            action: action?.ok,
            outline: action?.outline?.includes('Served document'),
            capture: capture?.dataUrl?.startsWith('data:image/png;base64,'),
            legacy:
              action?.bridgeGeneration === undefined && capture?.bridgeGeneration === undefined,
          };
        }),
      { timeout: 15000 }
    )
    .toEqual({ action: true, outline: true, capture: true, legacy: true });
});
