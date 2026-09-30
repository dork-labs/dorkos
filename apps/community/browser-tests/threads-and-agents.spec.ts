import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
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

// Purpose (DOR-2562, DOR-2563): the Community's own page shows, as the DorkOS app does, how many
// replies a thread root has — counted by the server and kept current by the live stream without
// counting a reply twice — and marks an agent's message as an agent's, in its accessible name.
//
// COMMUNITY_THREADS_SCREENSHOTS optionally names a directory for reviewable screenshots.

const { COMMUNITY_TEST_DATABASE_URL: adminUrl, COMMUNITY_THREADS_SCREENSHOTS: shots } = process.env;
if (!adminUrl)
  throw new Error('COMMUNITY_TEST_DATABASE_URL is required for community browser tests');
const dbName = `community_browser_threads_${randomUUID().replaceAll('-', '')}`;
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

/** Capture a page as it is, at its own width, when screenshots were asked for. */
async function shot(page: Page, name: string) {
  if (!shots) return;
  await mkdir(shots, { recursive: true });
  await page.screenshot({ path: join(shots, `${name}.png`) });
}

test.beforeAll(async () => {
  await admin.query(`CREATE DATABASE ${dbName}`);
  await migrate(dbUrl.toString());
  pool = new Pool({ connectionString: dbUrl.toString() });
  blobDir = await mkdtemp(join(tmpdir(), 'community-browser-threads-'));
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

/** Reply in the thread of the message with this text, from this tab. */
async function reply(page: Page, rootText: string, text: string) {
  await page
    .getByRole('article')
    .filter({ hasText: rootText })
    .getByRole('button', { name: 'Reply in thread' })
    .click();
  await page.getByLabel('Reply in thread').fill(text);
  await page.getByRole('button', { name: 'Reply', exact: true }).click();
  await expect(page.locator('.drawer .entry-text').getByText(text)).toBeVisible();
  await page.getByRole('button', { name: 'Close thread' }).first().click();
}

/** The reply line under the message with this text. */
function replyLine(page: Page, rootText: string) {
  return page.getByRole('article').filter({ hasText: rootText }).getByTestId('thread-replies');
}

test('thread roots show their reply counts live, and agent messages say they are an agent’s', async ({
  browser,
}) => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const writer = await context.newPage();
  try {
    await writer.goto(baseUrl);
    await writer.getByLabel('Setup secret').fill('c'.repeat(32));
    await writer.getByRole('button', { name: 'Continue' }).click();
    await writer.getByLabel('Your name').fill('Owner');
    await writer.getByLabel('Email').fill('owner@threads.test');
    await writer.getByLabel('Password').fill('password1234');
    await writer.getByLabel('Community name').fill('Thread Place');
    await writer.getByLabel('First channel').fill('general');
    await writer.getByRole('button', { name: 'Create community' }).click();
    await expect(writer.getByRole('heading', { name: '# general' })).toBeVisible({
      timeout: 15000,
    });
    const { rows } = await pool.query<{
      community_id: string;
      channel_id: string;
      member_id: string;
    }>(
      `SELECT c.id AS community_id, ch.id AS channel_id, m.id AS member_id
         FROM communities c JOIN channels ch ON ch.community_id=c.id
         JOIN members m ON m.community_id=c.id
        WHERE c.name='Thread Place' AND ch.name='general'`
    );
    const ids = rows[0];

    // An agent's message, written the way the server stores one: authored by the agent.
    const agent = await pool.query<{ id: string }>(
      `INSERT INTO agents(community_id,owner_member_id,display_name,handle)
       VALUES($1,$2,'Scout','scout') RETURNING id`,
      [ids.community_id, ids.member_id]
    );
    await pool.query(
      'INSERT INTO community_handles(community_id,handle,agent_id) VALUES($1,$2,$3)',
      [ids.community_id, 'scout', agent.rows[0].id]
    );
    await pool.query(
      'INSERT INTO agent_channel_members(community_id,channel_id,agent_id) VALUES($1,$2,$3)',
      [ids.community_id, ids.channel_id, agent.rows[0].id]
    );
    await pool.query(
      `WITH next AS (UPDATE channels SET last_seq=last_seq+1 WHERE id=$2 RETURNING last_seq)
       INSERT INTO entries(community_id,channel_id,seq,author_agent_id,author_display_name,text,
         idempotency_key,payload_hash)
       SELECT $1,$2,next.last_seq,$3,'Scout','Build finished, all green.','seed-agent',md5('a')
         FROM next`,
      [ids.community_id, ids.channel_id, agent.rows[0].id]
    );
    await send(writer, 'Who is picking up the release notes?');

    // A second tab, on a phone, that only watches: everything it learns comes from the server.
    const reader = await context.newPage();
    await reader.setViewportSize({ width: 390, height: 844 });
    await reader.goto(`${baseUrl}/c/${ids.community_id}`);
    await expect(reader.getByText('Who is picking up the release notes?')).toBeVisible({
      timeout: 15000,
    });

    // DOR-2563: the agent's message is named as an agent's, and drawn with the agent badge; a
    // person's is not.
    const agentMessage = reader.getByRole('article', { name: /^Scout Agent / });
    await expect(agentMessage).toBeVisible();
    await expect(agentMessage.getByTestId('agent-badge')).toBeVisible();
    const personMessage = reader
      .getByRole('article')
      .filter({ hasText: 'Who is picking up the release notes?' });
    await expect(personMessage).toHaveAccessibleName(/^Owner \d/u);
    await expect(personMessage.getByTestId('agent-badge')).toHaveCount(0);

    // DOR-2562: no replies, no line. The first reply shows up in the other tab without a reload.
    await expect(replyLine(reader, 'release notes')).toHaveCount(0);
    await reply(writer, 'release notes', 'I will.');
    await expect(replyLine(reader, 'release notes')).toHaveText(/^↳1 reply · last /u);
    await expect(replyLine(writer, 'release notes')).toHaveText(/^↳1 reply · last /u);
    await reply(writer, 'release notes', 'Draft is up.');
    await expect(replyLine(reader, 'release notes')).toHaveText(/^↳2 replies · last /u);

    // After a reload the count is the server's, and a reply that lands afterwards adds one:
    // none is counted twice.
    await reader.reload();
    await expect(replyLine(reader, 'release notes')).toHaveText(/^↳2 replies · last /u, {
      timeout: 15000,
    });
    await reply(writer, 'release notes', 'Merged.');
    await expect(replyLine(reader, 'release notes')).toHaveText(/^↳3 replies · last /u);
    await expect(replyLine(reader, 'Build finished')).toHaveCount(0);

    // With no live stream at all (it is refused here), the counts still come with the history.
    const offline = await context.newPage();
    await offline.route('**/events', (route) => route.abort());
    await offline.goto(`${baseUrl}/c/${ids.community_id}`);
    await expect(replyLine(offline, 'release notes')).toHaveText(/^↳3 replies · last /u, {
      timeout: 15000,
    });
    await offline.close();

    // The line is the way into the thread.
    await replyLine(reader, 'release notes').click();
    const drawer = reader.getByRole('complementary', { name: 'Thread' });
    await expect(drawer.getByText('Merged.')).toBeVisible();
    await drawer.getByRole('button', { name: 'Close thread' }).first().click();
    expect(await reader.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(
      false
    );
    await shot(reader, 'threads-and-agents-mobile');
    await shot(writer, 'threads-and-agents-desktop');
    await writer.emulateMedia({ colorScheme: 'dark' });
    await shot(writer, 'threads-and-agents-desktop-dark');
  } finally {
    await context.close();
  }
});
