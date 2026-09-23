import { createHash, randomBytes, randomUUID } from 'node:crypto';
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
  type Locator,
  type Page,
} from '@playwright/test';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Pool } from 'pg';
import { createCommunityApp } from '../src/app.js';
import { parseConfig } from '../src/config.js';
import { migrate } from '../src/migrate.js';
import { bootstrapFirstHost } from '../src/__tests__/bootstrap-test-helper.js';

// Account controls (task 2.3) of specs/community-membership-journeys: sign out this browser,
// disconnect one installation, disconnect all of them. COMMUNITY_ACCOUNT_SCREENSHOTS optionally
// names a directory for reviewable desktop and phone screenshots of every state.
const { COMMUNITY_TEST_DATABASE_URL: adminUrl, COMMUNITY_ACCOUNT_SCREENSHOTS: shots } = process.env;
if (!adminUrl)
  throw new Error('COMMUNITY_TEST_DATABASE_URL is required for community browser tests');
const dbName = `community_browser_account_${randomUUID().replaceAll('-', '')}`;
const dbUrl = new URL(adminUrl);
dbUrl.pathname = `/${dbName}`;
const admin = new Pool({ connectionString: adminUrl });
const password = 'password1234';
let pool: Pool;
let server: ReturnType<typeof serve>;
let baseUrl: string;
let blobDir: string;
let communityId: string;
let operatorMemberId: string;
let operatorCookie: string;

async function freePort() {
  const socket = createServer();
  await new Promise<void>((resolve) => socket.listen(0, '127.0.0.1', resolve));
  const address = socket.address();
  if (!address || typeof address === 'string') throw new Error('No browser test port');
  await new Promise<void>((resolve) => socket.close(() => resolve()));
  return address.port;
}

/**
 * Capture one state at desktop and phone width, then restore the page's own viewport. Settings
 * scroll inside their own pane, so `target` names what must be in view at phone width.
 */
