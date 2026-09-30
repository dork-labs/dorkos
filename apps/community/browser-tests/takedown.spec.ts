import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
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
  type BrowserContext,
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

// Host takedowns in the browser (task 1.2 of specs/community-host-takedown): the host page's Take
// down section with its no-store warning and every evidence state, Try again and Release (with a
// password, refused under a legal hold), the owner's "Removed by the host" list, the author's
// one-time banner, and a withheld takedown that neither shows. Two servers share one database:
// one without an evidence store (and with a report address), one with a filesystem store.
// COMMUNITY_TAKEDOWN_SCREENSHOTS optionally names a directory for reviewable screenshots.
const { COMMUNITY_TEST_DATABASE_URL: adminUrl, COMMUNITY_TAKEDOWN_SCREENSHOTS: shots } =
  process.env;
if (!adminUrl)
  throw new Error('COMMUNITY_TEST_DATABASE_URL is required for community browser tests');
const dbName = `community_browser_takedown_${randomUUID().replaceAll('-', '')}`;
const dbUrl = new URL(adminUrl);
dbUrl.pathname = `/${dbName}`;
const admin = new Pool({ connectionString: adminUrl });
const password = 'password1234';
const operator = { email: 'owner@takedown.test', password };
const REPORT = 'https://example.com/report';
const AXE_BUNDLE = createRequire(import.meta.url).resolve('axe-core/axe.min.js');
// Evidence must live outside the temporary folder, so it goes where the server tests put theirs.
const evidenceDirectory = join(
  fileURLToPath(new URL('../.test-evidence/', import.meta.url)),
  randomUUID()
);
// Content the host page must never show: the removed text and the file's name.
const TOLD_TEXT = 'mia-told-canary';
const QUIET_TEXT = 'mia-quiet-canary';
const FILE_NAME = 'mia-file-canary.txt';
let pool: Pool;
let blobDir: string;
const servers: ReturnType<typeof serve>[] = [];
let plainUrl: string;
let storedUrl: string;
let communityId: string;
let channelId: string;
let ownerCookie: string;
let mia: { cookie: string };
let ada: { cookie: string };
let toldEntry: string;
let quietEntry: string;
let fileEntry: { id: string; attachmentId: string };

async function freePort() {
  const socket = createServer();
  await new Promise<void>((resolve) => socket.listen(0, '127.0.0.1', resolve));
  const address = socket.address();
  if (!address || typeof address === 'string') throw new Error('No browser test port');
  await new Promise<void>((resolve) => socket.close(() => resolve()));
  return address.port;
}

/** Serve the built browser app against the shared database with the given settings. */
async function start(settings: Record<string, string>) {
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const config = parseConfig({
    COMMUNITY_DATABASE_URL: dbUrl.toString(),
    COMMUNITY_AUTH_SECRET: 'a'.repeat(32),
    COMMUNITY_INVITE_SECRET: 'b'.repeat(32),
    COMMUNITY_BOOTSTRAP_SECRET: 'c'.repeat(32),
    COMMUNITY_PUBLIC_URL: baseUrl,
    COMMUNITY_STORAGE_PATH: blobDir,
    COMMUNITY_INVITE_PREVIEW_ATTEMPTS_PER_MINUTE: '100',
    ...settings,
  });
  const app = createCommunityApp({ config, pool });
  const staticRoot = fileURLToPath(new URL('../dist/', import.meta.url));
  app.use('/assets/*', serveStatic({ root: staticRoot }));
  for (const path of ['/', '/host', '/c/:communityId', '/c/:communityId/*'])
    app.get(
      path,
      serveStatic({ path: fileURLToPath(new URL('../dist/index.html', import.meta.url)) })
    );
  const server = serve({ fetch: app.fetch, port, hostname: '127.0.0.1' });
  await new Promise<void>((resolve) => server.once('listening', resolve));
  servers.push(server);
  return { baseUrl, config };
}

