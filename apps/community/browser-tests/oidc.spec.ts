import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { test, expect } from '@playwright/test';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Pool } from 'pg';
import { createCommunityApp } from '../src/app.js';
import { parseConfig } from '../src/config.js';
import { migrate } from '../src/migrate.js';
import { bootstrapFirstHost } from '../src/__tests__/bootstrap-test-helper.js';
import { startFakeIssuer, type FakeIssuer } from '../src/__tests__/fake-oidc-issuer.js';

// Single sign-on (task 6.2 of specs/community-host-operator-api) in a real browser: the button
// with the host's label, a full redirect through an in-process fake issuer, joining with an
// invitation, adding a password in Settings, and the explicit-linking refusal in plain words.
const { COMMUNITY_TEST_DATABASE_URL: adminUrl } = process.env;
if (!adminUrl)
  throw new Error('COMMUNITY_TEST_DATABASE_URL is required for community browser tests');
const dbName = `community_browser_oidc_${randomUUID().replaceAll('-', '')}`;
const dbUrl = new URL(adminUrl);
dbUrl.pathname = `/${dbName}`;
const admin = new Pool({ connectionString: adminUrl });
const LABEL = 'Example sign-in';
let issuer: FakeIssuer;
let pool: Pool;
let server: ReturnType<typeof serve>;
let baseUrl: string;
let blobDir: string;
let communityId: string;
let ownerCookie: string;

async function freePort() {
  const socket = createServer();
  await new Promise<void>((resolve) => socket.listen(0, '127.0.0.1', resolve));
  const address = socket.address();
  if (!address || typeof address === 'string') throw new Error('No browser test port');
  await new Promise<void>((resolve) => socket.close(() => resolve()));
  return address.port;
}

function post(path: string, body: unknown, cookie = '') {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { origin: baseUrl, 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  });
}

test.beforeAll(async () => {
  issuer = await startFakeIssuer();
  await admin.query(`CREATE DATABASE ${dbName}`);
  await migrate(dbUrl.toString());
  pool = new Pool({ connectionString: dbUrl.toString() });
  blobDir = await mkdtemp(join(tmpdir(), 'community-browser-oidc-'));
  const port = await freePort();
  baseUrl = `http://127.0.0.1:${port}`;
  const config = parseConfig({
    COMMUNITY_DATABASE_URL: dbUrl.toString(),
    COMMUNITY_AUTH_SECRET: 'a'.repeat(32),
    COMMUNITY_INVITE_SECRET: 'b'.repeat(32),
    COMMUNITY_BOOTSTRAP_SECRET: 'c'.repeat(32),
    COMMUNITY_PUBLIC_URL: baseUrl,
    COMMUNITY_STORAGE_PATH: blobDir,
    COMMUNITY_OIDC_ISSUER_URL: issuer.issuer,
    COMMUNITY_OIDC_CLIENT_ID: issuer.clientId,
    COMMUNITY_OIDC_CLIENT_SECRET: issuer.clientSecret,
    COMMUNITY_OIDC_LABEL: LABEL,
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
    email: 'operator@example.com',
    password: 'password1234',
    communityName: 'Single Place',
    channelName: 'general',
  });
  communityId = setup.communityId;
  ownerCookie = setup.cookie;
});

test.afterAll(async () => {
  if (server) {
    if ('closeAllConnections' in server) server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  await issuer?.close();
  await pool?.end();
  await admin.query(`DROP DATABASE IF EXISTS ${dbName}`);
  await admin.end();
  if (blobDir) await rm(blobDir, { recursive: true, force: true });
});

test.setTimeout(90_000);

test('an invited person joins through single sign-on, then adds a password in Settings', async ({
  page,
}) => {
  // Fails if the button is missing or unlabelled, the redirect round trip does not come back to
  // the join, or an account made this way cannot add the password it needs for careful actions.
  const issued = await post(
    `/api/v1/communities/${communityId}/invites`,
    { seats: 1 },
    ownerCookie
  );
  expect(issued.status).toBe(201);
  const { token } = (await issued.json()) as { token: string };
  issuer.identity = {
    sub: 'sso-person',
    email: 'sso-person@example.com',
    email_verified: true,
    name: 'Sso Person',
  };
  await page.goto(`${baseUrl}/c/${communityId}/join#invite=${encodeURIComponent(token)}`);
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByRole('button', { name: `Continue with ${LABEL}` }).click();
  await expect(page.getByRole('heading', { name: 'You’re in Single Place.' })).toBeVisible();
  expect(issuer.requests).toContain('GET /authorize');

  await page.goto(`${baseUrl}/c/${communityId}/settings/account`);
  const panel = page.getByRole('region', { name: 'Sign-in' });
  await expect(panel).toContainText(`You sign in with ${LABEL}.`);
  await panel.getByLabel('New password').fill('new-password-1234');
  await panel.getByRole('button', { name: 'Add password' }).click();
  await expect(panel.getByRole('status')).toHaveText(
    'Password added. You can now sign in with your email and this password.'
  );
  await expect(panel).toContainText(`You sign in with a password and ${LABEL}.`);
  await expect(panel.getByLabel('New password')).toHaveCount(0);
});

test('an issuer identity that matches an existing account is refused, in words that say what to do', async ({
  page,
}) => {
  // Fails if the refusal is silent, shows a raw code, or the account is linked anyway.
  issuer.identity = {
    sub: 'operator-lookalike',
    email: 'operator@example.com',
    email_verified: true,
    name: 'Not the operator',
  };
  await page.goto(`${baseUrl}/c/${communityId}`);
  await page.getByRole('button', { name: `Continue with ${LABEL}` }).click();
  await expect(page.getByRole('alert')).toHaveText(
    'An account with this email already exists here. Sign in with your password, then link single sign-on from Settings, Account.'
  );
  await expect.poll(() => page.evaluate(() => location.search)).toBe('');
  const { rows } = await pool.query<{ providerId: string }>(
    `SELECT a."providerId" FROM account a JOIN "user" u ON u.id=a."userId" WHERE u.email=$1`,
    ['operator@example.com']
  );
  expect(rows.map((row) => row.providerId)).toEqual(['credential']);
});
