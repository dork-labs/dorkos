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

const adminUrl = process.env.COMMUNITY_TEST_DATABASE_URL;
if (!adminUrl)
  throw new Error('COMMUNITY_TEST_DATABASE_URL is required for community browser tests');
const dbName = `community_browser_ui_${randomUUID().replaceAll('-', '')}`;
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
  blobDir = await mkdtemp(join(tmpdir(), 'community-browser-ui-'));
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
  for (const path of ['/', '/join', '/pairing'])
    app.get(
      path,
      serveStatic({ path: fileURLToPath(new URL('../dist/index.html', import.meta.url)) })
    );
  server = serve({ fetch: app.fetch, port, hostname: '127.0.0.1' });
  await new Promise<void>((resolve) => server.once('listening', resolve));
});
test.afterAll(async () => {
  server?.closeAllConnections();
  await new Promise<void>((resolve) => server?.close(() => resolve()));
  await pool?.end();
  await admin.query(`DROP DATABASE IF EXISTS ${dbName}`);
  await admin.end();
  if (blobDir) await rm(blobDir, { recursive: true, force: true });
});

test.setTimeout(90_000);

test('owner and invited member join, chat, thread, upload, export and leave in separate browser contexts', async ({
  browser,
}) => {
  const owner = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const ownerPage = await owner.newPage();
  const member = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const memberPage = await member.newPage();
  const observer = await browser.newContext({ viewport: { width: 800, height: 900 } });
  const observerPage = await observer.newPage();
  try {
    await ownerPage.goto(baseUrl);
    await expect(ownerPage.getByRole('heading', { name: 'Make it yours.' })).toBeVisible();
    await ownerPage.getByLabel('Setup secret').fill('c'.repeat(32));
    await ownerPage.getByRole('button', { name: 'Continue' }).click();
    await ownerPage.getByLabel('Your name').fill('Owner');
    await ownerPage.getByLabel('Email').fill('owner@ui.test');
    await ownerPage.getByLabel('Password').fill('password1234');
    await ownerPage.getByLabel('Community name').fill('Gathering Place');
    await ownerPage.getByLabel('First channel').fill('general');
    await ownerPage.getByRole('button', { name: 'Create community' }).click();
    await expect(ownerPage.getByRole('heading', { name: '# general' })).toBeVisible({
      timeout: 15000,
    });
    await ownerPage.screenshot({ path: '/tmp/community-owner-desktop.png', fullPage: true });
    await ownerPage.getByRole('button', { name: 'Manage' }).click();
    await ownerPage.locator('#invite-channel').selectOption({ label: '#general' });
    await ownerPage.getByRole('button', { name: 'Create invite' }).click();
    const inviteLink = await ownerPage.getByLabel('One-time invite link').inputValue();
    expect(inviteLink).toContain('/join#invite=');
    await memberPage.goto(inviteLink);
    await expect(memberPage.getByRole('heading', { name: 'Come on in.' })).toBeVisible();
    await memberPage.screenshot({ path: '/tmp/community-join-mobile.png', fullPage: true });
    await expect.poll(() => memberPage.evaluate(() => location.hash)).toBe('');
    await memberPage.getByRole('button', { name: 'Continue' }).click();
    await expect(memberPage.getByText('Gathering Place')).toBeVisible();
    await memberPage.getByLabel('Your name').fill('Maya');
    await memberPage.getByLabel('Email').fill('maya@ui.test');
    await memberPage.getByLabel('Password').fill('password1234');
    await memberPage.getByRole('button', { name: 'Join community' }).click();
    await expect(memberPage.getByRole('button', { name: 'Open channel navigation' })).toBeVisible({
      timeout: 15000,
    });
    await memberPage.screenshot({ path: '/tmp/community-member-mobile.png', fullPage: true });
    await memberPage.getByRole('button', { name: 'Open channel navigation' }).click();
    await expect(
      memberPage.getByRole('complementary', { name: 'Community channels' })
    ).toBeVisible();
    await memberPage.getByRole('button', { name: 'Close channel navigation' }).click();
    await ownerPage.getByRole('button', { name: 'Close' }).click();
    await memberPage.getByLabel('Message #general').fill('Hello from Maya');
    await memberPage.getByRole('button', { name: 'Send' }).click();
    await expect(ownerPage.getByText('Hello from Maya')).toBeVisible();
    await ownerPage.getByRole('button', { name: 'Reply in thread' }).click();
    await ownerPage.getByLabel('Reply in thread').fill('Welcome!');
    await ownerPage.getByRole('button', { name: 'Reply', exact: true }).click();
    await expect(ownerPage.locator('.drawer .entry-text').getByText('Welcome!')).toBeVisible();
    await expect
      .poll(async () =>
        ownerPage.evaluate(async () => {
          const channel = (await (await fetch('/api/v1/channels')).json()).channels[0];
          return (await (await fetch(`/api/v1/channels/${channel.id}/read-cursor`)).json())
            .unreadCount;
        })
      )
      .toBe(0);
    await ownerPage.screenshot({ path: '/tmp/community-thread-desktop.png', fullPage: true });
    await expect
      .poll(
        async () =>
          await memberPage.evaluate(
            async () =>
              (
                await (
                  await fetch(
                    '/api/v1/channels/' +
                      (await (await fetch('/api/v1/channels')).json()).channels[0].id +
                      '/read-cursor'
                  )
                ).json()
              ).unreadCount
          )
      )
      .toBe(0);
    await ownerPage.getByRole('button', { name: 'Close thread' }).first().click();
    await memberPage
      .getByLabel('Add files')
      .locator('input')
      .setInputFiles({
        name: 'notes.txt',
        mimeType: 'text/plain',
        buffer: Buffer.from('Community notes'),
      });
    await memberPage.getByLabel('Message #general').fill('Here are the notes');
    await memberPage.getByRole('button', { name: 'Send' }).click();
    await expect(ownerPage.getByText('Here are the notes')).toBeVisible();
    const file = ownerPage.getByRole('button', { name: 'notes.txt' });
    await expect(file).toBeVisible();
    await expect
      .poll(async () =>
        ownerPage.evaluate(async () => {
          const channel = (await (await fetch('/api/v1/channels')).json()).channels[0];
          return (await (await fetch(`/api/v1/channels/${channel.id}/read-cursor`)).json())
            .unreadCount;
        })
      )
      .toBe(0);
    await memberPage.screenshot({ path: '/tmp/community-chat-mobile.png', fullPage: true });
    await ownerPage.setViewportSize({ width: 900, height: 800 });
    await ownerPage.emulateMedia({ colorScheme: 'dark' });
    await ownerPage.screenshot({ path: '/tmp/community-chat-tablet-dark.png', fullPage: true });
    await ownerPage.setViewportSize({ width: 1440, height: 900 });
    await ownerPage.emulateMedia({ colorScheme: 'light' });
    const downloaded = ownerPage.waitForEvent('download');
    await file.click();
    expect((await downloaded).suggestedFilename()).toBe('notes.txt');
    const attachmentId = await ownerPage.evaluate(async () => {
      const channel = (await (await fetch('/api/v1/channels')).json()).channels.find(
        (item: { name: string }) => item.name === 'general'
      );
      const page = await (await fetch(`/api/v1/channels/${channel.id}/entries`)).json();
      return page.entries.find((entry: { text: string }) => entry.text === 'Here are the notes')
        .attachments[0].id as string;
    });
    await ownerPage.getByRole('button', { name: 'Manage' }).click();
    await ownerPage.locator('#invite-channel').selectOption('');
    await ownerPage.getByRole('button', { name: 'Create invite' }).click();
    const observerLink = await ownerPage.getByLabel('One-time invite link').inputValue();
    await observerPage.goto(observerLink);
    await observerPage.getByRole('button', { name: 'Continue' }).click();
    await observerPage.getByLabel('Your name').fill('Niko');
    await observerPage.getByLabel('Email').fill('niko@ui.test');
    await observerPage.getByLabel('Password').fill('password1234');
    await observerPage.getByRole('button', { name: 'Join community' }).click();
    await expect(observerPage.getByRole('button', { name: 'Join channel' })).toBeVisible();
    expect(
      await observerPage.evaluate(
        async (id) => (await fetch(`/api/v1/attachments/${id}`)).status,
        attachmentId
      )
    ).toBe(403);
    await ownerPage.getByRole('button', { name: 'Members' }).click();
    await expect(ownerPage.getByRole('button', { name: 'Make Niko admin' })).toBeVisible({
      timeout: 7000,
    });
    await ownerPage.getByRole('button', { name: 'Make Niko admin' }).click();
    await expect(ownerPage.getByRole('button', { name: 'Remove admin from Niko' })).toBeVisible();
    expect(
      await observerPage.evaluate(
        async (id) => (await fetch(`/api/v1/attachments/${id}`)).status,
        attachmentId
      )
    ).toBe(403);
    const nikoId = await ownerPage
      .locator('#add-member option')
      .evaluateAll(
        (options) =>
          (options.find((option) => option.textContent?.includes('Niko')) as HTMLOptionElement)
            .value
      );
    await ownerPage.locator('#add-member').selectOption(nikoId);
    await ownerPage.getByRole('button', { name: 'Add to channel' }).click();
    await expect
      .poll(async () =>
        observerPage.evaluate(
          async (id) => (await fetch(`/api/v1/attachments/${id}`)).status,
          attachmentId
        )
      )
      .toBe(200);
    await ownerPage.screenshot({ path: '/tmp/community-members-desktop.png', fullPage: true });
    await memberPage
      .getByLabel('Add files')
      .locator('input')
      .setInputFiles({
        name: 'bad.exe',
        mimeType: 'application/octet-stream',
        buffer: Buffer.from([0, 255, 0, 255]),
      });
    await memberPage.getByLabel('Message #general').fill('A rejected file');
    await memberPage.getByRole('button', { name: 'Send' }).click();
    await expect(memberPage.getByRole('alert')).toContainText('file type is not supported');
    await expect(memberPage.getByText(/Uploading \d+%/)).toHaveCount(0);
    await expect(memberPage.getByRole('button', { name: 'Retry sending' })).toHaveCount(0);
    await expect(
      memberPage.getByText('Remove the rejected file, then choose a supported file.')
    ).toBeVisible();
    await expect(memberPage.getByRole('button', { name: 'Remove rejected file' })).toBeVisible();
    await memberPage.screenshot({ path: '/tmp/community-file-error-mobile.png', fullPage: true });
    await memberPage.getByRole('button', { name: 'Remove rejected file' }).click();
    await expect(memberPage.getByRole('alert')).toHaveCount(0);
    await memberPage.getByLabel('Message #general').fill('');
    await memberPage.getByRole('button', { name: 'Manage' }).click();
    await memberPage.getByRole('button', { name: 'Account' }).click();
    const exportDownload = memberPage.waitForEvent('download');
    await memberPage.getByRole('button', { name: 'Export my data' }).click();
    expect((await exportDownload).suggestedFilename()).toBe('my-community-data.zip');
    memberPage.once('dialog', (dialog) => void dialog.accept());
    await memberPage.getByRole('button', { name: 'Leave community' }).click();
    await expect(memberPage.getByRole('heading', { name: 'Come on in.' })).toBeVisible();
  } finally {
    await owner.close();
    await member.close();
    await observer.close();
  }
});
