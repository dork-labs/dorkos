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

// Purpose (specs/community-single-item-delete task 1.3, AC-12): a message deleted in one tab is
// replaced by its tombstone in another open tab without a reload, through the channel's
// redaction feed (the live stream carries no such event). It fails if the tab never polls, polls
// without a cursor from before its history, or does not replace the entry in place.

const adminUrl = process.env.COMMUNITY_TEST_DATABASE_URL;
if (!adminUrl)
  throw new Error('COMMUNITY_TEST_DATABASE_URL is required for community browser tests');
const dbName = `community_browser_redactions_${randomUUID().replaceAll('-', '')}`;
const dbUrl = new URL(adminUrl);
dbUrl.pathname = `/${dbName}`;
const admin = new Pool({ connectionString: adminUrl });
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

test.beforeAll(async () => {
  await admin.query(`CREATE DATABASE ${dbName}`);
  await migrate(dbUrl.toString());
  pool = new Pool({ connectionString: dbUrl.toString() });
  blobDir = await mkdtemp(join(tmpdir(), 'community-browser-redactions-'));
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
  server = serve({ fetch: app.fetch, port, hostname: '127.0.0.1' });
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

test.setTimeout(90_000);

/** Send one message from the composer and wait until this tab shows it. */
async function send(page: Page, text: string) {
  await page.getByLabel('Message #general').fill(text);
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(page.getByText(text)).toBeVisible();
}

/** Delete the message with this text through the API, as the tab's own session. */
async function deleteByText(page: Page, communityId: string, text: string) {
  const status = await page.evaluate(
    async ({ communityId, text }) => {
      const base = `/api/v1/communities/${communityId}`;
      const channels = (await (await fetch(`${base}/channels`)).json()) as {
        channels: { id: string; name: string }[];
      };
      const general = channels.channels.find((channel) => channel.name === 'general')!;
      const page = (await (await fetch(`${base}/channels/${general.id}/entries`)).json()) as {
        entries: { id: string; text: string }[];
      };
      const entry = page.entries.find((item) => item.text === text)!;
      return (await fetch(`${base}/entries/${entry.id}`, { method: 'DELETE' })).status;
    },
    { communityId, text }
  );
  expect(status).toBe(200);
}

test('a message deleted in one tab turns into its tombstone in another open tab', async ({
  browser,
}) => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const first = await context.newPage();
  try {
    await first.goto(baseUrl);
    await first.getByLabel('Setup secret').fill('c'.repeat(32));
    await first.getByRole('button', { name: 'Continue' }).click();
    await first.getByLabel('Your name').fill('Owner');
    await first.getByLabel('Email').fill('owner@redactions.test');
    await first.getByLabel('Password').fill('password1234');
    await first.getByLabel('Community name').fill('Quiet Place');
    await first.getByLabel('First channel').fill('general');
    await first.getByRole('button', { name: 'Create community' }).click();
    await expect(first.getByRole('heading', { name: '# general' })).toBeVisible({
      timeout: 15000,
    });
    const communityId = (
      await pool.query<{ id: string }>("SELECT id FROM communities WHERE name='Quiet Place'")
    ).rows[0].id;

    // The second tab runs on a controlled clock, so its 30-second poll can be moved on, and its
    // live stream can be handed an event the test writes.
    const second = await context.newPage();
    await second.clock.install();
    await second.addInitScript(() => {
      const Native = window.EventSource;
      class Observed extends Native {
        constructor(url: string | URL, init?: EventSourceInit) {
          super(url, init);
          (window as Window & { __stream?: EventSource }).__stream = this;
        }
      }
      window.EventSource = Observed;
    });
    await second.goto(`${baseUrl}/c/${communityId}`);
    await expect(second.getByRole('heading', { name: '# general' })).toBeVisible({
      timeout: 15000,
    });

    await send(first, 'zqx message that will be deleted');
    await expect(second.getByText('zqx message that will be deleted')).toBeVisible();
    // A live-stream read of this message from before the deletion, for later.
    const staleEntry = await first.evaluate(async (communityId) => {
      const base = `/api/v1/communities/${communityId}`;
      const channels = (await (await fetch(`${base}/channels`)).json()) as {
        channels: { id: string; name: string }[];
      };
      const general = channels.channels.find((channel) => channel.name === 'general')!;
      const page = (await (await fetch(`${base}/channels/${general.id}/entries`)).json()) as {
        entries: { text: string; cursor: string }[];
      };
      return page.entries.find((item) => item.text === 'zqx message that will be deleted')!;
    }, communityId);
    await deleteByText(first, communityId, 'zqx message that will be deleted');
    // Nothing on the live stream announces it: the other tab still shows the old text...
    await expect(second.getByText('zqx message that will be deleted')).toBeVisible();
    // ...until its next poll.
    await second.clock.runFor(31_000);
    await expect(second.getByText('This message was deleted.')).toBeVisible();
    await expect(second.getByText('zqx message that will be deleted')).toHaveCount(0);
    // An older read arriving late (here, a stream snapshot carrying the message as it was) must
    // not bring the deleted text back.
    await second.evaluate((entry) => {
      const stream = (window as Window & { __stream?: EventSource }).__stream!;
      stream.dispatchEvent(
        new MessageEvent('snapshot', {
          data: JSON.stringify({ type: 'snapshot', entries: [entry], cursor: entry.cursor }),
        })
      );
    }, staleEntry);
    await expect(second.getByText('This message was deleted.')).toBeVisible();
    await expect(second.getByText('zqx message that will be deleted')).toHaveCount(0);

    // Coming back to the window asks at once, without waiting for the timer.
    await send(first, 'zqx second message');
    await expect(second.getByText('zqx second message')).toBeVisible();
    await deleteByText(first, communityId, 'zqx second message');
    await second.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(second.getByText('zqx second message')).toHaveCount(0);
    await expect(second.getByText('This message was deleted.')).toHaveCount(2);

    // A removal this tab tried and the server refused rolls back — but never over a change the
    // tab has since learned someone else made (DOR-2289's rollback meets the redaction feed).
    await send(first, 'zqx rollback message');
    await expect(second.getByText('zqx rollback message')).toBeVisible();
    let releaseRefusal!: () => void;
    const refusalGate = new Promise<void>((resolve) => (releaseRefusal = resolve));
    await second.route(
      (url) => /\/entries\/[0-9a-f-]+$/u.test(url.pathname),
      async (route) => {
        if (route.request().method() !== 'DELETE') return route.fallback();
        await refusalGate;
        await route.fulfill({
          // Not a 403: that reloads the member and the channel, which would hide a bad rollback.
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({ code: 'UNAVAILABLE', message: 'Try the removal again soon.' }),
        });
      }
    );
    const card = second.locator('article', { hasText: 'zqx rollback message' });
    await card.getByRole('button', { name: 'Message actions' }).click();
    await second.getByRole('menuitem', { name: 'Delete', exact: true }).click();
    await second
      .getByRole('alertdialog', { name: 'Delete this message?' })
      .getByRole('button', { name: 'Delete', exact: true })
      .click();
    // While this tab's attempt is held, the message really is deleted elsewhere, and this tab
    // learns so from the feed.
    await deleteByText(first, communityId, 'zqx rollback message');
    const learned = second.waitForResponse(
      (response) => response.url().includes('/redactions?cursor=') && response.ok()
    );
    await second.evaluate(() => window.dispatchEvent(new Event('focus')));
    await learned;
    await expect(second.getByText('zqx rollback message')).toHaveCount(0);
    releaseRefusal();
    await expect(second.getByText('Try the removal again soon.')).toBeVisible();
    await expect(second.getByText('zqx rollback message')).toHaveCount(0);
    await second.unroute((url) => /\/entries\/[0-9a-f-]+$/u.test(url.pathname));

    // A tab that cannot learn where the changes end while it loads reads them from the first
    // instead, so a deletion made while it loaded is not missed.
    const third = await context.newPage();
    await third.clock.install();
    await third.route(
      (url) => url.pathname.endsWith('/redactions') && url.searchParams.get('from') === 'end',
      (route) => route.fulfill({ status: 503, body: '' })
    );
    await third.goto(`${baseUrl}/c/${communityId}`);
    await send(first, 'zqx third message');
    await expect(third.getByText('zqx third message')).toBeVisible();
    await deleteByText(first, communityId, 'zqx third message');
    await third.clock.runFor(31_000);
    await expect(third.getByText('zqx third message')).toHaveCount(0);
    await expect(third.getByText('This message was deleted.')).toHaveCount(4);
  } finally {
    await context.close();
  }
});
