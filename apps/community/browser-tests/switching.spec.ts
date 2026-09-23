/**
 * Community switching row of the tenant isolation matrix (spec
 * `community-tenancy-contract`): switching from A to B closes A's live event
 * stream before the browser asks B for anything. Observed in the order the host
 * itself saw requests arrive and streams end, not inferred from navigation code.
 */
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
import { bootstrapFirstHost, responseCookies } from '../src/__tests__/bootstrap-test-helper.js';

const adminUrl = process.env.COMMUNITY_TEST_DATABASE_URL;
if (!adminUrl)
  throw new Error('COMMUNITY_TEST_DATABASE_URL is required for community browser tests');
const dbName = `community_browser_switch_${randomUUID().replaceAll('-', '')}`;
const dbUrl = new URL(adminUrl);
dbUrl.pathname = `/${dbName}`;
const admin = new Pool({ connectionString: adminUrl });
let pool: Pool;
let server: ReturnType<typeof serve>;
let baseUrl = '';
let blobDir = '';
const serverLog: { kind: 'start' | 'end'; path: string }[] = [];

async function freePort() {
  const socket = createServer();
  await new Promise<void>((resolve) => socket.listen(0, '127.0.0.1', resolve));
  const address = socket.address();
  if (!address || typeof address === 'string') throw new Error('No browser test port');
  await new Promise<void>((resolve) => socket.close(() => resolve()));
  return address.port;
}

async function post(path: string, body: unknown, cookie = '') {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: {
      origin: baseUrl,
      'content-type': 'application/json',
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify(body),
  });
}

test.beforeAll(async () => {
  await admin.query(`CREATE DATABASE ${dbName}`);
  await migrate(dbUrl.toString());
  pool = new Pool({ connectionString: dbUrl.toString() });
  blobDir = await mkdtemp(join(tmpdir(), 'community-browser-switch-'));
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
  for (const path of ['/', '/c/:communityId'])
    app.get(
      path,
      serveStatic({ path: fileURLToPath(new URL('../dist/index.html', import.meta.url)) })
    );
  // The server records, in arrival order, every request start and every event
  // stream end, so the order is what the host observed rather than what the page
  // intended.
  server = serve({
    fetch: async (request, env) => {
      const path = new URL(request.url).pathname;
      serverLog.push({ kind: 'start', path });
      const response = await app.fetch(request, env);
      if (!path.endsWith('/events') || !response.body) return response;
      const reader = response.body.getReader();
      const ended = () => serverLog.push({ kind: 'end', path });
      const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          const part = await reader.read();
          if (part.done) {
            ended();
            controller.close();
          } else controller.enqueue(part.value);
        },
        cancel(reason) {
          ended();
          return reader.cancel(reason);
        },
      });
      return new Response(body, response);
    },
    port,
    hostname: '127.0.0.1',
  });
  await new Promise<void>((resolve) => server.once('listening', resolve));
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

test.setTimeout(60_000);

test('switching from A to B ends the A event stream before any B request', async ({ browser }) => {
  // One account that belongs to two communities on one host, each with its own history.
  const host = await bootstrapFirstHost((path, body, cookie) => post(path, body, cookie), {
    secret: 'c'.repeat(32),
    accountName: 'Switcher',
    email: 'switcher@ui.test',
    password: 'password1234',
    communityName: 'Alpha Place',
  });
  const created = await post(
    '/api/v1/host/communities',
    {
      idempotencyKey: 'beta',
      name: 'Beta Place',
      description: null,
      admissionPolicy: 'invite_only',
    },
    host.cookie
  );
  expect(created.status).toBe(201);
  const { community: beta, ownerClaimToken } = await created.json();
  const preflight = await post('/api/v1/owner-claims/preflight', { token: ownerClaimToken });
  expect(preflight.status).toBe(200);
  const claim = await post(
    '/api/v1/owner-claims/claim',
    {},
    `${host.cookie}; ${responseCookies(preflight)}`
  );
  expect(claim.status).toBe(200);
  const alpha = host.communityId;
  const betaRoom = await post(
    `/api/v1/communities/${beta.id}/channels`,
    { name: 'beta-room', visibility: 'public' },
    host.cookie
  );
  expect(betaRoom.status).toBe(201);
  const betaChannel = (await betaRoom.json()).channel.id;
  for (const [communityId, channelId, text] of [
    [alpha, host.channelId, 'Only said in Alpha'],
    [beta.id, betaChannel, 'Only said in Beta'],
  ]) {
    const posted = await post(
      `/api/v1/communities/${communityId}/channels/${channelId}/entries`,
      { text, idempotencyKey: text },
      host.cookie
    );
    expect(posted.status).toBe(201);
  }

  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await page.goto(baseUrl);
    await page.getByLabel('Email').fill('switcher@ui.test');
    await page.getByLabel('Password').fill('password1234');
    await page.getByRole('button', { name: 'Sign in', exact: true }).last().click();
    await expect(page.getByRole('heading', { name: 'Choose a community' })).toBeVisible();
    const alphaStream = page.waitForRequest(
      (request) =>
        new URL(request.url()).pathname ===
        `/api/v1/communities/${alpha}/channels/${host.channelId}/events`
    );
    await page.getByRole('button', { name: /Alpha Place/ }).click();
    await expect(page).toHaveURL(`${baseUrl}/c/${alpha}`);
    await alphaStream;
    await expect(page.getByText('Only said in Alpha')).toBeVisible();

    // From here on, read the order in which the host saw requests start and streams end.
    const mark = serverLog.length;

    await page.getByRole('button', { name: 'Switch community' }).click();
    await expect(page.getByRole('heading', { name: 'Choose a community' })).toBeVisible();
    await page.getByRole('button', { name: /Beta Place/ }).click();
    await expect(page).toHaveURL(`${baseUrl}/c/${beta.id}`);
    await expect(page.getByText('Only said in Beta')).toBeVisible();
    await expect(page.getByText('Only said in Alpha')).toHaveCount(0);

    const log = serverLog.slice(mark);
    const alphaPrefix = `/api/v1/communities/${alpha}/`;
    const betaPrefix = `/api/v1/communities/${beta.id}/`;
    const alphaStreamEnd = log.findIndex(
      (entry) =>
        entry.kind === 'end' && entry.path.startsWith(alphaPrefix) && entry.path.endsWith('/events')
    );
    const firstBeta = log.findIndex(
      (entry) => entry.kind === 'start' && entry.path.startsWith(betaPrefix)
    );
    expect(alphaStreamEnd, JSON.stringify(log)).toBeGreaterThanOrEqual(0);
    expect(firstBeta, JSON.stringify(log)).toBeGreaterThan(alphaStreamEnd);
    // Nothing asks Alpha for data once Beta has been asked.
    expect(
      log
        .slice(firstBeta)
        .filter((entry) => entry.kind === 'start' && entry.path.startsWith(alphaPrefix))
    ).toEqual([]);
    // Beta opens its own stream.
    expect(
      log.some(
        (entry) =>
          entry.kind === 'start' && entry.path === `${betaPrefix}channels/${betaChannel}/events`
      )
    ).toBe(true);
  } finally {
    await context.close();
  }
});
