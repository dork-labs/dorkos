import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { test, expect, type Browser, type Page } from '@playwright/test';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Pool } from 'pg';
import { createCommunityApp } from '../src/app.js';
import { parseConfig } from '../src/config.js';
import { migrate } from '../src/migrate.js';
import { bootstrapFirstHost } from '../src/__tests__/bootstrap-test-helper.js';

// Host links (task 6.1 of specs/community-host-operator-api): Terms and Privacy under the sign-in
// form, all three in account settings, and Report on each message carrying only the community and
// entry IDs. Two servers share one database: one with the links set, one without, so the same
// pages prove both that each link appears where it belongs and that nothing shows when unset.
const { COMMUNITY_TEST_DATABASE_URL: adminUrl } = process.env;
if (!adminUrl)
  throw new Error('COMMUNITY_TEST_DATABASE_URL is required for community browser tests');
const dbName = `community_browser_links_${randomUUID().replaceAll('-', '')}`;
const dbUrl = new URL(adminUrl);
dbUrl.pathname = `/${dbName}`;
const admin = new Pool({ connectionString: adminUrl });
const password = 'password1234';
const TERMS = 'https://example.com/terms';
const PRIVACY = 'https://example.com/privacy';
const REPORT = 'https://example.com/report';
const SECRET_TEXT = 'Do not leak this sentence';
let pool: Pool;
let blobDir: string;
let communityId: string;
let entryId: string;
const servers: ReturnType<typeof serve>[] = [];
let linkedUrl: string;
let plainUrl: string;

async function freePort() {
  const socket = createServer();
  await new Promise<void>((resolve) => socket.listen(0, '127.0.0.1', resolve));
  const address = socket.address();
  if (!address || typeof address === 'string') throw new Error('No browser test port');
  await new Promise<void>((resolve) => socket.close(() => resolve()));
  return address.port;
}

/** Serve the built browser app against the shared database with the given host links. */
async function start(links: Record<string, string>) {
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const config = parseConfig({
    COMMUNITY_DATABASE_URL: dbUrl.toString(),
    COMMUNITY_AUTH_SECRET: 'a'.repeat(32),
    COMMUNITY_INVITE_SECRET: 'b'.repeat(32),
    COMMUNITY_BOOTSTRAP_SECRET: 'c'.repeat(32),
    COMMUNITY_PUBLIC_URL: baseUrl,
    COMMUNITY_STORAGE_PATH: blobDir,
    ...links,
  });
  const app = createCommunityApp({ config, pool });
  const staticRoot = fileURLToPath(new URL('../dist/', import.meta.url));
  app.use('/assets/*', serveStatic({ root: staticRoot }));
  for (const path of ['/', '/c/:communityId', '/c/:communityId/*'])
    app.get(
      path,
      serveStatic({ path: fileURLToPath(new URL('../dist/index.html', import.meta.url)) })
    );
  const server = serve({ fetch: app.fetch, port, hostname: '127.0.0.1' });
  await new Promise<void>((resolve) => server.once('listening', resolve));
  servers.push(server);
  return { baseUrl, config };
}

test.beforeAll(async () => {
  await admin.query(`CREATE DATABASE ${dbName}`);
  await migrate(dbUrl.toString());
  pool = new Pool({ connectionString: dbUrl.toString() });
  blobDir = await mkdtemp(join(tmpdir(), 'community-browser-links-'));
  const linked = await start({
    COMMUNITY_TERMS_URL: TERMS,
    COMMUNITY_PRIVACY_URL: PRIVACY,
    COMMUNITY_REPORT_ABUSE_URL: REPORT,
  });
  linkedUrl = linked.baseUrl;
  plainUrl = (await start({})).baseUrl;
  const post = (path: string, body: unknown, cookie = '') =>
    fetch(`${linkedUrl}${path}`, {
      method: 'POST',
      headers: {
        origin: linkedUrl,
        'content-type': 'application/json',
        ...(cookie ? { cookie } : {}),
      },
      body: JSON.stringify(body),
    });
  const setup = await bootstrapFirstHost(post, {
    secret: linked.config.bootstrapSecret,
    accountName: 'Host Operator',
    email: 'operator@links.test',
    password,
    communityName: 'Linked Place',
    channelName: 'general',
  });
  communityId = setup.communityId;
  const posted = await post(
    `/api/v1/communities/${communityId}/channels/${setup.channelId}/entries`,
    { text: SECRET_TEXT, idempotencyKey: randomUUID() },
    setup.cookie
  );
  expect(posted.status).toBe(201);
  entryId = ((await posted.json()) as { entry: { id: string } }).entry.id;
});

