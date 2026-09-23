import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import {
  test,
  expect,
  request as playwrightRequest,
  type BrowserContext,
  type Page,
} from '@playwright/test';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Pool } from 'pg';
import { createCommunityApp } from '../src/app.js';
import { parseConfig } from '../src/config.js';
import { migrate } from '../src/migrate.js';
import { bootstrapFirstHost } from '../src/__tests__/bootstrap-test-helper.js';

// Erasing yourself, in the browser (specs/community-member-erasure task 1.1): both flows say
// what erasure cannot reach, owners are told to transfer first, the account panel names what
// you own, the banner's Cancel undoes a request, and communities you left offer erasure.
// COMMUNITY_ERASURE_SCREENSHOTS optionally names a directory for reviewable screenshots.
const { COMMUNITY_TEST_DATABASE_URL: adminUrl, COMMUNITY_ERASURE_SCREENSHOTS: shots } = process.env;
if (!adminUrl)
  throw new Error('COMMUNITY_TEST_DATABASE_URL is required for community browser tests');
const dbName = `community_browser_erasure_${randomUUID().replaceAll('-', '')}`;
const dbUrl = new URL(adminUrl);
dbUrl.pathname = `/${dbName}`;
const admin = new Pool({ connectionString: adminUrl });
const password = 'password1234';
const cannotReach =
  "We can't reach copies on other people's computers, including files they downloaded and anything their agents saved, or the host's backups for as long as it keeps them.";
let pool: Pool;
let server: ReturnType<typeof serve>;
let baseUrl: string;
let blobDir: string;
let communityId: string;
let operatorCookie: string;

async function freePort() {
  const socket = createServer();
  await new Promise<void>((resolve) => socket.listen(0, '127.0.0.1', resolve));
  const address = socket.address();
  if (!address || typeof address === 'string') throw new Error('No browser test port');
  await new Promise<void>((resolve) => socket.close(() => resolve()));
  return address.port;
}

/** Capture one state at desktop and phone width when screenshots are asked for. */
async function shot(page: Page, name: string) {
  if (!shots) return;
  for (const [label, size] of [
    ['desktop', { width: 1440, height: 900 }],
    ['mobile', { width: 390, height: 844 }],
  ] as const) {
    await page.setViewportSize(size);
    await page.screenshot({ path: join(shots, `${name}-${label}.png`), fullPage: true });
  }
}

function post(path: string, body: unknown, cookie = '') {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { origin: baseUrl, 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  });
}

/** Admit a brand-new account through the production invitation protocol, off-screen. */
async function admitNewAccount(name: string, email: string) {
  const issued = await post(
    `/api/v1/communities/${communityId}/invites`,
    { seats: 1 },
    operatorCookie
  );
  expect(issued.status).toBe(201);
  const { token } = (await issued.json()) as { token: string };
  const api = await playwrightRequest.newContext({
    baseURL: baseUrl,
    extraHTTPHeaders: { origin: baseUrl },
  });
  try {
    const tenant = `/api/v1/communities/${communityId}`;
    expect((await api.post(`${tenant}/invites/preflight`, { data: { token } })).ok()).toBe(true);
    expect(
      (await api.post('/api/auth/sign-up/email', { data: { name, email, password } })).ok()
    ).toBe(true);
    expect((await api.post(`${tenant}/invites/bind`, { data: {} })).ok()).toBe(true);
    const redeemed = await api.post(`${tenant}/invites/redeem`, { data: {} });
    expect(redeemed.ok()).toBe(true);
    return ((await redeemed.json()) as { memberId: string }).memberId;
  } finally {
    await api.dispose();
  }
}

/** The page must fit a phone: nothing may scroll sideways at 390 pixels. */
async function assertFitsPhone(page: Page) {
  const original = page.viewportSize();
  await page.setViewportSize({ width: 390, height: 844 });
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth
  );
  expect(overflow).toBeLessThanOrEqual(0);
  if (original) await page.setViewportSize(original);
}

async function signIn(context: BrowserContext, email: string) {
  const response = await context.request.post(`${baseUrl}/api/auth/sign-in/email`, {
    headers: { origin: baseUrl },
    data: { email, password },
  });
  expect(response.ok()).toBe(true);
}

test.beforeAll(async () => {
  await admin.query(`CREATE DATABASE ${dbName}`);
  await migrate(dbUrl.toString());
  pool = new Pool({ connectionString: dbUrl.toString() });
  blobDir = await mkdtemp(join(tmpdir(), 'community-browser-erasure-'));
  const port = await freePort();
  baseUrl = `http://127.0.0.1:${port}`;
  const config = parseConfig({
    COMMUNITY_DATABASE_URL: dbUrl.toString(),
    COMMUNITY_AUTH_SECRET: 'a'.repeat(32),
    COMMUNITY_INVITE_SECRET: 'b'.repeat(32),
    COMMUNITY_BOOTSTRAP_SECRET: 'c'.repeat(32),
    COMMUNITY_PUBLIC_URL: baseUrl,
    COMMUNITY_STORAGE_PATH: blobDir,
    COMMUNITY_INVITE_PREVIEW_ATTEMPTS_PER_MINUTE: 100,
  });
  const app = createCommunityApp({ config, pool });
  const staticRoot = fileURLToPath(new URL('../dist/', import.meta.url));
  app.use('/assets/*', serveStatic({ root: staticRoot }));
  for (const path of ['/', '/c/:communityId', '/c/:communityId/*'])
    app.get(
      path,
      serveStatic({ path: fileURLToPath(new URL('../dist/index.html', import.meta.url)) })
    );
  server = serve({ fetch: app.fetch, port, hostname: '127.0.0.1' });
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const setup = await bootstrapFirstHost(post, {
    secret: config.bootstrapSecret,
    accountName: 'Host Operator',
    email: 'operator@erasure.test',
    password,
    communityName: 'Erasure Place',
    channelName: 'general',
  });
  operatorCookie = setup.cookie;
  communityId = setup.communityId;
});

