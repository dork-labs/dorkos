import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { test, expect } from '@playwright/test';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Pool } from 'pg';
import { createCommunityApp } from '../src/app.js';
import { parseConfig } from '../src/config.js';
import { migrate } from '../src/migrate.js';

const adminUrl = process.env.COMMUNITY_TEST_DATABASE_URL;
if (!adminUrl)
  throw new Error('COMMUNITY_TEST_DATABASE_URL is required for community browser tests');
const dbName = `community_browser_${randomUUID().replaceAll('-', '')}`;
const dbUrl = new URL(adminUrl);
dbUrl.pathname = `/${dbName}`;
const admin = new Pool({ connectionString: adminUrl });
let pool: Pool;
let server: ReturnType<typeof serve>;
let baseUrl: string;
let communityId: string;

async function freePort() {
  const socket = createServer();
  await new Promise<void>((resolve) => socket.listen(0, '127.0.0.1', resolve));
  const address = socket.address();
  if (!address || typeof address === 'string') throw new Error('Missing browser test port');
  await new Promise<void>((resolve) => socket.close(() => resolve()));
  return address.port;
}

function cookies(response: Response) {
  return response.headers.getSetCookie().map((header) => {
    const pair = header.split(';')[0];
    const equal = pair.indexOf('=');
    return { name: pair.slice(0, equal), value: pair.slice(equal + 1), url: baseUrl };
  });
}

async function post(path: string, body: unknown, cookie = '') {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { origin: baseUrl, 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  });
}

async function pairing(installName: string, selectedCommunityId?: string) {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const prefix = selectedCommunityId ? `/api/v1/communities/${selectedCommunityId}` : '/api/v1';
  const started = await fetch(`${baseUrl}${prefix}/pairings/start`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ installName, challenge, scopes: ['read', 'post', 'enroll-agent'] }),
  });
  expect(started.status).toBe(201);
  return { ...(await started.json()), verifier } as {
    pairingId: string;
    approvalUrl: string;
    verifier: string;
  };
}

test.beforeAll(async () => {
  await admin.query(`CREATE DATABASE ${dbName}`);
  await migrate(dbUrl.toString());
  pool = new Pool({ connectionString: dbUrl.toString() });
  const port = await freePort();
  baseUrl = `http://127.0.0.1:${port}`;
  const config = parseConfig({
    COMMUNITY_DATABASE_URL: dbUrl.toString(),
    COMMUNITY_AUTH_SECRET: 'a'.repeat(32),
    COMMUNITY_INVITE_SECRET: 'b'.repeat(32),
    COMMUNITY_BOOTSTRAP_SECRET: 'c'.repeat(32),
    COMMUNITY_PUBLIC_URL: baseUrl,
    COMMUNITY_STORAGE_PATH: '/tmp/community-browser-test-blobs',
  });
  const app = createCommunityApp({ config, pool });
  const staticRoot = fileURLToPath(new URL('../dist/', import.meta.url));
  app.use('/assets/*', serveStatic({ root: staticRoot }));
  app.get(
    '/pairing',
    serveStatic({ path: fileURLToPath(new URL('../dist/index.html', import.meta.url)) })
  );
  app.get(
    '/c/:communityId/pairing',
    serveStatic({ path: fileURLToPath(new URL('../dist/index.html', import.meta.url)) })
  );
  server = serve({ fetch: app.fetch, port, hostname: '127.0.0.1' });
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const grant = await post('/api/v1/bootstrap/preflight', { secret: config.bootstrapSecret });
  const bootstrap = cookies(grant);
  const bootstrapHeader = bootstrap.map((item) => `${item.name}=${item.value}`).join('; ');
  const completed = await post(
    '/api/v1/bootstrap/complete',
    {
      secret: config.bootstrapSecret,
      accountName: 'Owner',
      email: 'owner@browser.test',
      password: 'password1234',
      communityName: 'Browser test',
      channelName: 'general',
    },
    bootstrapHeader
  );
  expect(completed.status).toBe(201);
  communityId = (await completed.json()).community.id;
});

test.afterAll(async () => {
  await new Promise<void>((resolve) => server?.close(() => resolve()));
  await pool?.end();
  await admin.query(`DROP DATABASE IF EXISTS ${dbName}`);
  await admin.end();
});

