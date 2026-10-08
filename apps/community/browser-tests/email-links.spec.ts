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
import { createBrowserTestPool } from './pool-lifecycle.js';
import { createCommunityApp } from '../src/app.js';
import { parseConfig, type CommunityConfig } from '../src/config.js';
import { migrate } from '../src/migrate.js';
import { emailLinkComposers } from '../src/email-links/composers.js';
import { resolveEmailLinkRequests } from '../src/email-links/resolver.js';
import { deliverNextNotice } from '../src/mail/worker.js';
import { createSmtpTransport } from '../src/mail/transport.js';
import { startSmtpFake, type SmtpFake } from '../src/__tests__/smtp-fake.js';

// DOR-2710: the forgot-password round trip in a real browser. The sign-in form's "Forgot
// password?" asks for a link, the mail lands in an in-process SMTP server, the page the link
// opens takes the token out of the address bar, and a new password signs the browser in.
const { COMMUNITY_TEST_DATABASE_URL: adminUrl } = process.env;
if (!adminUrl)
  throw new Error('COMMUNITY_TEST_DATABASE_URL is required for community browser tests');
const dbName = `community_browser_email_${randomUUID().replaceAll('-', '')}`;
const dbUrl = new URL(adminUrl);
dbUrl.pathname = `/${dbName}`;
const admin = new Pool({ connectionString: adminUrl });
const OLD_PASSWORD = 'old-password-1234';
const NEW_PASSWORD = 'new-password-5678';
const BOOTSTRAP_SECRET = 'c'.repeat(32);
let pool: Pool;
let closePool: (() => Promise<void>) | undefined;
let blobDir: string;
let smtp: SmtpFake;
let config: CommunityConfig;
let server: ReturnType<typeof serve>;
let baseUrl: string;

async function freePort() {
  const socket = createServer();
  await new Promise<void>((resolve) => socket.listen(0, '127.0.0.1', resolve));
  const address = socket.address();
  if (!address || typeof address === 'string') throw new Error('No browser test port');
  await new Promise<void>((resolve) => socket.close(() => resolve()));
  return address.port;
}

/** Resolve requests and send due mail, as the mail worker's next tick would. */
async function tick() {
  await resolveEmailLinkRequests(pool, config);
  const composers = emailLinkComposers(config);
  while (
    await deliverNextNotice({ pool, transport: createSmtpTransport(config.mail!), composers })
  );
}

test.beforeAll(async () => {
  await admin.query(`CREATE DATABASE ${dbName}`);
  await migrate(dbUrl.toString());
  const ownedPool = createBrowserTestPool({ connectionString: dbUrl.toString() });
  pool = ownedPool.pool;
  closePool = ownedPool.close;
  blobDir = await mkdtemp(join(tmpdir(), 'community-browser-email-'));
  smtp = await startSmtpFake();
  const port = await freePort();
  baseUrl = `http://127.0.0.1:${port}`;
  config = parseConfig({
    COMMUNITY_DATABASE_URL: dbUrl.toString(),
    COMMUNITY_AUTH_SECRET: 'a'.repeat(32),
    COMMUNITY_INVITE_SECRET: 'b'.repeat(32),
    COMMUNITY_BOOTSTRAP_SECRET: BOOTSTRAP_SECRET,
    COMMUNITY_PUBLIC_URL: baseUrl,
    COMMUNITY_STORAGE_PATH: blobDir,
    COMMUNITY_SMTP_URL: `smtp://127.0.0.1:${smtp.port}`,
    COMMUNITY_MAIL_FROM: 'Test Space <spaces@community.test>',
  });
  const app = createCommunityApp({ config, pool, noticeComposers: emailLinkComposers(config) });
  const staticRoot = fileURLToPath(new URL('../dist/', import.meta.url));
  app.use('/assets/*', serveStatic({ root: staticRoot }));
  for (const path of ['/', '/reset-password', '/c/:communityId', '/c/:communityId/*'])
    app.get(
      path,
      serveStatic({ path: fileURLToPath(new URL('../dist/index.html', import.meta.url)) })
    );
  server = serve({ fetch: app.fetch, port, hostname: '127.0.0.1' });
  await new Promise<void>((resolve) => server.once('listening', resolve));
  // The first owner, made through the real setup.
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
  const preflight = await post('/api/v1/bootstrap/preflight', { secret: BOOTSTRAP_SECRET });
  const grant = preflight.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .join('; ');
  const done = await post(
    '/api/v1/bootstrap/complete',
    {
      secret: BOOTSTRAP_SECRET,
      accountName: 'Owner',
      email: 'owner@email.test',
      password: OLD_PASSWORD,
      communityName: 'Mail Place',
      channelName: 'general',
    },
    grant
  );
  expect(done.status).toBe(201);
});

test.afterAll(async () => {
  if (server) {
    if ('closeAllConnections' in server) server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  await smtp?.close();
  await closePool?.();
  await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await admin.end();
  if (blobDir) await rm(blobDir, { recursive: true, force: true });
});

test.setTimeout(90_000);

test('forgot password: ask, read the mail, open the link, choose a new password, signed in', async ({
  page,
}, testInfo) => {
  // Fails if the sign-in form offers no reset on a host with mail, the mail never carries a
  // working link, the link page leaves its token in the address bar, or the new password does
  // not sign the browser in.
  await page.goto(baseUrl);
  await page.getByRole('button', { name: 'Forgot password?' }).click();
  await expect(page.getByRole('heading', { name: 'Reset your password' })).toBeVisible();
  await page.getByLabel('Email').fill('owner@email.test');
  await page.getByRole('button', { name: 'Send reset link' }).click();
  await expect(page.getByText('Check your email. The link works for 30 minutes.')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('forgot-sent.png'), fullPage: true });

  await tick();
  // The owner's mailbox also holds the confirmation mailed at setup; find the reset link.
  const link = smtp.received
    .filter((message) => message.recipients.includes('owner@email.test'))
    .map((message) => message.raw.replace(/=\r?\n/gu, '').replace(/=3D/gu, '='))
    .map((flat) => /http:\/\/127\.0\.0\.1:\d+\/reset-password#[A-Za-z0-9_-]{43}/u.exec(flat)?.[0])
    .find(Boolean);
  expect(link).toBeTruthy();

  await page.goto(link!);
  await expect(page.getByRole('heading', { name: 'Choose a new password' })).toBeVisible();
  // The token left the address bar before anything else ran.
  expect(new URL(page.url()).hash).toBe('');
  await expect(page.getByText('For owner@email.test.')).toBeVisible();
  await expect(page.getByText('Server API keys you made')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('reset-page.png'), fullPage: true });
  await page.getByLabel('New password').fill(NEW_PASSWORD);
  await page.getByRole('button', { name: 'Reset password' }).click();
  await expect(page.getByRole('heading', { name: 'Password reset' })).toBeVisible();

  const session = await page.request.get(`${baseUrl}/api/auth/get-session`);
  expect(((await session.json()) as { user?: { email: string } }).user?.email).toBe(
    'owner@email.test'
  );
  const oldPassword = await fetch(`${baseUrl}/api/auth/sign-in/email`, {
    method: 'POST',
    headers: { origin: baseUrl, 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'owner@email.test', password: OLD_PASSWORD }),
  });
  expect(oldPassword.status).toBe(401);
});
