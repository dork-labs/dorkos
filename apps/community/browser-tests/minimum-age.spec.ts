import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { test, expect, type Page } from '@playwright/test';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Pool } from 'pg';
import { createCommunityApp } from '../src/app.js';
import { parseConfig } from '../src/config.js';
import { migrate } from '../src/migrate.js';

// DOR-2554: a host's optional minimum age on the Community's own sign-up. Two servers share one
// database: one with COMMUNITY_MINIMUM_AGE=18, one without, so the same pages prove the line and
// the box appear, and hold back an account, only when the host set an age.
const { COMMUNITY_TEST_DATABASE_URL: adminUrl } = process.env;
if (!adminUrl)
  throw new Error('COMMUNITY_TEST_DATABASE_URL is required for community browser tests');
const dbName = `community_browser_age_${randomUUID().replaceAll('-', '')}`;
const dbUrl = new URL(adminUrl);
dbUrl.pathname = `/${dbName}`;
const admin = new Pool({ connectionString: adminUrl });
const password = 'password1234';
const BOOTSTRAP_SECRET = 'c'.repeat(32);
const RULE = 'You must be at least 18 to join.';
let pool: Pool;
let blobDir: string;
const servers: ReturnType<typeof serve>[] = [];
let agedUrl: string;
let plainUrl: string;

async function freePort() {
  const socket = createServer();
  await new Promise<void>((resolve) => socket.listen(0, '127.0.0.1', resolve));
  const address = socket.address();
  if (!address || typeof address === 'string') throw new Error('No browser test port');
  await new Promise<void>((resolve) => socket.close(() => resolve()));
  return address.port;
}

/** Serve the built browser app against the shared database with the given settings. */
async function start(env: Record<string, string>) {
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const config = parseConfig({
    COMMUNITY_DATABASE_URL: dbUrl.toString(),
    COMMUNITY_AUTH_SECRET: 'a'.repeat(32),
    COMMUNITY_INVITE_SECRET: 'b'.repeat(32),
    COMMUNITY_BOOTSTRAP_SECRET: BOOTSTRAP_SECRET,
    COMMUNITY_PUBLIC_URL: baseUrl,
    COMMUNITY_STORAGE_PATH: blobDir,
    ...env,
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
  return baseUrl;
}

async function userCount() {
  const { rows } = await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM "user"');
  return rows[0].n;
}

/** Sign in as the owner on `baseUrl` and issue a one-seat invitation link there. */
async function inviteLink(baseUrl: string) {
  const post = (path: string, body: unknown, cookie = '') =>
    fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: {
        origin: baseUrl,
        'content-type': 'application/json',
        ...(cookie ? { cookie } : {}),
      },
      body: JSON.stringify(body),
    });
  const signIn = await post('/api/auth/sign-in/email', { email: 'owner@age.test', password });
  expect(signIn.status).toBe(200);
  const cookie = signIn.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .join('; ');
  const { rows } = await pool.query<{ id: string }>('SELECT id FROM communities LIMIT 1');
  const issued = await post(`/api/v1/communities/${rows[0].id}/invites`, { seats: 1 }, cookie);
  expect(issued.status).toBe(201);
  const { token } = (await issued.json()) as { token: string };
  return `${baseUrl}/c/${rows[0].id}/join#invite=${encodeURIComponent(token)}`;
}

/** Open an invitation and reach its account form. */
async function openInvitation(page: Page, link: string) {
  await page.goto(link);
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('heading', { name: 'Join Age Place' })).toBeVisible();
}

