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
import { hashSecret } from '../src/security.js';

// COMMUNITY_HOST_KEY_SCREENSHOTS optionally names a directory for reviewable screenshots.
const { COMMUNITY_TEST_DATABASE_URL: adminUrl, COMMUNITY_HOST_KEY_SCREENSHOTS: shots } =
  process.env;
if (!adminUrl)
  throw new Error('COMMUNITY_TEST_DATABASE_URL is required for community browser tests');
const dbName = `community_browser_keys_${randomUUID().replaceAll('-', '')}`;
const dbUrl = new URL(adminUrl);
dbUrl.pathname = `/${dbName}`;
const admin = new Pool({ connectionString: adminUrl });
const operator = { email: 'operator@keys.test', password: 'password1234' };
let pool: Pool;
let server: ReturnType<typeof serve>;
let baseUrl: string;
let blobDir: string;

async function freePort() {
  const socket = createServer();
  await new Promise<void>((resolve) => socket.listen(0, '127.0.0.1', resolve));
  const address = socket.address();
  if (!address || typeof address === 'string') throw new Error('No browser test port');
  await new Promise<void>((resolve) => socket.close(() => resolve()));
  return address.port;
}

/** Capture one state at desktop and phone width, then restore the page's own viewport. */
async function shot(page: Page, name: string) {
  if (!shots) return;
  const original = page.viewportSize();
  for (const [label, size] of [
    ['desktop', { width: 1440, height: 900 }],
    ['mobile', { width: 390, height: 844 }],
  ] as const) {
    await page.setViewportSize(size);
    await page.screenshot({ path: join(shots, `${name}-${label}.png`), fullPage: true });
  }
  if (original) await page.setViewportSize(original);
}

test.beforeAll(async () => {
  await admin.query(`CREATE DATABASE ${dbName}`);
  await migrate(dbUrl.toString());
  pool = new Pool({ connectionString: dbUrl.toString() });
  blobDir = await mkdtemp(join(tmpdir(), 'community-browser-keys-'));
  const port = await freePort();
  baseUrl = `http://127.0.0.1:${port}`;
  const config = parseConfig({
    COMMUNITY_DATABASE_URL: dbUrl.toString(),
    COMMUNITY_AUTH_SECRET: 'a'.repeat(32),
    COMMUNITY_INVITE_SECRET: 'b'.repeat(32),
    COMMUNITY_BOOTSTRAP_SECRET: 'c'.repeat(32),
    COMMUNITY_PUBLIC_URL: baseUrl,
    COMMUNITY_STORAGE_PATH: blobDir,
  });
  const app = createCommunityApp({ config, pool });
  const staticRoot = fileURLToPath(new URL('../dist/', import.meta.url));
  app.use('/assets/*', serveStatic({ root: staticRoot }));
  for (const path of ['/', '/host'])
    app.get(
      path,
      serveStatic({ path: fileURLToPath(new URL('../dist/index.html', import.meta.url)) })
    );
  server = serve({ fetch: app.fetch, port, hostname: '127.0.0.1' });
  await new Promise<void>((resolve) => server.once('listening', resolve));

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
  const grant = await post('/api/v1/bootstrap/preflight', { secret: config.bootstrapSecret });
  const cookie = grant.headers
    .getSetCookie()
    .map((header) => header.split(';')[0])
    .join('; ');
  const completed = await post(
    '/api/v1/bootstrap/complete',
    {
      secret: config.bootstrapSecret,
      accountName: 'Host Operator',
      email: operator.email,
      password: operator.password,
      communityName: 'First Place',
      channelName: 'general',
    },
    cookie
  );
  expect(completed.status).toBe(201);
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

test('a host operator creates a key, sees it once, replaces it, and revokes it', async ({
  browser,
}) => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  try {
    const signedIn = await context.request.post(`${baseUrl}/api/auth/sign-in/email`, {
      headers: { origin: baseUrl },
      data: operator,
    });
    expect(signedIn.ok()).toBe(true);
    await page.goto(`${baseUrl}/host`);
    const section = page.getByRole('region', { name: 'API keys' });
    await expect(section.getByText('No keys yet.')).toBeVisible();

    // A wrong password creates nothing and says why.
    await section.getByLabel('Key name').fill('Provisioning script');
    await section.getByLabel('Create communities').check();
    await section.getByLabel('Your password').fill('not-my-password');
    await section.getByRole('button', { name: 'Create key' }).click();
    await expect(section.getByRole('alert')).toContainText(
      'That password is not right. No key was created.'
    );
    expect((await pool.query('SELECT 1 FROM host_api_keys')).rowCount).toBe(0);

    await section.getByLabel('Your password').fill(operator.password);
    await section.getByRole('button', { name: 'Create key' }).click();
    const secretField = section.getByLabel('API key', { exact: true });
    await expect(secretField).toHaveValue(/^dkh_[A-Za-z0-9_-]{43}$/);
    const secret = await secretField.inputValue();
    const stored = await pool.query<{ secret_hash: string; scopes: string[] }>(
      'SELECT secret_hash,scopes FROM host_api_keys'
    );
    expect(stored.rows).toEqual([
      { secret_hash: hashSecret(secret), scopes: ['communities:read', 'communities:write'] },
    ]);
    const card = section.getByRole('article', { name: 'Provisioning script key' });
    await expect(card).toContainText(secret.slice(0, 10));
    await expect(card).toContainText('Created by Host Operator');
    await expect(card).toContainText('Expires');
    await expect(card).not.toContainText(secret.slice(10));
    await shot(page, 'host-api-key-created');

    // The secret is not in the page after a reload.
    await page.reload();
    await expect(section.getByRole('article', { name: 'Provisioning script key' })).toBeVisible();
    await expect(page.locator('body')).not.toContainText(secret.slice(10));

    await section
      .getByRole('article', { name: 'Provisioning script key' })
      .getByRole('button', { name: 'Replace' })
      .click();
    const replace = page.getByRole('dialog', { name: 'Replace “Provisioning script”?' });
    await replace.getByLabel('Your password').fill(operator.password);
    await replace.getByRole('button', { name: 'Replace key' }).click();
    await expect(replace).toBeHidden();
    await expect(section.getByLabel('API key', { exact: true })).not.toHaveValue(secret);
    await expect(section).toContainText('The key it replaces stops working');
    await expect(section.getByRole('article', { name: 'Provisioning script key' })).toHaveCount(2);

    const live = section
      .getByRole('article', { name: 'Provisioning script key' })
      .filter({ has: page.getByRole('button', { name: 'Revoke' }) });
    await live.first().getByRole('button', { name: 'Revoke' }).click();
    const revoke = page.getByRole('dialog', { name: 'Revoke “Provisioning script”?' });
    await expect(revoke).toContainText('lose access right away');
    await expect(revoke.getByRole('button', { name: 'Cancel' })).toBeVisible();
    await shot(page, 'host-api-key-revoke');
    await revoke.getByRole('button', { name: 'Revoke key' }).click();
    await expect(section.getByRole('status')).toContainText('Revoked “Provisioning script”');
    expect(
      (await pool.query('SELECT 1 FROM host_api_keys WHERE revoked_at IS NOT NULL')).rowCount
    ).toBe(1);
  } finally {
    await context.close();
  }
});