test.afterAll(async () => {
  for (const server of servers) {
    if ('closeAllConnections' in server) server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  await pool?.end();
  await admin.query(`DROP DATABASE IF EXISTS ${dbName}`);
  await admin.end();
  if (blobDir) await rm(blobDir, { recursive: true, force: true });
});

test.setTimeout(90_000);

/** Resolve once the page has read the host's links and they came back empty. */
async function linksAnswered(page: Page) {
  const response = await page.waitForResponse((candidate) =>
    candidate.url().endsWith('/api/v1/host-links')
  );
  expect(await response.json()).toEqual({ termsUrl: null, privacyUrl: null, reportAbuseUrl: null });
}

async function signedInPage(browser: Browser, baseUrl: string): Promise<Page> {
  const context = await browser.newContext();
  const response = await context.request.post(`${baseUrl}/api/auth/sign-in/email`, {
    headers: { origin: baseUrl },
    data: { email: 'operator@links.test', password },
  });
  expect(response.ok()).toBe(true);
  return context.newPage();
}

test('a host with links shows Terms and Privacy at sign-in, all three in settings, and Report on each message', async ({
  browser,
}) => {
  // Fails if a placement is missing, a link points anywhere but the configured page, or the
  // Report address carries anything beyond the community and entry IDs.
  const signedOut = await browser.newPage();
  await signedOut.goto(`${linkedUrl}/c/${communityId}`);
  const policies = signedOut.getByRole('navigation', { name: 'Host policies' });
  await expect(policies.getByRole('link', { name: 'Terms' })).toHaveAttribute('href', TERMS);
  await expect(policies.getByRole('link', { name: 'Privacy' })).toHaveAttribute('href', PRIVACY);
  await expect(policies.getByRole('link', { name: 'Terms' })).toHaveAttribute('target', '_blank');
  await signedOut.close();

  const page = await signedInPage(browser, linkedUrl);
  await page.goto(`${linkedUrl}/c/${communityId}`);
  const message = page.locator('article.entry', { hasText: SECRET_TEXT });
  const report = message.getByRole('link', {
    name: 'Report this message (opens in a new tab)',
    exact: true,
  });
  await expect(report).toHaveAttribute('target', '_blank');
  const href = new URL((await report.getAttribute('href')) ?? '');
  expect(`${href.origin}${href.pathname}`).toBe(REPORT);
  expect([...href.searchParams.entries()]).toEqual([
    ['community', communityId],
    ['entry', entryId],
  ]);
  expect(href.href).not.toContain('leak');

  await page.goto(`${linkedUrl}/c/${communityId}/settings/account`);
  const hostPanel = page.getByRole('region', { name: 'This host' });
  await expect(
    hostPanel.getByRole('link', { name: 'Terms (opens in a new tab)', exact: true })
  ).toHaveAttribute('href', TERMS);
  await expect(hostPanel.getByRole('link', { name: 'Privacy' })).toHaveAttribute('href', PRIVACY);
  await expect(hostPanel.getByRole('link', { name: 'Report a problem' })).toHaveAttribute(
    'href',
    `${REPORT}?community=${communityId}`
  );
  await page.context().close();
});

test('a host without links shows no Terms, Privacy or Report anywhere', async ({ browser }) => {
  // Fails if an unset link renders an empty or placeholder control on any of the three pages.
  const signedOut = await browser.newPage();
  // Wait for the empty answer itself, so the absence below is not just "not loaded yet".
  const answered = linksAnswered(signedOut);
  await signedOut.goto(`${plainUrl}/c/${communityId}`);
  await answered;
  await expect(signedOut.getByRole('heading', { level: 1 })).toBeVisible();
  await expect(signedOut.getByRole('link', { name: /Terms|Privacy|Report/u })).toHaveCount(0);
  await signedOut.close();

  const page = await signedInPage(browser, plainUrl);
  const channelAnswered = linksAnswered(page);
  await page.goto(`${plainUrl}/c/${communityId}`);
  await channelAnswered;
  await expect(page.locator('article.entry', { hasText: SECRET_TEXT })).toBeVisible();
  await expect(page.getByRole('link', { name: /Terms|Privacy|Report/u })).toHaveCount(0);
  const settingsAnswered = linksAnswered(page);
  await page.goto(`${plainUrl}/c/${communityId}/settings/account`);
  await settingsAnswered;
  await expect(page.getByRole('heading', { name: 'This browser' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'This host' })).toHaveCount(0);
  await expect(page.getByRole('link', { name: /Terms|Privacy|Report/u })).toHaveCount(0);
  await page.context().close();
});
