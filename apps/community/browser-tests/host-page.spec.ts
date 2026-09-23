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

// COMMUNITY_HOST_PAGE_SCREENSHOTS optionally names a directory for reviewable screenshots.
const { COMMUNITY_TEST_DATABASE_URL: adminUrl, COMMUNITY_HOST_PAGE_SCREENSHOTS: shots } =
  process.env;
if (!adminUrl)
  throw new Error('COMMUNITY_TEST_DATABASE_URL is required for community browser tests');
const dbName = `community_browser_host_${randomUUID().replaceAll('-', '')}`;
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
  // Phone first: most of these pages load at phone width, and resizing a loaded page up and
  // back down can leave the channel drawer open, which no one loading it on a phone would see.
  for (const [label, size] of [
    ['mobile', { width: 390, height: 844 }],
    ['desktop', { width: 1440, height: 900 }],
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
  blobDir = await mkdtemp(join(tmpdir(), 'community-browser-host-'));
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
  for (const path of ['/', '/host', '/c/:communityId', '/c/:communityId/*'])
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

test('a host operator sets a community limit beside its current use, on a phone', async ({
  browser,
}) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  try {
    const signedIn = await context.request.post(`${baseUrl}/api/auth/sign-in/email`, {
      headers: { origin: baseUrl },
      data: operator,
    });
    expect(signedIn.ok()).toBe(true);
    await page.goto(`${baseUrl}/host`);
    const record = page.getByRole('article', { name: 'First Place community' });
    await record.getByText('Limits', { exact: true }).click();
    const form = record.getByRole('form', { name: 'First Place limits' });
    await expect(form).toContainText('1 now');
    await expect(form.getByLabel('Most members')).toHaveValue('');
    await form.getByLabel('Most members').fill('1');
    await form.getByLabel('Most file space (MiB)').fill('5');
    await form.getByRole('button', { name: 'Save limits' }).click();
    await expect(form).toContainText('Limits saved.');
    const stored = await pool.query(
      'SELECT max_active_members,max_storage_bytes::int AS bytes FROM community_limits'
    );
    expect(stored.rows).toEqual([{ max_active_members: 1, bytes: 5 * 1024 * 1024 }]);
    await shot(page, 'host-community-limits');
    // Empty means no limit again.
    await form.getByLabel('Most members').fill('');
    await form.getByLabel('Most file space (MiB)').fill('');
    await form.getByRole('button', { name: 'Save limits' }).click();
    await expect
      .poll(async () => (await pool.query('SELECT max_active_members FROM community_limits')).rows)
      .toEqual([{ max_active_members: null }]);
  } finally {
    await context.close();
  }
});

test('an invitation to a full community says so before sign-up, and that the link still works', async ({
  browser,
}) => {
  const communityId = (await pool.query<{ id: string }>('SELECT id FROM communities')).rows[0].id;
  const ownerContext = await browser.newContext();
  const guest = await browser.newContext({ viewport: { width: 390, height: 844 } });
  try {
    const signedIn = await ownerContext.request.post(`${baseUrl}/api/auth/sign-in/email`, {
      headers: { origin: baseUrl },
      data: operator,
    });
    expect(signedIn.ok()).toBe(true);
    const invite = await ownerContext.request.post(
      `${baseUrl}/api/v1/communities/${communityId}/invites`,
      { headers: { origin: baseUrl }, data: { seats: 1 } }
    );
    expect(invite.status()).toBe(201);
    const { token } = (await invite.json()) as { token: string };
    await pool.query(
      `INSERT INTO community_limits(community_id,max_active_members) VALUES($1,1)
       ON CONFLICT(community_id) DO UPDATE SET max_active_members=1`,
      [communityId]
    );

    const page = await guest.newPage();
    await page.goto(`${baseUrl}/c/${communityId}/join#invite=${encodeURIComponent(token)}`);
    await page.getByRole('button', { name: 'Continue' }).click();
    const alert = page.getByRole('alert');
    await expect(alert).toContainText('This community is full. Ask its owner to make room.');
    await expect(alert).toContainText(
      'Your invitation still works. Open it again once the owner has made room.'
    );
    await expect(alert).not.toContainText('new invitation link');
    await expect(page.getByLabel('Password')).toHaveCount(0);
    await shot(page, 'join-full-community');
  } finally {
    await pool.query('DELETE FROM community_limits');
    await ownerContext.close();
    await guest.close();
  }
});

test('a host holds a community with a notice members can see, then deletes it after the notice', async ({
  browser,
}) => {
  const communityId = (
    await pool.query<{ id: string }>("SELECT id FROM communities WHERE name='First Place'")
  ).rows[0].id;
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  try {
    const signedIn = await context.request.post(`${baseUrl}/api/auth/sign-in/email`, {
      headers: { origin: baseUrl },
      data: operator,
    });
    expect(signedIn.ok()).toBe(true);
    await page.goto(`${baseUrl}/host`);
    const record = page.getByRole('article', { name: 'First Place community' });
    await record.getByRole('button', { name: 'Hold', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Hold First Place?' });
    const notice = new Date(Date.now() + 20 * 24 * 60 * 60_000).toISOString().slice(0, 10);
    await dialog.getByLabel('Delete after (optional)').fill(notice);
    await dialog.getByRole('button', { name: 'Hold community' }).click();
    await expect(record).toContainText('On hold. Deletion notice:');

    // Members see the hold and the date on every channel, and cannot post.
    await page.goto(`${baseUrl}/c/${communityId}`);
    const banner = page.getByRole('status').filter({ hasText: 'You can read it but not post.' });
    await expect(banner).toContainText(
      'This community is on hold by its host. You can read it but not post.'
    );
    await expect(banner).toContainText('The host plans to delete it after');
    await expect(banner).toContainText('The owner can export it until then.');
    await expect(
      page.getByText('This community is on hold by its host, so no one can post.')
    ).toBeVisible();
    await shot(page, 'held-community-banner');

    // The owner's settings explain the hold and keep export within reach.
    await page.goto(`${baseUrl}/c/${communityId}/settings`);
    await expect(page.getByRole('heading', { name: 'On hold' }).first()).toBeVisible();
    await expect(
      page.getByText(/Archive, restore, and ownership transfer are unavailable/u)
    ).toBeVisible();
    await expect(page.getByRole('button', { name: 'Export community' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Archive community' })).toHaveCount(0);
    await shot(page, 'held-owner-settings');

    // Once the notice date has passed, the host can delete it, confirming the id's end.
    await pool.query(
      "UPDATE communities SET deletion_notice_at=now()-interval '1 minute' WHERE id=$1",
      [communityId]
    );
    await page.goto(`${baseUrl}/host`);
    await record.getByRole('button', { name: 'Delete', exact: true }).click();
    const confirm = page.getByRole('dialog', { name: 'Delete First Place?' });
    await expect(confirm.getByRole('button', { name: 'Delete community' })).toBeDisabled();
    await confirm.getByLabel(/Type the last eight characters/u).fill(communityId.slice(-8));
    await confirm.getByRole('button', { name: 'Delete community' }).click();
    await expect(record).toContainText('Deletion requested by the host.');
    // The owner sees who started it, cannot cancel it, and is told export has ended.
    await page.goto(`${baseUrl}/c/${communityId}/deletion`);
    await expect(page.getByText(/The host started this deletion/u)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Cancel deletion' })).toHaveCount(0);
    await shot(page, 'host-deletion-owner-view');
    await page.goto(`${baseUrl}/host`);
    await record.getByRole('button', { name: 'Cancel deletion' }).click();
    await expect(record).toContainText('On hold.');
    await record.getByRole('button', { name: 'Release hold' }).click();
    await expect(record.getByRole('button', { name: 'Hold', exact: true })).toBeVisible();
  } finally {
    await context.close();
  }
});

test('saving limits leaves a file-space limit set through the API exactly as it was', async ({
  browser,
}) => {
  // Purpose: the form shows MiB rounded to two places; saving it after changing only the member
  // limit must not rewrite 10,000,000 bytes as the rounded 9.54 MiB.
  const communityId = (
    await pool.query<{ id: string }>("SELECT id FROM communities WHERE name='First Place'")
  ).rows[0].id;
  await pool.query(
    `INSERT INTO community_limits(community_id,max_active_members,max_storage_bytes)
     VALUES($1,NULL,10000000)
     ON CONFLICT(community_id) DO UPDATE SET max_active_members=NULL,max_storage_bytes=10000000`,
    [communityId]
  );
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    const signedIn = await context.request.post(`${baseUrl}/api/auth/sign-in/email`, {
      headers: { origin: baseUrl },
      data: operator,
    });
    expect(signedIn.ok()).toBe(true);
    await page.goto(`${baseUrl}/host`);
    const record = page.getByRole('article', { name: 'First Place community' });
    await record.getByText('Limits', { exact: true }).click();
    const form = record.getByRole('form', { name: 'First Place limits' });
    await expect(form.getByLabel('Most file space (MiB)')).toHaveValue('9.54');
    await form.getByLabel('Most members').fill('50');
    await form.getByRole('button', { name: 'Save limits' }).click();
    await expect(form).toContainText('Limits saved.');
    const stored = await pool.query(
      'SELECT max_active_members,max_storage_bytes::bigint::text AS bytes FROM community_limits WHERE community_id=$1',
      [communityId]
    );
    expect(stored.rows).toEqual([{ max_active_members: 50, bytes: '10000000' }]);
  } finally {
    await pool.query('DELETE FROM community_limits');
    await context.close();
  }
});
