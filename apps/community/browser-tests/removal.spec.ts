import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import {
  test,
  expect,
  request as playwrightRequest,
  type Browser,
  type Locator,
  type Page,
} from '@playwright/test';
import type { AxeResults } from 'axe-core';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Pool } from 'pg';
import { createCommunityApp } from '../src/app.js';
import { parseConfig } from '../src/config.js';
import { migrate } from '../src/migrate.js';
import { bootstrapFirstHost, responseCookies } from '../src/__tests__/bootstrap-test-helper.js';

// Deleting and removing one message or file, in the browser (specs/community-single-item-delete
// task 1.2): the author's Delete, an admin's Remove within the rank rule, the dialogs' exact
// sentences, the tombstone in place with its thread, a refusal put back with the server's
// sentence, one file removed from a message, keyboard and screen-reader names, phone width.
// COMMUNITY_REMOVAL_SCREENSHOTS optionally names a directory for reviewable screenshots.
const { COMMUNITY_TEST_DATABASE_URL: adminUrl, COMMUNITY_REMOVAL_SCREENSHOTS: shots } = process.env;
if (!adminUrl)
  throw new Error('COMMUNITY_TEST_DATABASE_URL is required for community browser tests');
const dbName = `community_browser_removal_${randomUUID().replaceAll('-', '')}`;
const dbUrl = new URL(adminUrl);
dbUrl.pathname = `/${dbName}`;
const admin = new Pool({ connectionString: adminUrl });
const password = 'password1234';
const AXE_BUNDLE = createRequire(import.meta.url).resolve('axe-core/axe.min.js');
const leftovers =
  'People who already saw it may have a copy, and exports made before now still contain it until they expire.';
let pool: Pool;
let server: ReturnType<typeof serve>;
let baseUrl: string;
let blobDir: string;
let communityId: string;
let channelId: string;
let ownerCookie: string;
let miaCookie: string;
let adaCookie: string;
let adaId: string;

async function freePort() {
  const socket = createServer();
  await new Promise<void>((resolve) => socket.listen(0, '127.0.0.1', resolve));
  const address = socket.address();
  if (!address || typeof address === 'string') throw new Error('No browser test port');
  await new Promise<void>((resolve) => socket.close(() => resolve()));
  return address.port;
}

/**
 * Capture one state at phone, tablet and desktop width when screenshots are asked for, with
 * `subject` scrolled into view once the layout has finished moving.
 */
async function shot(page: Page, name: string, subject?: Locator) {
  if (!shots) return;
  const original = page.viewportSize();
  for (const width of [390, 768, 1280]) {
    await page.setViewportSize({ width, height: 844 });
    await subject?.scrollIntoViewIfNeeded();
    await page.waitForFunction(() =>
      document.getAnimations().every((animation) => animation.playState !== 'running')
    );
    await page.screenshot({ path: join(shots, `${name}-${width}.png`) });
  }
  if (original) await page.setViewportSize(original);
}