test.describe('Community pairing approval @smoke', () => {
  test('shows install and scopes, approves, and keeps code and bearer out of the browser', async ({
    page,
  }) => {
    const { pairingId, approvalUrl, verifier } = await pairing('Kai’s laptop', communityId);
    expect(new URL(approvalUrl).pathname).toMatch(/^\/c\/[0-9a-f-]+\/pairing$/);
    const browserResponses: string[] = [];
    page.on('response', (response) => {
      if (response.url().includes('/api/v1/pairings/')) browserResponses.push(response.url());
    });
    await page.goto(approvalUrl);
    await expect(page.getByText('Sign in to review this connection.')).toBeVisible();
    await expect(page.getByLabel('Email')).toBeFocused();
    await expect(page.getByRole('button', { name: 'Approve connection' })).toHaveCount(0);
    const statusResponse = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname.endsWith(`/pairings/${pairingId}`) &&
        response.status() === 200
    );
    await page.getByLabel('Email').fill('owner@browser.test');
    await page.getByLabel('Password').fill('password1234');
    await page.getByRole('button', { name: 'Sign in and review' }).click();
    const statusBody = await (await statusResponse).text();
    expect(statusBody).not.toMatch(/"(?:code|token)"\s*:/);
    expect(page.url()).toBe(approvalUrl);
    await expect(page.getByRole('heading', { name: 'Connect a local install' })).toBeVisible();
    await expect(page.getByText('Kai’s laptop')).toBeVisible();
    await expect(page.getByText('Read channels')).toBeVisible();
    await expect(page.getByText('Post messages')).toBeVisible();
    await expect(page.getByText('Add your agents')).toBeVisible();
    const approveResponse = page.waitForResponse((response) =>
      new URL(response.url()).pathname.endsWith('/pairings/approve')
    );
    await page.getByRole('button', { name: 'Approve connection' }).click();
    const approveBody = await (await approveResponse).text();
    expect(approveBody).not.toMatch(/"(?:code|token)"\s*:/);
    await expect(page.getByRole('status')).toContainText('Approved');
    const poll = await fetch(`${baseUrl}/api/v1/pairings/poll`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pairingId, verifier }),
    });
    const { code } = await poll.json();
    expect(code).toBeTruthy();
    const exchange = await fetch(`${baseUrl}/api/v1/pairings/exchange`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pairingId, verifier, code }),
    });
    const { token } = await exchange.json();
    expect(token).toHaveLength(43);
    expect(await page.locator('body').textContent()).not.toContain(code);
    expect(await page.locator('body').textContent()).not.toContain(token);
    const browserPollStatus = await page.evaluate(
      async ({ id, secret }) =>
        (
          await fetch('/api/v1/pairings/poll', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ pairingId: id, verifier: secret }),
          })
        ).status,
      { id: pairingId, secret: verifier }
    );
    expect(browserPollStatus).toBe(403);
    expect(browserResponses.every((url) => !url.includes('exchange'))).toBe(true);
  });

  test('declines from a narrow viewport with keyboard-accessible controls', async ({ page }) => {
    const hostileName = '<img src=x onerror=window.__pairingXss=1>';
    const { pairingId, approvalUrl, verifier } = await pairing(hostileName);
    expect(new URL(approvalUrl).pathname).toBe('/pairing');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(approvalUrl);
    await expect(page.getByLabel('Email')).toBeFocused();
    await page.getByLabel('Email').fill('owner@browser.test');
    await page.getByLabel('Password').fill('password1234');
    await page.getByLabel('Password').press('Enter');
    await expect(page.getByText(hostileName)).toBeVisible();
    expect(
      await page.evaluate(() => (window as Window & { __pairingXss?: number }).__pairingXss)
    ).toBeUndefined();
    const approve = page.getByRole('button', { name: 'Approve connection' });
    const decline = page.getByRole('button', { name: 'Decline' });
    await expect(approve).toBeVisible();
    await expect(decline).toBeVisible();
    await page.keyboard.press('Tab');
    await expect(approve).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(decline).toBeFocused();
    await page.screenshot({ path: '/tmp/community-pairing-approval-mobile.png', fullPage: true });
    await decline.click();
    await expect(page.getByRole('status')).toContainText('Connection declined');
    const poll = await fetch(`${baseUrl}/api/v1/pairings/poll`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pairingId, verifier }),
    });
    expect((await poll.json()).status).toBe('cancelled');
    const exchange = await fetch(`${baseUrl}/api/v1/pairings/exchange`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pairingId, verifier, code: randomBytes(32).toString('base64url') }),
    });
    expect(exchange.status).toBe(409);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)
    ).toBe(true);
  });
});