function call(path: string, method: string, body: unknown, cookie: string) {
  return fetch(`${plainUrl}${path}`, {
    method,
    headers: {
      origin: plainUrl,
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
    baseURL: plainUrl,
    extraHTTPHeaders: { origin: plainUrl },
  });
  try {
    expect((await api.post(`${tenant()}/invites/preflight`, { data: { token } })).ok()).toBe(true);
    expect(
      (await api.post('/api/auth/sign-up/email', { data: { name, email, password } })).ok()
    ).toBe(true);
    expect((await api.post(`${tenant()}/invites/bind`, { data: {} })).ok()).toBe(true);
    expect((await api.post(`${tenant()}/invites/redeem`, { data: {} })).ok()).toBe(true);
  } finally {
    await api.dispose();
  }
  const signedIn = await call('/api/auth/sign-in/email', 'POST', { email, password }, '');
  expect(signedIn.status).toBe(200);
  const cookie = responseCookies(signedIn);
  expect((await call(`${tenant()}/channels/${channelId}/join`, 'POST', {}, cookie)).ok).toBe(true);
  return { cookie };
}

/** Post one message as `cookie`, optionally with one freshly uploaded file. */
async function postMessage(cookie: string, text: string, file?: string) {
  const attachmentIds: string[] = [];
  if (file) {
    const uploaded = await fetch(`${plainUrl}${tenant()}/channels/${channelId}/attachments`, {
      method: 'POST',
      headers: {
        origin: plainUrl,
        cookie,
        'content-type': 'text/plain',
        'x-file-name': file,
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
    { text, idempotencyKey: randomUUID(), attachmentIds },
    cookie
  );
  expect(posted.status).toBe(201);
  const { entry } = (await posted.json()) as {
    entry: { id: string; attachments: { id: string }[] };
  };
  return { id: entry.id, attachmentId: entry.attachments[0]?.id ?? '' };
}

/** A browser context signed in with `cookie`, for the plain server. */
async function contextFor(browser: Browser, cookie: string): Promise<BrowserContext> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await context.addCookies(
    cookie.split('; ').map((pair) => {
      const at = pair.indexOf('=');
      return { name: pair.slice(0, at), value: pair.slice(at + 1), url: plainUrl };
    })
  );
  return context;
}

/** The host operator signed in on `baseUrl`, on the host page, with the Take down section open. */
async function openTakedowns(page: Page, baseUrl: string): Promise<Locator> {
  const signedIn = await page.context().request.post(`${baseUrl}/api/auth/sign-in/email`, {
    headers: { origin: baseUrl },
    data: operator,
  });
  expect(signedIn.ok()).toBe(true);
  await page.goto(`${baseUrl}/host`);
  const record = page.getByRole('article', { name: 'Takedown Place community' });
  await record.getByText('Take down content', { exact: true }).click();
  const section = record.getByRole('region', { name: 'Takedown Place takedowns' });
  await expect(section.getByRole('heading', { name: 'Takedowns' })).toBeVisible();
  return section;
}

/** Wait until the page has read this community's takedown notices, and return them. */
async function noticesRead(page: Page) {
  const response = await page.waitForResponse((candidate) =>
    candidate.url().endsWith(`/communities/${communityId}/takedowns`)
  );
  expect(response.status()).toBe(200);
  return ((await response.json()) as { takedowns: { id: string; yours: boolean }[] }).takedowns;
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
    await page.screenshot({ path: join(shots, `${name}-${width}.png`), fullPage: true });
  }
  if (original) await page.setViewportSize(original);
}

/** Run axe's WCAG A/AA rules on the page as it stands, at desktop and phone width. */
async function assertAccessible(page: Page, label: string) {
  const original = page.viewportSize();
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 844 });
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
  blobDir = await mkdtemp(join(tmpdir(), 'community-browser-takedown-'));
  await mkdir(evidenceDirectory, { recursive: true });
  const plain = await start({ COMMUNITY_REPORT_ABUSE_URL: REPORT });
  plainUrl = plain.baseUrl;
  storedUrl = (
    await start({
      COMMUNITY_EVIDENCE_DRIVER: 'filesystem',
      COMMUNITY_EVIDENCE_PATH: evidenceDirectory,
    })
  ).baseUrl;
  const setup = await bootstrapFirstHost((path, body, cookie) => call(path, 'POST', body, cookie), {
    secret: plain.config.bootstrapSecret,
    accountName: 'Olive Owner',
    email: operator.email,
    password,
    communityName: 'Takedown Place',
    channelName: 'general',
  });
  ownerCookie = setup.cookie;
  communityId = setup.communityId;
  channelId = setup.channelId;
  mia = await admitNewAccount('Mia Author', 'mia@takedown.test');
  ada = await admitNewAccount('Ada Other', 'ada@takedown.test');
  toldEntry = (await postMessage(mia.cookie, TOLD_TEXT)).id;
  quietEntry = (await postMessage(mia.cookie, QUIET_TEXT)).id;
  fileEntry = await postMessage(mia.cookie, 'mia-file-message', FILE_NAME);
});