function call(path: string, method: string, body: unknown, cookie: string) {
  return fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      origin: baseUrl,
      cookie,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const tenant = () => `/api/v1/communities/${communityId}`;

/** Admit a brand-new account through the production invitation protocol and sign it in. */
async function admitNewAccount(name: string, email: string) {
  const issued = await call(`${tenant()}/invites`, 'POST', { seats: 1 }, ownerCookie);
  expect(issued.status).toBe(201);
  const { token } = (await issued.json()) as { token: string };
  const api = await playwrightRequest.newContext({
    baseURL: baseUrl,
    extraHTTPHeaders: { origin: baseUrl },
  });
  let memberId: string;
  try {
    expect((await api.post(`${tenant()}/invites/preflight`, { data: { token } })).ok()).toBe(true);
    expect(
      (await api.post('/api/auth/sign-up/email', { data: { name, email, password } })).ok()
    ).toBe(true);
    expect((await api.post(`${tenant()}/invites/bind`, { data: {} })).ok()).toBe(true);
    const redeemed = await api.post(`${tenant()}/invites/redeem`, { data: {} });
    expect(redeemed.ok()).toBe(true);
    memberId = ((await redeemed.json()) as { memberId: string }).memberId;
  } finally {
    await api.dispose();
  }
  const signedIn = await call('/api/auth/sign-in/email', 'POST', { email, password }, '');
  expect(signedIn.status).toBe(200);
  const cookie = responseCookies(signedIn);
  expect((await call(`${tenant()}/channels/${channelId}/join`, 'POST', {}, cookie)).ok).toBe(true);
  return { memberId, cookie };
}

type PostedEntry = { id: string; attachments: { id: string; name: string }[] };

/** Post one message as `cookie`, optionally as a reply or with freshly uploaded files. */
async function postMessage(
  cookie: string,
  text: string,
  options: { parentEntryId?: string; files?: string[] } = {}
): Promise<PostedEntry> {
  const attachmentIds: string[] = [];
  for (const name of options.files ?? []) {
    const uploaded = await fetch(`${baseUrl}${tenant()}/channels/${channelId}/attachments`, {
      method: 'POST',
      headers: {
        origin: baseUrl,
        cookie,
        'content-type': 'text/plain',
        'x-file-name': name,
        'x-file-size': '5',
        'idempotency-key': randomUUID(),
      },
      body: 'bytes',
    });
    expect(uploaded.status).toBe(201);
    attachmentIds.push(((await uploaded.json()) as { attachment: { id: string } }).attachment.id);
  }
  const posted = await call(
    `${tenant()}/channels/${channelId}/entries`,
    'POST',
    { text, idempotencyKey: randomUUID(), parentEntryId: options.parentEntryId, attachmentIds },
    cookie
  );
  expect(posted.status).toBe(201);
  return ((await posted.json()) as { entry: PostedEntry }).entry;
}

async function setRole(memberId: string, role: 'admin' | 'member') {
  const changed = await call(
    `${tenant()}/members/${memberId}/role`,
    'PATCH',
    { role },
    ownerCookie
  );
  expect(changed.status).toBe(200);
}

async function openAs(browser: Browser, cookie: string) {
  const context = await browser.newContext();
  await context.addCookies(
    cookie.split('; ').map((pair) => {
      const at = pair.indexOf('=');
      return { name: pair.slice(0, at), value: pair.slice(at + 1), url: baseUrl };
    })
  );
  const page = await context.newPage();
  await page.goto(`${baseUrl}/c/${communityId}`);
  await expect(page.getByRole('heading', { name: '# general' })).toBeVisible();
  return { context, page };
}

/** The one message card in the channel list whose text is `text`. */
function message(page: Page, text: string): Locator {
  return page
    .locator('.message-list article')
    .filter({ has: page.getByText(text, { exact: true }) });
}

/** Run axe's WCAG A/AA rules on the page as it stands, at desktop and phone width. */
async function assertAccessible(page: Page, label: string) {
  const original = page.viewportSize();
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 844 });
    // Axe must sample settled colors, not a frame of the dialog fading in.
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.waitForFunction(() =>
      document.getAnimations().every((animation) => animation.playState !== 'running')
    );
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
    expect(
      results.violations.map((violation) => `${violation.id}: ${violation.nodes[0]?.target}`),
      `${label} at ${width}px: axe`
    ).toEqual([]);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth),
      `${label} at ${width}px: sideways scroll`
    ).toBe(false);
  }
  if (original) await page.setViewportSize(original);
}

