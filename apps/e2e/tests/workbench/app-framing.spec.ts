/* eslint-disable no-restricted-syntax -- The isolated fixture must set its temporary home before importing server singletons. */
/**
 * DOR-3370, in a real Chromium against the real front door: a page on another
 * origin cannot frame DorkOS, while DorkOS's own page still shows a PDF in a
 * frame (the canvas's native PDF viewer).
 */
import { test, expect } from '../../fixtures';
import express from 'express';
import { createServer, type RequestListener, type Server } from 'node:http';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

// The full Chromium, not the headless shell: only it has the PDF viewer, and a
// shell frame of a PDF downloads instead of loading, which proves nothing.
// `playwright install chromium` (CI's install step) installs both.
test.use({ channel: 'chromium' });

let root: string;
let server: Server;
let origin: string;
const environmentKeys = ['DORK_HOME', 'NODE_ENV', 'DORKOS_TEST_RUNTIME'] as const;
let previousEnvironment: (string | undefined)[];

/** The smallest PDF a viewer opens: one empty page. */
const PDF = Buffer.from(
  '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n' +
    '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n' +
    '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\n' +
    'trailer<</Root 1 0 R>>\n%%EOF\n'
);

/** A real listener on an OS-assigned port, never an operator/test-leg port. */
async function listen(app: RequestListener): Promise<Server> {
  return new Promise((resolve) => {
    const listener = createServer(app).listen(0, '127.0.0.1', () => resolve(listener));
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

/** The slice of a Hono context the control routes use. */
type HonoContext = {
  html: (body: string) => Response;
  body: (data: Uint8Array, status: number, headers: Record<string, string>) => Response;
};

type ServerModules = {
  'services/core/config-manager': { initConfigManager: (home: string) => unknown };
  'lib/boundary': { initBoundary: (root: string) => Promise<void> };
  'services/core/lifecycle/main-request-admission': { MainRequestAdmission: new () => unknown };
  'http/hono-api': {
    composeFrontDoor: (admission: unknown) => {
      get: (path: string, handler: (c: HonoContext) => Response) => unknown;
    };
  };
  'http/front-door': { frontDoorListener: (app: unknown) => RequestListener };
};

/** Load real server source after setting the isolated environment. */
async function serverModule<K extends keyof ServerModules>(name: K): Promise<ServerModules[K]> {
  return import(`../../../server/src/${name}.ts`);
}

type Page = import('@playwright/test').Page;

/** Put a frame of `url` on the page now open. */
async function addFrame(page: Page, url: string): Promise<void> {
  await page.evaluate((src) => {
    const frame = document.createElement('iframe');
    frame.src = src;
    document.body.append(frame);
  }, url);
}

/** How many frames Chromium replaced with its error page (a refused frame). */
function refusedFrames(page: Page): number {
  return page.frames().filter((frame) => frame.url() === 'chrome-error://chromewebdata/').length;
}

test.beforeAll(async () => {
  previousEnvironment = environmentKeys.map((key) => process.env[key]);
  root = await realpath(await mkdtemp(path.join(tmpdir(), 'app-framing-')));
  process.env.DORK_HOME = path.join(root, 'home');
  process.env.NODE_ENV = 'test';
  process.env.DORKOS_TEST_RUNTIME = 'true';
  const [{ initConfigManager }, { initBoundary }, { MainRequestAdmission }] = await Promise.all([
    serverModule('services/core/config-manager'),
    serverModule('lib/boundary'),
    serverModule('services/core/lifecycle/main-request-admission'),
  ]);
  initConfigManager(process.env.DORK_HOME);
  await initBoundary(root);
  const [{ composeFrontDoor }, { frontDoorListener }] = await Promise.all([
    serverModule('http/hono-api'),
    serverModule('http/front-door'),
  ]);
  const app = composeFrontDoor(new MainRequestAdmission());
  app.get('/framing-host', (c) => c.html('<body><h1>App control</h1></body>'));
  app.get('/framing-control.pdf', (c) =>
    c.body(new Uint8Array(PDF), 200, { 'Content-Type': 'application/pdf' })
  );
  server = await listen(frontDoorListener(app));
  origin = address(server);
});

test.afterAll(async () => {
  if (server) await close(server);
  if (root) await rm(root, { recursive: true, force: true });
  environmentKeys.forEach((key, index) => {
    if (previousEnvironment[index] === undefined) delete process.env[key];
    else process.env[key] = previousEnvironment[index];
  });
});

test('a page on another origin cannot frame DorkOS @smoke', async ({ page }) => {
  const outsider = await listen(
    express().get('/', (_req, res) =>
      res.send('<body>Another site</body>')
    ) as unknown as RequestListener
  );
  try {
    for (const target of ['/framing-host', '/api/health', '/framing-control.pdf']) {
      await page.goto(address(outsider));
      await addFrame(page, `${origin}${target}`);
      await expect.poll(() => refusedFrames(page), { message: target }).toBe(1);
    }
  } finally {
    await close(outsider);
  }
});

test('DorkOS’s own page still shows a PDF in a frame @smoke', async ({ page }) => {
  const pdfUrl = `${origin}/framing-control.pdf`;
  await page.goto(`${origin}/framing-host`);
  await addFrame(page, pdfUrl);
  const child = () => page.frames().find((frame) => frame !== page.mainFrame());
  await expect.poll(() => child()?.url()).toBe(pdfUrl);
  await expect.poll(() => child()?.evaluate(() => document.contentType)).toBe('application/pdf');
  expect(refusedFrames(page)).toBe(0);
});

test('a refused answer says so to old browsers too, and the PDF allowance does not', async () => {
  const refused = await fetch(`${origin}/api/health`);
  expect(refused.headers.get('x-frame-options')).toBe('DENY');
  await refused.arrayBuffer();
  const pdf = await fetch(`${origin}/framing-control.pdf`);
  expect(pdf.headers.get('x-frame-options')).toBeNull();
  expect(pdf.headers.get('content-security-policy')).toMatch(/frame-ancestors 'self'/);
  await pdf.arrayBuffer();
});
