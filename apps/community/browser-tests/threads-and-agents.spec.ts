import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { test, expect, type Locator, type Page } from '@playwright/test';
import type { AxeResults } from 'axe-core';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Pool } from 'pg';
import { createCommunityApp } from '../src/app.js';
import { parseConfig } from '../src/config.js';
import { migrate } from '../src/migrate.js';
import { measureContrast, settle } from './contrast.js';

// Purpose (DOR-2562, DOR-2563): the Community's own page shows, as the DorkOS app does, how many
// replies a thread root has — counted by the server and kept current by the live stream without
// counting a reply twice — and marks an agent's message as an agent's, in its accessible name.
// DOR-2567: the controls in and beside that thread row stay readable in light and dark, at rest,
// under the pointer and with keyboard focus.
//
// COMMUNITY_THREADS_SCREENSHOTS optionally names a directory for reviewable screenshots.

const { COMMUNITY_TEST_DATABASE_URL: adminUrl, COMMUNITY_THREADS_SCREENSHOTS: shots } = process.env;
if (!adminUrl)
  throw new Error('COMMUNITY_TEST_DATABASE_URL is required for community browser tests');
const dbName = `community_browser_threads_${randomUUID().replaceAll('-', '')}`;
const dbUrl = new URL(adminUrl);
dbUrl.pathname = `/${dbName}`;
const admin = new Pool({ connectionString: adminUrl });
const AXE_BUNDLE = createRequire(import.meta.url).resolve('axe-core/axe.min.js');
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

/**
 * Capture a page at its own width, when screenshots were asked for. Transitions are finished
 * first: straight after a theme switch the shared buttons are still fading from the old colours,
 * and a picture of that half-way frame was once read as a contrast bug (DOR-2567).
 */
async function shot(page: Page, name: string) {
  if (!shots) return;
  await mkdir(shots, { recursive: true });
  await page.screenshot({ path: join(shots, `${name}.png`), animations: 'disabled' });
}

/** Run axe's WCAG A/AA rules on the page as it stands. */
async function axeViolations(page: Page) {
  await page.addScriptTag({ path: AXE_BUNDLE });
  const results = (await page.evaluate(() =>
    (
      window as unknown as {
        axe: { run: (context: object, options: object) => Promise<unknown> };
      }
    ).axe.run(
      { include: [['html']] },
      {
        runOnly: {
          type: 'tag',
          values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'],
        },
      }
    )
  )) as AxeResults;
  return results.violations.map((violation) => `${violation.id}: ${violation.nodes[0]?.target}`);
}

/**
 * Give a control keyboard focus, so `:focus-visible` matches as it does for a Tab user: step
 * off it and back. `target` is what takes focus — the hidden input, for a file picker.
 */
async function keyboardFocus(page: Page, target: Locator) {
  await target.focus();
  await page.keyboard.press('Tab');
  await page.keyboard.press('Shift+Tab');
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

    // DOR-2567: the thread row's two buttons, and the Manage, Attach, Send and Switch community
    // buttons around them, measured as painted. Text needs 4.5:1 against the button's fill at
    // rest and under the pointer, an icon 3:1, and the keyboard focus ring 3:1 against the page.
    const root = writer.getByRole('article').filter({ hasText: 'release notes' });
    const attach = writer.locator('label[aria-label="Add files"]');
    const controls: { name: string; control: Locator; focus?: Locator }[] = [
      { name: 'Reply in thread', control: root.getByRole('button', { name: 'Reply in thread' }) },
      { name: 'reply count', control: replyLine(writer, 'release notes') },
      { name: 'Manage', control: writer.getByRole('button', { name: 'Manage' }) },
      { name: 'Attach', control: attach, focus: attach.locator('input') },
      { name: 'Send', control: writer.getByRole('button', { name: 'Send' }) },
      {
        name: 'Switch community',
        control: writer.getByRole('button', { name: 'Switch community' }),
      },
    ];
    // Send is only enabled with something to send.
    await writer.getByLabel('Message #general').fill('Not sent');
    const measured: Record<string, unknown> = {};
    for (const scheme of ['light', 'dark'] as const) {
      await writer.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
      for (const { name, control, focus = control } of controls) {
        await writer.mouse.move(0, 0);
        await settle(writer);
        const rest = await measureContrast(control);
        await control.hover();
        await settle(writer);
        const hover = await measureContrast(control);
        await writer.mouse.move(0, 0);
        await keyboardFocus(writer, focus);
        await settle(writer);
        const focused = await measureContrast(control);
        await focus.blur();
        measured[`${scheme} ${name}`] = { rest, hover, focused };
        for (const [state, value] of [
          ['at rest', rest],
          ['hovered', hover],
        ] as const) {
          expect.soft(value.text, `${scheme} ${name} ${state}: text`).toBeGreaterThanOrEqual(4.5);
          if (value.icon !== null)
            expect.soft(value.icon, `${scheme} ${name} ${state}: icon`).toBeGreaterThanOrEqual(3);
        }
        expect.soft(focused.focusVisible, `${scheme} ${name}: keyboard focus`).toBe(true);
        expect.soft(focused.ring, `${scheme} ${name}: focus ring`).not.toBeNull();
        expect.soft(focused.ring ?? 0, `${scheme} ${name}: focus ring`).toBeGreaterThanOrEqual(3);
      }
      for (const [page, width] of [
        [writer, 1280],
        [reader, 390],
      ] as const) {
        await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
        await settle(page);
        expect.soft(await axeViolations(page), `${scheme} ${width}px: axe`).toEqual([]);
      }
      await keyboardFocus(writer, attach.locator('input'));
      await shot(writer, `thread-row-${scheme}-desktop`);
      await attach.locator('input').blur();
      await shot(reader, `thread-row-${scheme}-mobile`);
    }
    await test.info().attach('thread-row-contrast.json', {
      body: JSON.stringify(measured, null, 2),
      contentType: 'application/json',
    });
    if (shots) console.log(`thread-row contrast: ${JSON.stringify(measured)}`);
  } finally {
    await context.close();
  }
});