async function shot(page: Page, name: string, target?: Locator) {
  if (!shots) return;
  const original = page.viewportSize();
  for (const [label, size] of [
    ['desktop', { width: 1440, height: 900 }],
    ['mobile', { width: 390, height: 844 }],
  ] as const) {
    await page.setViewportSize(size);
    // Let the phone layout's off-canvas navigation finish sliding away before capturing.
    await page.waitForTimeout(400);
    await target?.scrollIntoViewIfNeeded();
    await page.screenshot({ path: join(shots, `${name}-${label}.png`), fullPage: true });
  }
  if (original) await page.setViewportSize(original);
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

/** Record a connected installation the way a completed pairing leaves it. */
async function connectInstallation(memberId: string, installName: string, scopes: string[]) {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO connection_grants(community_id,member_id,token_hash,scopes,install_name)
     VALUES($1,$2,$3,$4,$5) RETURNING id`,
    [
      communityId,
      memberId,
      createHash('sha256').update(randomBytes(32)).digest('hex'),
      scopes,
      installName,
    ]
  );
  return rows[0].id;
}

async function revoked(grantId: string) {
  const { rows } = await pool.query<{ revoked: boolean }>(
    'SELECT revoked_at IS NOT NULL AS revoked FROM connection_grants WHERE id=$1',
    [grantId]
  );
  return rows[0].revoked;
}

async function signIn(context: BrowserContext, email: string) {
  const response = await context.request.post(`${baseUrl}/api/auth/sign-in/email`, {
    headers: { origin: baseUrl },
    data: { email, password },
  });
  expect(response.ok()).toBe(true);
}

/** Run an action that opens a confirmation, answer it, and return what it said. */
async function confirming(page: Page, accept: boolean, action: () => Promise<void>) {
  let message: string | null = null;
  page.once('dialog', async (dialog) => {
    message = dialog.type() === 'confirm' ? dialog.message() : `unexpected ${dialog.type()}`;
    if (accept) await dialog.accept();
    else await dialog.dismiss();
  });
  await action();
  await expect.poll(() => message).not.toBeNull();
  return message as unknown as string;
}

test.beforeAll(async () => {
  await admin.query(`CREATE DATABASE ${dbName}`);
  await migrate(dbUrl.toString());
  pool = new Pool({ connectionString: dbUrl.toString() });
  blobDir = await mkdtemp(join(tmpdir(), 'community-browser-account-'));
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
    email: 'operator@account.test',
    password,
    communityName: 'First Place',
    channelName: 'general',
  });
  operatorCookie = setup.cookie;
  communityId = setup.communityId;
  operatorMemberId = setup.memberId;
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

test('installations disconnect one at a time or all at once, and membership stays', async ({
  browser,
}) => {
  const rinId = await admitNewAccount('Rin', 'rin@account.test');
  const laptop = await connectInstallation(rinId, 'Rin laptop', ['read', 'post', 'enroll-agent']);
  const desktop = await connectInstallation(rinId, 'Rin desktop', ['read', 'post']);
  const studio = await connectInstallation(rinId, 'Studio Mac', ['read']);
  const neighbour = await connectInstallation(operatorMemberId, 'Operator laptop', ['read']);
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  try {
    await signIn(context, 'rin@account.test');
    await page.goto(`${baseUrl}/c/${communityId}/settings/account`);
    const installations = page.getByRole('list', { name: 'Connected installations' });
    await expect(installations.getByRole('listitem')).toHaveCount(3);
    await expect(installations).toContainText('Can read, post and add agents');
    await expect(page.getByRole('heading', { name: 'This browser' })).toBeVisible();
    await expect(
      page.getByText(/Ends:.*every installation and agent you connected here/u)
    ).toBeVisible();
    await expect(page.getByText(/Stays:.*your account, your other communities/u)).toBeVisible();
    await shot(page, 'account-installations');

    // Changing your mind at the confirmation disconnects nothing.
    expect(
      await confirming(page, false, () =>
        page.getByRole('button', { name: 'Disconnect Studio Mac' }).click()
      )
    ).toMatch(/^Disconnect Studio Mac\?/u);
    await expect(installations.getByRole('listitem')).toHaveCount(3);
    expect(await revoked(studio)).toBe(false);

    // One installation: the confirmation names what ends and that membership stays.
    expect(
      await confirming(page, true, () =>
        page.getByRole('button', { name: 'Disconnect Studio Mac' }).click()
      )
    ).toBe(
      'Disconnect Studio Mac? It can no longer read or post in First Place until it is connected again. You stay a member.'
    );
    await expect(page.getByRole('status')).toHaveText(
      'Studio Mac is disconnected. It can no longer read or post here until it is connected again.'
    );
    await expect(installations.getByRole('listitem')).toHaveCount(2);
    await expect(page.getByRole('heading', { name: 'Connected installations' })).toBeFocused();
    expect(await revoked(studio)).toBe(true);
    expect(await revoked(laptop)).toBe(false);

    // All of them: a wrong password is refused and says nothing changed.
    const allPassword = page.locator('#disconnect-all-password');
    await expect(page.getByRole('button', { name: 'Disconnect all installations' })).toBeDisabled();
    await allPassword.fill('not-my-password');
    expect(await confirming(page, true, () => allPassword.press('Enter'))).toBe(
      'Disconnect all 2 installations? They can no longer read or post in First Place until they are connected again. You stay a member, and this browser stays signed in.'
    );
    await expect(page.getByRole('alert')).toHaveText(
      'That password is not right. Nothing was disconnected.'
    );
    expect(await revoked(laptop)).toBe(false);
    expect(await revoked(desktop)).toBe(false);
    await shot(page, 'account-disconnect-all-refused', page.getByRole('alert'));

    await allPassword.fill(password);
    expect(
      await confirming(page, true, () =>
        page.getByRole('button', { name: 'Disconnect all installations' }).click()
      )
    ).toMatch(/^Disconnect all 2 installations\?/u);
    await expect(page.getByRole('status')).toHaveText(
      'All installations are disconnected. They can no longer read or post here until they are connected again.'
    );
    await expect(
      page.getByText('No DorkOS installations are connected to your account here.')
    ).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Connected installations' })).toBeFocused();
    await expect(page.getByRole('button', { name: 'Disconnect all installations' })).toHaveCount(0);
    expect(await revoked(laptop)).toBe(true);
    expect(await revoked(desktop)).toBe(true);
    // Another member's installation is not this person's to end.
    expect(await revoked(neighbour)).toBe(false);
    // Still a member, still signed in.
    await expect(page.getByRole('heading', { name: 'Leave community' })).toBeVisible();
    expect(
      (await context.request.get(`${baseUrl}/api/v1/communities/${communityId}/me`)).ok()
    ).toBe(true);
    await shot(page, 'account-all-disconnected');
  } finally {
    await context.close();
  }
});

test('signing out ends this browser only, from settings and from the chooser', async ({
  browser,
}) => {
  await admitNewAccount('Sam', 'sam@account.test');
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const laptop = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await laptop.newPage();
  try {
    await signIn(laptop, 'sam@account.test');
    await signIn(phone, 'sam@account.test');
    await page.goto(`${baseUrl}/c/${communityId}/settings/account`);
    await expect(
      page.getByText(
        'Signing out ends your sign-in on this browser only. You stay a member, and your connected DorkOS installations keep working.'
      )
    ).toBeVisible();
    expect(await page.evaluate(() => localStorage.getItem('communityLastAuthorizedId'))).toBe(
      communityId
    );
    await page.getByRole('button', { name: 'Sign out of this browser' }).click();
    const signedOut = page.getByRole('heading', { name: 'You signed out of this browser.' });
    await expect(signedOut).toBeFocused();
    await expect(page.getByText('Your memberships did not change.')).toBeVisible();
    await shot(page, 'signed-out');
    // This browser forgot its session and its remembered community; the phone did not.
    expect(await page.evaluate(() => localStorage.getItem('communityLastAuthorizedId'))).toBeNull();
    expect((await laptop.request.get(`${baseUrl}/api/v1/memberships`)).status()).toBe(401);
    expect((await phone.request.get(`${baseUrl}/api/v1/memberships`)).status()).toBe(200);
    await page.getByRole('button', { name: 'Sign in again' }).click();
    await expect(page).toHaveURL(`${baseUrl}/`);

    // The chooser offers the same control, by keyboard.
    const phonePage = await phone.newPage();
    await phonePage.goto(`${baseUrl}/c/${randomUUID()}`);
    await expect(phonePage.getByRole('heading', { name: 'Choose a community' })).toBeFocused();
    await shot(phonePage, 'chooser-sign-out');
    const signOut = phonePage.getByRole('button', { name: 'Sign out of this browser' });
    await signOut.focus();
    await phonePage.keyboard.press('Enter');
    await expect(
      phonePage.getByRole('heading', { name: 'You signed out of this browser.' })
    ).toBeFocused();
    expect((await phone.request.get(`${baseUrl}/api/v1/memberships`)).status()).toBe(401);
  } finally {
    await laptop.close();
    await phone.close();
  }
});