test.beforeAll(async () => {
  await admin.query(`CREATE DATABASE ${dbName}`);
  await migrate(dbUrl.toString());
  pool = new Pool({ connectionString: dbUrl.toString() });
  blobDir = await mkdtemp(join(tmpdir(), 'community-browser-age-'));
  agedUrl = await start({ COMMUNITY_MINIMUM_AGE: '18' });
  plainUrl = await start({});
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
test.describe.configure({ mode: 'serial' });

test('the first owner must tick the age box before the community is created', async ({
  page,
}, testInfo) => {
  // Fails if first-time setup creates an account without the box, or never shows the line.
  await page.goto(agedUrl);
  await expect(page.getByRole('heading', { name: 'Make it yours.' })).toBeVisible();
  await page.getByLabel('Setup secret').fill(BOOTSTRAP_SECRET);
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByText(RULE)).toBeVisible();
  await page.getByLabel('Your name').fill('Owner');
  await page.getByLabel('Email').fill('owner@age.test');
  await page.getByLabel('Password').fill(password);
  await page.getByLabel('Community name').fill('Age Place');
  const box = page.getByRole('checkbox', { name: 'I am at least 18 years old.' });
  await expect(box).not.toBeChecked();
  await page.screenshot({ path: testInfo.outputPath('owner-setup-age.png'), fullPage: true });

  await page.getByRole('button', { name: 'Create community' }).click();
  // The browser holds the form back on the unticked box; nothing reaches the server.
  expect(await box.evaluate((input: HTMLInputElement) => input.validity.valueMissing)).toBe(true);
  expect(await userCount()).toBe(0);

  await box.check();
  await page.getByRole('button', { name: 'Create community' }).click();
  await expect(page.getByRole('heading', { name: '# general' })).toBeVisible();
  expect(await userCount()).toBe(1);
});

test('an invited person sees the age line and must tick the box before an account is created', async ({
  page,
}, testInfo) => {
  // Fails if the line or box is missing, a provider button can start a sign-up before the box
  // is ticked, or the form creates an account with the box unticked.
  // A provider is offered here only to prove its button waits for the box; it is never clicked.
  await page.route(/\/auth-options$/u, (route) =>
    route.fulfill({ json: { google: true, github: false, oidc: null, minimumAge: 18 } })
  );
  await openInvitation(page, await inviteLink(agedUrl));
  await expect(page.getByText(RULE)).toBeVisible();
  const box = page.getByRole('checkbox', { name: 'I am at least 18 years old.' });
  const google = page.getByRole('button', { name: 'Continue with Google' });
  await expect(google).toBeDisabled();
  await page.getByLabel('Your name').fill('Ada');
  await page.getByLabel('Email').fill('ada@age.test');
  await page.getByLabel('Password').fill(password);
  const before = await userCount();
  await page.getByRole('button', { name: 'Join community' }).click();
  expect(await box.evaluate((input: HTMLInputElement) => input.validity.valueMissing)).toBe(true);
  expect(await userCount()).toBe(before);

  await box.check();
  await expect(google).toBeEnabled();
  await page.screenshot({ path: testInfo.outputPath('invite-age.png'), fullPage: true });
  // Signing in to an existing account asks nothing.
  await page.getByRole('button', { name: 'Sign in to this host' }).click();
  await expect(page.getByText(RULE)).toHaveCount(0);
  await page.getByRole('button', { name: 'Create an account on this host' }).click();
  await expect(box).toBeVisible();
  await page.getByRole('button', { name: 'Join community' }).click();
  await expect(page.getByRole('heading', { name: 'You’re in Age Place.' })).toBeVisible();
  expect(await userCount()).toBe(before + 1);
});

test('with no minimum age set, the invitation page asks nothing and joins as before', async ({
  page,
}) => {
  // Fails if an unset setting shows the line or box, or holds back a sign-up.
  await openInvitation(page, await inviteLink(plainUrl));
  await expect(page.getByLabel('Your name')).toBeVisible();
  await expect(page.getByText(/You must be at least/u)).toHaveCount(0);
  await expect(page.getByRole('checkbox')).toHaveCount(0);
  await page.getByLabel('Your name').fill('Grace');
  await page.getByLabel('Email').fill('grace@age.test');
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Join community' }).click();
  await expect(page.getByRole('heading', { name: 'You’re in Age Place.' })).toBeVisible();
});
