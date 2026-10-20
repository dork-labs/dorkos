import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import {
  securityHeaders,
  servePage,
} from '../../server/src/services/spaces/headers/security-headers.js';
import { takeViolations, test, expect } from './csp.js';

// The page's one inline script, under the page's real policy (DOR-2957): it takes a link's
// secret out of the address bar before the bundle loads, and it is the only inline script the
// policy lets run. The built page is served as the space server serves it; no database is needed.
let server: ReturnType<typeof serve>;
let baseURL: string;
test.beforeAll(async () => {
  const root = fileURLToPath(new URL('../dist/', import.meta.url));
  const app = new Hono().use('*', securityHeaders());
  app.use('/assets/*', serveStatic({ root }));
  app.get('*', servePage(join(root, 'index.html')));
  await new Promise<void>((resolve) => {
    server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, (address) => {
      baseURL = `http://127.0.0.1:${address.port}`;
      resolve();
    });
  });
});
test.afterAll(
  () => new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())))
);

const SECRET = 'claim-secret-0123456789';

test('a link secret leaves the address bar before the bundle has loaded', async ({ page }) => {
  // Purpose: fails if the fragment stays in the address bar while the bundle downloads, which is
  // when a screenshot, a copied address or an extension could still read it.
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  let bundleAsked = false;
  await page.route(/\/assets\/.+\.js$/u, async (route) => {
    bundleAsked = true;
    await held;
    await route.continue();
  });
  await page.goto(`${baseURL}/claim#claim=${SECRET}`, { waitUntil: 'commit' });
  await expect.poll(() => bundleAsked).toBe(true);
  await expect.poll(() => page.evaluate(() => window.location.href)).toBe(`${baseURL}/claim`);
  // The bundle has not run: nothing is rendered and nothing has read the secret yet.
  expect(
    await page.evaluate(() => ({
      rendered: document.getElementById('root')?.childElementCount ?? -1,
      reader: typeof (window as unknown as Record<string, unknown>).__readDorkosOwnerClaimFragment,
      held: (window as unknown as Record<string, unknown>).__dorkosLinkFragment,
    }))
  ).toEqual({ rendered: 0, reader: 'undefined', held: `claim=${SECRET}` });

  release();
  await expect
    .poll(() =>
      page.evaluate(() => {
        const read = (window as unknown as Record<string, () => string | null>)
          .__readDorkosOwnerClaimFragment;
        return typeof read === 'function' ? read() : null;
      })
    )
    .toBe(SECRET);
  expect(await page.evaluate(() => '__dorkosLinkFragment' in (window as unknown as object))).toBe(
    false
  );
  expect(page.url()).toBe(`${baseURL}/claim`);
});

test('an inline script the policy does not name by its hash never runs', async ({ page }) => {
  // Purpose: fails if the policy lets inline script in beyond its one hashed script, which would
  // let script written into a page run as its reader.
  await page.route(`${baseURL}/`, async (route) => {
    const response = await route.fetch();
    const html = (await response.text()).replace(
      '<div id="root"></div>',
      '<div id="root"></div><script>window.__unhashed = true;</script>'
    );
    await route.fulfill({ response, body: html });
  });
  await page.goto(`${baseURL}/#invite=not-a-secret`);
  const seen: string[] = [];
  await expect
    .poll(() => {
      seen.push(...takeViolations());
      return seen.join('\n');
    })
    .toContain('script-src-elem blocked inline');
  expect(
    await page.evaluate(() => ({
      unhashed: (window as unknown as Record<string, unknown>).__unhashed,
      hash: window.location.hash,
    }))
  ).toEqual({ unhashed: undefined, hash: '' });
  // The page refused that one script and nothing else; the hashed one ran.
  await page.waitForTimeout(250);
  seen.push(...takeViolations());
  expect(seen.length).toBeGreaterThan(0);
  for (const line of seen)
    expect(line).toMatch(/script-src-elem blocked inline|Executing inline script violates/u);
});