test.beforeAll(async () => {
  await admin.query(`CREATE DATABASE ${dbName}`);
  await migrate(dbUrl.toString());
  pool = new Pool({ connectionString: dbUrl.toString() });
  blobDir = await mkdtemp(join(tmpdir(), 'community-browser-removal-'));
  const port = await freePort();
  baseUrl = `http://127.0.0.1:${port}`;
  const config = parseConfig({
    COMMUNITY_DATABASE_URL: dbUrl.toString(),
    COMMUNITY_AUTH_SECRET: 'a'.repeat(32),
    COMMUNITY_INVITE_SECRET: 'b'.repeat(32),
    COMMUNITY_BOOTSTRAP_SECRET: 'c'.repeat(32),
    COMMUNITY_PUBLIC_URL: baseUrl,
    COMMUNITY_STORAGE_PATH: blobDir,
    COMMUNITY_INVITE_PREVIEW_ATTEMPTS_PER_MINUTE: 100,
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
  const setup = await bootstrapFirstHost((path, body, cookie) => call(path, 'POST', body, cookie), {
    secret: config.bootstrapSecret,
    accountName: 'Olive Owner',
    email: 'owner@removal.test',
    password,
    communityName: 'Removal Place',
    channelName: 'general',
  });
  ownerCookie = setup.cookie;
  communityId = setup.communityId;
  channelId = setup.channelId;
  miaCookie = (await admitNewAccount('Mia Member', 'mia@removal.test')).cookie;
  const ada = await admitNewAccount('Ada Admin', 'ada@removal.test');
  adaCookie = ada.cookie;
  adaId = ada.memberId;
  await setRole(adaId, 'admin');
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

test('a member deletes their own message by keyboard; the tombstone keeps its place and thread', async ({
  browser,
}) => {
  const root = await postMessage(miaCookie, 'Lunch plans moved to Friday', {
    files: ['menu.txt'],
  });
  await postMessage(ownerCookie, 'Friday works for me', { parentEntryId: root.id });
  await postMessage(ownerCookie, 'Welcome, everyone');
  const { context, page } = await openAs(browser, miaCookie);
  try {
    const mine = message(page, 'Lunch plans moved to Friday');
    const theirs = message(page, 'Welcome, everyone');
    // A member acts only on their own messages.
    await expect(theirs.getByRole('button', { name: 'Message actions' })).toHaveCount(0);
    await expect(theirs.getByRole('button', { name: 'Actions for menu.txt' })).toHaveCount(0);
    const trigger = mine.getByRole('button', { name: 'Message actions' });
    await expect(trigger).toHaveCount(1);
    // Each menu names whose message it acts on, and when it was sent.
    await expect(trigger).toHaveAccessibleName(/^Message actions: Mia Member, \d{1,2}:\d{2}/u);

    // Keyboard only: open the menu, choose Delete, read the dialog, back out with Escape.
    await trigger.focus();
    await page.keyboard.press('Enter');
    const item = page.getByRole('menuitem', { name: 'Delete', exact: true });
    await expect(item).toBeFocused();
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('alertdialog', { name: 'Delete this message?' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('paragraph')).toHaveText([
      'Everyone will see "This message was deleted." in its place. Its files are deleted too. This can\'t be undone.',
      leftovers,
    ]);
    await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused();
    await shot(page, 'delete-dialog');
    await assertAccessible(page, 'delete dialog');
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(trigger).toBeFocused();
    await expect(mine.getByText('Lunch plans moved to Friday')).toBeVisible();

    // Again, and this time confirm with the keyboard.
    await page.keyboard.press('Enter');
    await expect(item).toBeFocused();
    await page.keyboard.press('Enter');
    await dialog.getByRole('button', { name: 'Delete', exact: true }).focus();
    await page.keyboard.press('Enter');
    await expect(dialog).toHaveCount(0);
    const tombstone = message(page, 'This message was deleted.');
    await expect(tombstone).toHaveCount(1);
    await expect(page.getByText('Lunch plans moved to Friday')).toHaveCount(0);
    // The file went with it, the card keeps its place and author, and focus stays on it.
    await expect(tombstone.getByText('menu.txt')).toHaveCount(0);
    await expect(tombstone.getByText('Mia Member')).toBeVisible();
    await expect(tombstone).toBeFocused();
    // Focus lands on a message a screen reader can name: its author and time.
    await expect(tombstone).toHaveAccessibleName(/^Mia Member \d{1,2}:\d{2}/u);
    const style = await tombstone
      .getByText('This message was deleted.')
      .evaluate((element) => getComputedStyle(element).fontStyle);
    expect(style).toBe('italic');
    // A tombstone has no menu.
    await expect(tombstone.getByRole('button', { name: 'Message actions' })).toHaveCount(0);
    const order = await page.locator('.message-list article .entry-text').allTextContents();
    expect(order.indexOf('This message was deleted.')).toBeLessThan(
      order.indexOf('Welcome, everyone')
    );
    await shot(page, 'tombstone', tombstone);

    // Its thread still opens, the reply is intact, and the root in the drawer has no menu.
    await tombstone.getByRole('button', { name: 'Reply in thread' }).click();
    const drawer = page.getByRole('complementary', { name: 'Thread' });
    await expect(drawer.getByText('Friday works for me')).toBeVisible();
    await expect(drawer.getByText('This message was deleted.')).toBeVisible();
    await expect(
      drawer.locator('article').first().getByRole('button', { name: 'Message actions' })
    ).toHaveCount(0);
    await shot(page, 'tombstone-thread');

    // The server holds the same state: a reload shows the tombstone, not the old text.
    await page.reload();
    await expect(message(page, 'This message was deleted.')).toHaveCount(1);
    await expect(page.getByText('Lunch plans moved to Friday')).toHaveCount(0);
  } finally {
    await context.close();
  }
});

test("an admin removes a member's message but is offered nothing on the owner's", async ({
  browser,
}) => {
  await postMessage(ownerCookie, 'Owner announcement');
  const spam = await postMessage(miaCookie, 'Buy cheap watches here');
  await postMessage(adaCookie, 'Ada says hi');
  // The owner is no longer in the channel: the admin must still see them as the owner.
  const leave = await call(`${tenant()}/channels/${channelId}/leave`, 'POST', {}, ownerCookie);
  expect(leave.ok).toBe(true);
  const { context, page } = await openAs(browser, adaCookie);
  try {
    // Ada's own message gets a menu once roles have loaded; the owner's never does.
    await expect(
      message(page, 'Buy cheap watches here').getByRole('button', { name: 'Message actions' })
    ).toBeVisible();
    await expect(
      message(page, 'Owner announcement').getByRole('button', { name: 'Message actions' })
    ).toHaveCount(0);
    // Your own message is still yours to Delete.
    await message(page, 'Ada says hi').getByRole('button', { name: 'Message actions' }).click();
    await expect(page.getByRole('menuitem', { name: 'Delete', exact: true })).toBeVisible();
    await page.keyboard.press('Escape');

    await message(page, 'Buy cheap watches here')
      .getByRole('button', { name: 'Message actions' })
      .click();
    await expect(page.getByRole('menuitem', { name: 'Delete', exact: true })).toHaveCount(0);
    await page.getByRole('menuitem', { name: 'Remove', exact: true }).click();
    const dialog = page.getByRole('alertdialog', { name: 'Remove this message?' });
    await expect(dialog.getByRole('paragraph')).toHaveText([
      'Everyone will see "This message was removed by a community admin." in its place. Its files are deleted too. This can\'t be undone.',
      leftovers,
    ]);
    await shot(page, 'remove-dialog');
    await dialog.getByRole('button', { name: 'Remove', exact: true }).click();
    const removed = message(page, 'This message was removed by a community admin.');
    await expect(removed).toHaveCount(1);
    await expect(removed.getByText('Mia Member')).toBeVisible();
    await expect(page.getByText('Buy cheap watches here')).toHaveCount(0);
    await expect(removed.getByRole('button', { name: 'Message actions' })).toHaveCount(0);
    // What shows at once is what the server wrote.
    await expect
      .poll(async () =>
        (
          await pool.query<{ removed_by: string | null }>(
            'SELECT removed_by FROM entries WHERE id=$1',
            [spam.id]
          )
        ).rows.map((row) => row.removed_by)
      )
      .toEqual(['moderator']);
  } finally {
    await call(`${tenant()}/channels/${channelId}/join`, 'POST', {}, ownerCookie);
    await context.close();
  }
});

test('a refused removal puts the message back and shows the server sentence', async ({
  browser,
}) => {
  await postMessage(miaCookie, 'Keep this one');
  const { context, page } = await openAs(browser, adaCookie);
  try {
    const card = message(page, 'Keep this one');
    await expect(card.getByRole('button', { name: 'Message actions' })).toBeVisible();
    // The owner makes Ada a member again while her page still shows the admin's Remove.
    await setRole(adaId, 'member');
    await card.getByRole('button', { name: 'Message actions' }).click();
    await page.getByRole('menuitem', { name: 'Remove', exact: true }).click();
    await page
      .getByRole('alertdialog', { name: 'Remove this message?' })
      .getByRole('button', { name: 'Remove', exact: true })
      .click();
    await expect(card.getByRole('alert')).toHaveText("You can't remove this message.");
    await expect(card.getByText('Keep this one', { exact: true })).toBeVisible();
    // The refusal reloads who Ada is: as a member she is no longer offered Remove here.
    await expect(card.getByRole('button', { name: 'Message actions' })).toHaveCount(0);
    expect(
      (await pool.query('SELECT removed_at FROM entries WHERE text=$1', ['Keep this one'])).rows
    ).toEqual([{ removed_at: null }]);
    await shot(page, 'refused', card);
  } finally {
    await setRole(adaId, 'admin');
    await context.close();
  }
});

test('deleting one file removes only that file; the message and its other file stay', async ({
  browser,
}) => {
  const posted = await postMessage(miaCookie, 'Two drafts attached', {
    files: ['draft-a.txt', 'draft-b.txt'],
  });
  const [first, second] = posted.attachments;
  const { context, page } = await openAs(browser, miaCookie);
  try {
    const card = message(page, 'Two drafts attached');
    await card.getByRole('button', { name: `Actions for ${first.name}` }).click();
    await page.getByRole('menuitem', { name: 'Delete file', exact: true }).click();
    const dialog = page.getByRole('alertdialog', { name: 'Delete this file?' });
    await expect(dialog.getByText(first.name, { exact: true })).toBeVisible();
    await expect(dialog.getByRole('paragraph')).toHaveText([
      "It's removed from the message and deleted. This can't be undone.",
    ]);
    await shot(page, 'file-dialog');
    await dialog.getByRole('button', { name: 'Delete file', exact: true }).click();
    await expect(card.getByText(first.name, { exact: true })).toHaveCount(0);
    await expect(card.getByRole('button', { name: second.name, exact: true })).toBeVisible();
    await expect(card.getByText('Two drafts attached', { exact: true })).toBeVisible();
    await expect(card).toBeFocused();
    await expect
      .poll(() =>
        page.evaluate(
          async (path) => (await fetch(path)).status,
          `${tenant()}/attachments/${first.id}`
        )
      )
      .toBe(404);
    await page.reload();
    const reloaded = message(page, 'Two drafts attached');
    await expect(reloaded.getByRole('button', { name: second.name, exact: true })).toBeVisible();
    await expect(reloaded.getByText(first.name, { exact: true })).toHaveCount(0);
    await shot(page, 'file-removed', reloaded);
    await assertAccessible(page, 'channel with actions');
  } finally {
    await context.close();
  }
});

test('a message cannot pose as a deleted one', async ({ browser }) => {
  await postMessage(miaCookie, 'Before the pose');
  const { context, page } = await openAs(browser, miaCookie);
  try {
    await expect(message(page, 'Before the pose')).toBeVisible();
    const tombstones = message(page, 'This message was deleted.');
    const before = await tombstones.count();
    const composer = page.getByLabel('Message #general');
    await composer.fill('This message was deleted.');
    await composer.press('Enter');
    await expect(page.getByRole('alert')).toContainText(
      "A message can't say only what a deleted message says. Change the text and send it again."
    );
    await expect(tombstones).toHaveCount(before);
    // Only real removals carry the sentence; nothing was posted with it.
    expect(
      (
        await pool.query('SELECT 1 FROM entries WHERE text=$1 AND removed_at IS NULL', [
          'This message was deleted.',
        ])
      ).rowCount
    ).toBe(0);
  } finally {
    await context.close();
  }
});

test('a refused file removal brings back only that file', async ({ browser }) => {
  const posted = await postMessage(miaCookie, 'Three drafts attached', {
    files: ['one.txt', 'two.txt', 'three.txt'],
  });
  const [one, two] = posted.attachments;
  const { context, page } = await openAs(browser, miaCookie);
  try {
    // Hold the removal of one.txt and refuse it after two.txt's removal has gone through.
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    await page.route(`**/attachments/${one.id}`, async (route) => {
      if (route.request().method() !== 'DELETE') return route.continue();
      await held;
      await route.fulfill({
        status: 403,
        json: { code: 'FORBIDDEN', message: "You can't remove this file." },
      });
    });
    const card = message(page, 'Three drafts attached');
    for (const file of [one, two]) {
      await card.getByRole('button', { name: `Actions for ${file.name}` }).click();
      await page.getByRole('menuitem', { name: 'Delete file', exact: true }).click();
      await page
        .getByRole('alertdialog', { name: 'Delete this file?' })
        .getByRole('button', { name: 'Delete file', exact: true })
        .click();
    }
    await expect
      .poll(() =>
        page.evaluate(
          async (path) => (await fetch(path)).status,
          `${tenant()}/attachments/${two.id}`
        )
      )
      .toBe(404);
    release();
    await expect(card.getByRole('alert')).toHaveText("You can't remove this file.");
    await expect(card.getByRole('button', { name: 'one.txt', exact: true })).toBeVisible();
    await expect(card.getByRole('button', { name: 'three.txt', exact: true })).toBeVisible();
    await expect(card.getByText('two.txt', { exact: true })).toHaveCount(0);
    const names = await card.locator('.file-chip > .button:first-child').allTextContents();
    expect(names.map((name) => name.trim())).toEqual(['one.txt', 'three.txt']);
  } finally {
    await context.close();
  }
});