test.afterAll(async () => {
  for (const server of servers) {
    if ('closeAllConnections' in server) server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  await pool?.end();
  await admin.query(`DROP DATABASE IF EXISTS ${dbName}`);
  await admin.end();
  if (blobDir) await rm(blobDir, { recursive: true, force: true });
  await rm(evidenceDirectory, { recursive: true, force: true });
});

test.setTimeout(120_000);

test('a host takes down a message; its author and the owner are told, another member is not', async ({
  browser,
}) => {
  // Fails if the no-store warning is missing, the tell box ignores the reason, a wrong password
  // writes anything, the list misstates the takedown, the page shows content, the author's banner
  // is missing or comes back once dismissed, the owner's list is missing, or anyone else is told.
  const hostContext = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await hostContext.newPage();
  try {
    const section = await openTakedowns(page, plainUrl);
    await expect(section).toContainText(
      'Takedowns won’t keep a copy for the authorities. Set an evidence store first if you need one.'
    );
    await expect(section.getByText('Nothing has been taken down here.')).toBeVisible();

    // The tell box follows the reason: off for child safety, on for every other.
    const tell = section.getByLabel('Tell the owner and the author');
    await expect(tell).toBeChecked();
    await section.getByLabel('Reason').selectOption('child_safety');
    await expect(tell).not.toBeChecked();
    await section.getByLabel('Reason').selectOption('illegal_content');
    await expect(tell).toBeChecked();

    // An ID is required, and a wrong password takes nothing down.
    const submit = section.getByRole('button', { name: 'Take down', exact: true });
    await section.getByLabel('Message ID').fill('not-an-id');
    await expect(section.getByText('That is not an ID.', { exact: false })).toBeVisible();
    await section.getByLabel('Message ID').fill(toldEntry);
    await section.getByLabel('Your case number (optional)').fill('CASE-7');
    await section.getByLabel('Your password').fill('not-my-password');
    await submit.click();
    await expect(section.getByRole('alert')).toHaveText(
      'That password is not right. Nothing was taken down.'
    );
    expect((await pool.query('SELECT 1 FROM community_takedowns')).rowCount).toBe(0);

    await section.getByLabel('Your password').fill(password);
    await submit.click();
    await expect(section.getByRole('status')).toHaveText(
      'Taken down. Members of Takedown Place no longer see it.'
    );
    const row = section.getByRole('listitem', { name: `Message ${toldEntry} takedown` });
    await expect(row).toContainText('Illegal content (CASE-7)');
    await expect(row).toContainText('Owner and author told');
    await expect(row).toContainText('No evidence store');
    await expect(row.getByRole('button')).toHaveCount(0);
    const stored = await pool.query<{ category: string; notify: boolean; reference: string }>(
      'SELECT category,notify,reference FROM community_takedowns WHERE entry_id=$1',
      [toldEntry]
    );
    expect(stored.rows).toEqual([
      { category: 'illegal_content', notify: true, reference: 'CASE-7' },
    ]);
    await expect(page.locator('body')).not.toContainText(TOLD_TEXT);
    await assertAccessible(page, 'host takedowns');
    await shot(page, 'host-takedown-listed', section);
  } finally {
    await hostContext.close();
  }

  // The author sees the banner with the reason, the case number and a way to dispute it.
  const miaContext = await contextFor(browser, mia.cookie);
  try {
    const miaPage = await miaContext.newPage();
    const read = noticesRead(miaPage);
    await miaPage.goto(`${plainUrl}/c/${communityId}`);
    expect((await read).map((notice) => notice.yours)).toEqual([true]);
    const banner = miaPage.getByRole('status').filter({ hasText: 'The host removed one of your' });
    await expect(banner).toContainText(
      /The host removed one of your messages on .+\. It was reported to the host as illegal\./u
    );
    await expect(banner).toContainText('Reference: CASE-7.');
    const contact = banner.getByRole('link', { name: /contact the host/u });
    const href = new URL((await contact.getAttribute('href')) ?? '');
    expect([...href.searchParams.entries()]).toEqual([
      ['community', communityId],
      ['entry', toldEntry],
    ]);
    await expect(miaPage.getByText('This message was removed by the host.')).toBeVisible();
    await assertAccessible(miaPage, 'author banner');
    await shot(miaPage, 'author-takedown-banner');
    await banner.getByRole('button', { name: 'Dismiss' }).click();
    await expect(banner).toHaveCount(0);
    const reread = noticesRead(miaPage);
    await miaPage.reload();
    await reread;
    await expect(miaPage.getByRole('heading', { name: '# general' })).toBeVisible();
    await expect(miaPage.getByText(/The host removed one of your/u)).toHaveCount(0);
  } finally {
    await miaContext.close();
  }

  // The owner sees it in Settings, with the channel's name, and no author banner.
  const ownerContext = await contextFor(browser, ownerCookie);
  try {
    const ownerPage = await ownerContext.newPage();
    const read = noticesRead(ownerPage);
    await ownerPage.goto(`${plainUrl}/c/${communityId}/settings/settings`);
    expect((await read).map((notice) => notice.yours)).toEqual([false]);
    const list = ownerPage.getByRole('region', { name: 'Removed by the host' });
    await expect(list).toContainText('A message in #general');
    await expect(list).toContainText('It was reported to the host as illegal.');
    await expect(list).toContainText('Reference: CASE-7.');
    await expect(list.getByRole('link', { name: /contact the host/u })).toBeVisible();
    await expect(ownerPage.getByText(/The host removed one of your/u)).toHaveCount(0);
    await assertAccessible(ownerPage, 'removed by the host');
    await shot(ownerPage, 'owner-removed-by-host', list);
  } finally {
    await ownerContext.close();
  }

  // Another member is told nothing.
  const adaContext = await contextFor(browser, ada.cookie);
  try {
    const adaPage = await adaContext.newPage();
    const read = noticesRead(adaPage);
    await adaPage.goto(`${plainUrl}/c/${communityId}`);
    expect(await read).toEqual([]);
    await expect(adaPage.getByText('This message was removed by the host.')).toBeVisible();
    await expect(adaPage.getByText(/The host removed one of your/u)).toHaveCount(0);
  } finally {
    await adaContext.close();
  }
});

test('a child-safety takedown tells no one, and its kept copy is released only with a password and no legal hold', async ({
  browser,
}) => {
  // Fails if a withheld takedown reaches the author or the owner, Release shows outside its
  // state or under a legal hold, or releasing skips the password.
  const hostContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await hostContext.newPage();
  try {
    const section = await openTakedowns(page, plainUrl);
    await section.getByLabel('Reason').selectOption('child_safety');
    await expect(section.getByLabel('Tell the owner and the author')).not.toBeChecked();
    await section.getByLabel('Message ID').fill(quietEntry);
    await section.getByLabel('Your password').fill(password);
    await section.getByRole('button', { name: 'Take down', exact: true }).click();
    const row = section.getByRole('listitem', { name: `Message ${quietEntry} takedown` });
    await expect(row).toContainText('Child safety');
    await expect(row).toContainText('Owner and author not told');
    // The next case starts from the default reason, with its default tell box.
    await expect(section.getByLabel('Reason', { exact: true })).toHaveValue('illegal_content');
    await expect(section.getByLabel('Tell the owner and the author')).toBeChecked();
    await expect(row).toContainText('Kept on this server until you release it');
    await expect(row.getByRole('button', { name: 'Try again' })).toHaveCount(0);
    await expect(row.getByRole('button', { name: 'Release' })).toBeVisible();
    // Every button on a phone is a 44px target.
    expect((await row.getByRole('button', { name: 'Release' }).boundingBox())!.height).toBe(44);

    // Under a legal hold the copy cannot be released, and the page says so instead.
    const held = await call(
      `/api/v1/host/communities/${communityId}/legal-hold`,
      'PUT',
      { reference: null },
      ownerCookie
    );
    expect(held.status).toBe(200);
    const reopened = await openTakedowns(page, plainUrl);
    const heldRow = reopened.getByRole('listitem', { name: `Message ${quietEntry} takedown` });
    await expect(heldRow).toContainText(
      'It can’t be released while this community is under a legal hold.'
    );
    await expect(heldRow.getByRole('button', { name: 'Release' })).toHaveCount(0);
    await shot(page, 'host-takedown-legal-hold', heldRow);

    // A hold placed while the page was open is refused by the server, and the dialog says why.
    expect(
      (
        await call(
          `/api/v1/host/communities/${communityId}/legal-hold`,
          'DELETE',
          undefined,
          ownerCookie
        )
      ).status
    ).toBe(200);
    const released = await openTakedowns(page, plainUrl);
    const releasable = released.getByRole('listitem', { name: `Message ${quietEntry} takedown` });
    await releasable.getByRole('button', { name: 'Release' }).click();
    const dialog = page.getByRole('dialog', { name: 'Release the kept copy?' });
    await expect(dialog.getByRole('button', { name: 'Release and delete' })).toBeDisabled();
    await dialog.getByLabel('Your password').fill('not-my-password');
    await dialog.getByRole('button', { name: 'Release and delete' }).click();
    await expect(dialog.getByRole('alert')).toHaveText(
      'That password is not right. Nothing was released.'
    );
    await call(
      `/api/v1/host/communities/${communityId}/legal-hold`,
      'PUT',
      { reference: null },
      ownerCookie
    );
    await dialog.getByLabel('Your password').fill(password);
    await dialog.getByRole('button', { name: 'Release and delete' }).click();
    await expect(dialog.getByRole('alert')).toContainText('under a legal hold');
    await assertAccessible(page, 'release dialog');
    await shot(page, 'host-takedown-release-dialog');
    await call(
      `/api/v1/host/communities/${communityId}/legal-hold`,
      'DELETE',
      undefined,
      ownerCookie
    );
    await dialog.getByRole('button', { name: 'Release and delete' }).click();
    await expect(dialog).toBeHidden();
    await expect(releasable).toContainText('No evidence store');
    await expect(releasable.getByRole('button')).toHaveCount(0);
    expect(
      (
        await pool.query('SELECT evidence_state FROM community_takedowns WHERE entry_id=$1', [
          quietEntry,
        ])
      ).rows
    ).toEqual([{ evidence_state: 'not_configured' }]);
  } finally {
    await hostContext.close();
  }

  // Withheld: the owner's list still holds only the first takedown, and the author has no banner.
  const ownerContext = await contextFor(browser, ownerCookie);
  try {
    const ownerPage = await ownerContext.newPage();
    const read = noticesRead(ownerPage);
    await ownerPage.goto(`${plainUrl}/c/${communityId}/settings/settings`);
    expect(await read).toHaveLength(1);
    await expect(
      ownerPage.getByRole('region', { name: 'Removed by the host' }).getByRole('listitem')
    ).toHaveCount(1);
  } finally {
    await ownerContext.close();
  }
  const miaContext = await contextFor(browser, mia.cookie);
  try {
    const miaPage = await miaContext.newPage();
    const read = noticesRead(miaPage);
    await miaPage.goto(`${plainUrl}/c/${communityId}`);
    // Only the first, which this fresh browser has not dismissed: the withheld one never shows.
    expect((await read).map((notice) => notice.id)).toHaveLength(1);
    await expect(miaPage.getByText(/The host removed one of your/u)).toHaveCount(1);
    await expect(miaPage.getByText('This message was removed by the host.')).toHaveCount(2);
  } finally {
    await miaContext.close();
  }
});

test('with an evidence store the warning is gone, and each copy state reads plainly with Try again only when failed', async ({
  browser,
}) => {
  // Fails if the warning shows with a store, a state's wording is wrong, Try again shows outside
  // the failed state or does not send the copy back, or an overdue copy is not marked.
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  try {
    const section = await openTakedowns(page, storedUrl);
    await expect(section.getByText(/Takedowns won’t keep a copy/u)).toHaveCount(0);
    await section.getByLabel('What to take down').selectOption('attachment');
    await section.getByLabel('File ID').fill(fileEntry.attachmentId);
    await section.getByLabel('Reason').selectOption('legal_order');
    // A tell box changed by hand is kept for this case, and reset for the next one.
    await section.getByLabel('Tell the owner and the author').uncheck();
    await section.getByLabel('Your password').fill(password);
    await section.getByRole('button', { name: 'Take down', exact: true }).click();
    const row = section.getByRole('listitem', { name: `File ${fileEntry.attachmentId} takedown` });
    await expect(row).toContainText('Legal order');
    await expect(row).toContainText('Owner and author not told');
    await expect(section.getByLabel('Reason', { exact: true })).toHaveValue('illegal_content');
    await expect(section.getByLabel('Tell the owner and the author')).toBeChecked();
    await expect(row).toContainText('Saving the copy…');
    await expect(row.getByRole('button')).toHaveCount(0);
    await expect(page.locator('body')).not.toContainText(FILE_NAME);

    const setState = (state: string, hoursAgo = 0) =>
      pool.query(
        `UPDATE community_takedowns SET evidence_state=$2::text,
           created_at=now()-make_interval(hours=>$3),
           evidence_record_sha256=CASE WHEN $2::text='stored' THEN repeat('a',64) END,
           evidence_location=CASE WHEN $2::text='stored' THEN 'takedowns/x/attempt-1/' END,
           next_attempt_at=CASE WHEN $2::text IN ('pending','retrying') THEN now() END
         WHERE attachment_id=$1`,
        [fileEntry.attachmentId, state, hoursAgo]
      );
    const reopen = async () => {
      const reopened = await openTakedowns(page, storedUrl);
      return reopened.getByRole('listitem', { name: `File ${fileEntry.attachmentId} takedown` });
    };

    await setState('failed');
    let current = await reopen();
    await expect(current).toContainText('Couldn’t save the copy');
    await expect(current.getByRole('button', { name: 'Release' })).toHaveCount(0);
    await current.getByRole('button', { name: 'Try again' }).click();
    await expect(current).toContainText('Saving the copy…');
    await expect(current.getByRole('button', { name: 'Try again' })).toHaveCount(0);
    expect(
      (
        await pool.query('SELECT evidence_state FROM community_takedowns WHERE attachment_id=$1', [
          fileEntry.attachmentId,
        ])
      ).rows
    ).toEqual([{ evidence_state: 'pending' }]);

    await setState('retrying', 7);
    current = await reopen();
    await expect(current).toContainText('Couldn’t save the copy yet; retrying');
    await expect(current).toContainText('Overdue: check the evidence store.');
    await assertAccessible(page, 'overdue takedown');
    await shot(page, 'host-takedown-overdue', current);

    await setState('stored', 7);
    current = await reopen();
    await expect(current).toContainText('Copy saved');
    await expect(current).not.toContainText('Overdue');

    await setState('nothing_to_preserve');
    current = await reopen();
    await expect(current).toContainText('Nothing left to save');
  } finally {
    await context.close();
  }
});