test.afterAll(async () => {
  if (server) {
    if ('closeAllConnections' in server) server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  await pool?.end();
  await admin.query(`DROP DATABASE IF EXISTS ${dbName}`);
  await admin.end();
  if (blobDir) await rm(blobDir, { recursive: true, force: true });
});

test.setTimeout(90_000);

test('a member schedules erasure from Manage, sees the banner, and cancels it', async ({
  browser,
}) => {
  await admitNewAccount('Mia', 'mia@erasure.test');
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await signIn(context, 'mia@erasure.test');
    await page.goto(`${baseUrl}/c/${communityId}/settings/account`);
    const panel = page.getByRole('region', { name: 'Erase your messages here' });
    await expect(panel.getByText(cannotReach)).toBeVisible();
    // A current member is told that erasing also ends their membership.
    await expect(
      panel.getByText(
        "When it runs, you'll leave Erasure Place. Anything you post before then is erased too."
      )
    ).toBeVisible();
    const proceed = panel.getByRole('button', { name: 'Continue to erase' });
    await expect(proceed).toHaveAttribute('aria-expanded', 'false');
    await proceed.click();
    // Opening the form moves focus to its first field.
    await expect(panel.getByLabel('Enter Erasure Place')).toBeFocused();
    await assertFitsPhone(page);
    const erase = panel.getByRole('button', { name: 'Erase my messages' });
    await expect(erase).toBeDisabled();
    await panel.getByLabel('Enter Erasure Place').fill('Erasure Place');
    await panel.getByLabel('Confirm password').fill(password);
    await shot(page, 'manage-form');
    await erase.click();
    const banner = page
      .getByRole('status')
      .filter({ hasText: 'Your messages here will be erased on' });
    await expect(banner.first()).toBeVisible();
    await shot(page, 'manage-scheduled');
    await assertFitsPhone(page);
    await banner.first().getByRole('button', { name: 'Cancel' }).click();
    await expect(page.getByText('Your messages here will be erased on')).toHaveCount(0);
    await expect(panel.getByRole('button', { name: 'Continue to erase' })).toBeVisible();
    // Once the worker has started, the request reads as running and offers no cancel.
    await panel.getByRole('button', { name: 'Continue to erase' }).click();
    await panel.getByLabel('Enter Erasure Place').fill('Erasure Place');
    await panel.getByLabel('Confirm password').fill(password);
    await panel.getByRole('button', { name: 'Erase my messages' }).click();
    await expect(page.getByText('Your messages here will be erased on').first()).toBeVisible();
    await pool.query(
      `UPDATE erasure_requests SET state='running',started_at=now()
       WHERE kind='membership' AND state='scheduled' AND community_id=$1`,
      [communityId]
    );
    await page.reload();
    await expect(
      page.getByText('Erasing now. It can no longer be cancelled.').first()
    ).toBeVisible();
    await expect(page.getByRole('button', { name: 'Cancel' })).toHaveCount(0);
  } finally {
    await context.close();
  }
});

test('an owner is told to transfer first, and the account panel names what they own', async ({
  browser,
}) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await signIn(context, 'operator@erasure.test');
    await page.goto(`${baseUrl}/c/${communityId}/settings/account`);
    await expect(
      page.getByText(
        'Transfer ownership or delete the community before you erase your messages here.'
      )
    ).toBeVisible();
    await page.goto(`${baseUrl}/?account`);
    await expect(page.getByRole('heading', { name: 'Delete your account' })).toBeVisible();
    await expect(page.getByText(/You own Erasure Place\. To delete your account/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Delete my account' })).toHaveCount(0);
    await shot(page, 'owner-account');
    await assertFitsPhone(page);
  } finally {
    await context.close();
  }
});

test('a person who left sees the community under "Communities you left" and can erase it', async ({
  browser,
}) => {
  const memberId = await admitNewAccount('Lou', 'lou@erasure.test');
  const removed = await fetch(`${baseUrl}/api/v1/communities/${communityId}/members/${memberId}`, {
    method: 'DELETE',
    headers: { origin: baseUrl, cookie: operatorCookie },
  });
  expect(removed.status).toBe(204);
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await signIn(context, 'lou@erasure.test');
    await page.goto(`${baseUrl}/`);
    const left = page.getByRole('region', { name: 'Communities you left' });
    await expect(left.getByText('Erasure Place')).toBeVisible();
    await left.getByRole('button', { name: 'Erase your messages here' }).click();
    await expect(left.getByText(cannotReach)).toBeVisible();
    await left.getByRole('button', { name: 'Continue to erase' }).click();
    await left.getByLabel('Enter Erasure Place').fill('Erasure Place');
    await left.getByLabel('Confirm password').fill(password);
    await left.getByRole('button', { name: 'Erase my messages' }).click();
    await expect(page.getByText(/Your messages in Erasure Place will be erased on/)).toBeVisible();
    // Deleting the account shows the same sentence about what cannot be reached.
    const account = page.getByRole('region', { name: 'Delete your account' });
    await expect(account.getByText(cannotReach)).toBeVisible();
    await account.getByLabel('Enter your email').fill('lou@erasure.test');
    await account.getByLabel('Confirm password').fill(password);
    await account.getByRole('button', { name: 'Delete my account' }).click();
    await expect(page.getByText(/Your account will be deleted on/)).toBeVisible();
    await shot(page, 'left-and-account');
    await assertFitsPhone(page);
  } finally {
    await context.close();
  }
});
