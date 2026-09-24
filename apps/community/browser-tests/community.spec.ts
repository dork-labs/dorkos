import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { test, expect, type Route } from '@playwright/test';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Pool } from 'pg';
import { communitySettingsPath } from '@dorkos/shared/community-wire';
import { interceptNext } from '@dorkos/test-utils/playwright-routes';
import { createCommunityApp } from '../src/app.js';
import { parseConfig } from '../src/config.js';
import { migrate } from '../src/migrate.js';
import { startExportWorker } from '../src/exports/worker.js';
import { createBlobStore } from '../src/storage/index.js';

declare global {
  interface Window {
    /** Test-owned event stream used to exercise the reconnect state. */
    __communityStream?: {
      fail(): void;
      emit(type: string, value: unknown): void;
    };
  }
}

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
let exportWorker: ReturnType<typeof setInterval> | undefined;
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
  const blobStore = createBlobStore(config);
  const app = createCommunityApp({ config, pool, blobStore });
  // Exports are built in the background, as main.ts runs them.
  exportWorker = startExportWorker({
    pool,
    blobStore,
    settings: config.exports,
    concurrency: 1,
    pollMs: 1_500,
  });
  const staticRoot = fileURLToPath(new URL('../dist/', import.meta.url));
  app.use('/assets/*', serveStatic({ root: staticRoot }));
  for (const path of [
    '/',
    '/host',
    '/join',
    '/claim',
    '/pairing',
    '/c/:communityId',
    '/c/:communityId/join',
    '/c/:communityId/deletion',
    '/c/:communityId/settings',
    '/c/:communityId/settings/:section',
  ])
    app.get(
      path,
      serveStatic({ path: fileURLToPath(new URL('../dist/index.html', import.meta.url)) })
    );
  server = serve({ fetch: app.fetch, port, hostname: '127.0.0.1' });
  await new Promise<void>((resolve) => server.once('listening', resolve));
});
test.afterAll(async () => {
  clearInterval(exportWorker);
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
    await interceptNext(ownerPage, '**/api/v1/host/communities', (route) =>
      route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({
          code: 'UNAVAILABLE',
          message: 'Host list is temporarily unavailable.',
        }),
      })
    );
    await ownerPage.goto(`${baseUrl}/host`);
    await expect(ownerPage.getByRole('alert')).toContainText('temporarily unavailable');
    await expect(ownerPage.getByText('No communities are available.')).toHaveCount(0);
    await ownerPage.getByRole('button', { name: 'Try again' }).click();
    await expect(ownerPage.getByRole('heading', { name: 'Communities' })).toBeVisible();
    await expect(ownerPage.getByRole('link', { name: 'Deploy a new host' })).toHaveAttribute(
      'href',
      'https://dorkos.ai/docs/self-hosting/deployment'
    );
    await expect(ownerPage.getByLabel('Gathering Place community')).toContainText('Owner assigned');
    await expect(ownerPage.getByText('Community members')).toHaveCount(0);
    await ownerPage
      .getByLabel('Gathering Place community')
      .getByRole('button', { name: 'Suspend' })
      .click();
    const suspendDialog = ownerPage.getByRole('dialog', { name: 'Suspend Gathering Place?' });
    await expect(suspendDialog.getByRole('button', { name: 'Cancel' })).toBeFocused();
    await ownerPage.keyboard.press('Escape');
    await expect(suspendDialog).toBeHidden();
    await ownerPage.goto(baseUrl);
    await expect(ownerPage.getByRole('heading', { name: '# general' })).toBeVisible({
      timeout: 15000,
    });
    await ownerPage.screenshot({ path: '/tmp/community-owner-desktop.png', fullPage: true });
    await interceptNext(
      ownerPage,
      '**/settings',
      (route) =>
        route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({
            code: 'UNAVAILABLE',
            message: 'Settings are temporarily unavailable.',
          }),
        }),
      // Opening Manage reads settings once for the invite panel's closed state, and the
      // Settings section reads them again; both reads fail here, and the retry goes through.
      { count: 2, filter: (route) => route.request().method() === 'GET' }
    );
    await ownerPage.getByRole('button', { name: 'Manage' }).click();
    await ownerPage
      .getByRole('navigation', { name: 'Settings sections' })
      .getByRole('button', { name: 'Settings', exact: true })
      .click();
    await expect(ownerPage.getByRole('alert')).toContainText('temporarily unavailable');
    await ownerPage.getByRole('button', { name: 'Try again' }).click();
    await expect(ownerPage.getByRole('heading', { name: 'Presentation' })).toBeVisible();
    await ownerPage
      .getByRole('navigation', { name: 'Settings sections' })
      .getByRole('button', { name: 'Community' })
      .click();
    await ownerPage.locator('#invite-channel').selectOption({ label: '#general' });
    await ownerPage.getByRole('button', { name: 'Create invite' }).click();
    const inviteLink = await ownerPage.getByLabel('One-time invite link').inputValue();
    expect(inviteLink).toMatch(/\/c\/[0-9a-f-]+\/join#invite=/u);
    await memberPage.goto(inviteLink.replace('#invite=', '#token='));
    await expect(memberPage.getByRole('heading', { name: 'Come on in.' })).toBeVisible();
    await memberPage.screenshot({ path: '/tmp/community-join-mobile.png', fullPage: true });
    await expect.poll(() => memberPage.evaluate(() => location.hash)).toBe('');
    await memberPage.getByRole('button', { name: 'Continue' }).click();
    await expect(memberPage.getByRole('heading', { name: 'Join Gathering Place' })).toBeFocused();
    await expect(memberPage.getByText('Invited by Owner')).toBeVisible();
    await memberPage.getByLabel('Your name').fill('Maya');
    await memberPage.getByLabel('Email').fill('maya@ui.test');
    await memberPage.getByLabel('Password').fill('password1234');
    await memberPage.getByRole('button', { name: 'Join community' }).click();
    await expect(
      memberPage.getByRole('heading', { name: 'You’re in Gathering Place.' })
    ).toBeVisible();
    await expect(memberPage.getByText('Connect this DorkOS installation')).toBeVisible();
    await memberPage.getByRole('button', { name: 'Open community' }).click();
    await expect(memberPage.getByRole('button', { name: 'Open channel navigation' })).toBeVisible({
      timeout: 15000,
    });
    await memberPage.screenshot({ path: '/tmp/community-member-mobile.png', fullPage: true });
    await memberPage.getByRole('button', { name: 'Open channel navigation' }).click();
    await expect(
      memberPage.getByRole('complementary', { name: 'Community channels' })
    ).toBeVisible();
    // The scrim deliberately sits below the open sidebar. Click its exposed
    // right gutter, as a person dismissing the mobile navigation would.
    await memberPage.mouse.click(380, 420);
    await expect(
      memberPage.getByRole('complementary', { name: 'Community channels' })
    ).not.toHaveClass(/open/);
    await ownerPage
      .getByRole('navigation', { name: 'Settings sections' })
      .getByRole('button', { name: 'Settings', exact: true })
      .click();
    await expect(ownerPage.getByRole('heading', { name: 'Presentation' })).toBeVisible();
    await expect(ownerPage.getByRole('heading', { name: 'Access' })).toBeVisible();
    await expect(ownerPage.getByRole('heading', { name: 'People', exact: true })).toBeVisible();
    await expect(ownerPage.getByRole('heading', { name: 'Export' })).toBeVisible();
    await expect(ownerPage.getByRole('heading', { name: 'Danger zone' })).toBeVisible();
    const settingsCommunityId = await ownerPage.evaluate(async () => {
      const response = await fetch('/api/v1/community');
      return ((await response.json()) as { id: string }).id;
    });
    await ownerPage.getByLabel('Name', { exact: true }).fill('My unsaved name');
    await ownerPage.getByLabel('Description').fill('My unsaved description');
    await interceptNext(
      ownerPage,
      '**/settings',
      (route) =>
        route.fulfill({
          status: 409,
          contentType: 'application/json',
          body: JSON.stringify({
            code: 'STATE_CONFLICT',
            message: 'Community settings changed.',
            current: {
              communityId: settingsCommunityId,
              name: 'Gathering Place',
              description: 'Saved elsewhere',
              admissionPolicy: 'invite_only',
              hasIcon: false,
              settingsVersion: 1,
              lifecycle: 'active',
              lifecycleVersion: 1,
            },
          }),
        }),
      // Only the save conflicts; reads of the same settings URL go through.
      { filter: (route) => route.request().method() === 'PATCH' }
    );
    await ownerPage.getByRole('button', { name: 'Save presentation' }).click();
    await expect(ownerPage.getByRole('alert')).toContainText('Your edits are still here');
    await expect(ownerPage.getByLabel('Name', { exact: true })).toHaveValue('My unsaved name');
    await expect(ownerPage.getByLabel('Description')).toHaveValue('My unsaved description');
    await ownerPage.getByLabel('Name', { exact: true }).fill('Gathering Place');
    await ownerPage.getByLabel('Description').fill('Draft survives icon changes');
    await ownerPage.getByLabel('Admission policy').selectOption('closed');
    await ownerPage.getByLabel('Upload icon').setInputFiles({
      name: 'community.png',
      mimeType: 'image/png',
      buffer: Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
        'base64'
      ),
    });
    await expect(ownerPage.getByAltText('Current community icon')).toBeVisible();
    await expect(ownerPage.getByLabel('Name', { exact: true })).toHaveValue('Gathering Place');
    await expect(ownerPage.getByLabel('Description')).toHaveValue('Draft survives icon changes');
    await expect(ownerPage.getByLabel('Admission policy')).toHaveValue('closed');
    await ownerPage.getByLabel('Replace icon').setInputFiles({
      name: 'community.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('not an image'),
    });
    await expect(ownerPage.getByRole('alert')).toContainText('Use a PNG, JPEG, GIF, or WebP icon.');
    await expect(ownerPage.getByAltText('Current community icon')).toBeVisible();
    await expect(ownerPage.getByLabel('Name', { exact: true })).toHaveValue('Gathering Place');
    await ownerPage.getByRole('button', { name: 'Remove icon' }).click();
    await expect(ownerPage.getByAltText('Current community icon')).toHaveCount(0);
    await expect(ownerPage.getByLabel('Name', { exact: true })).toHaveValue('Gathering Place');
    await expect(ownerPage.getByLabel('Description')).toHaveValue('Draft survives icon changes');
    await expect(ownerPage.getByLabel('Admission policy')).toHaveValue('closed');
    const exportPanel = ownerPage.getByRole('heading', { name: 'Export' }).locator('..');
    await exportPanel.getByLabel('Password').fill('password1234');
    await exportPanel.getByRole('button', { name: 'Export this community' }).click();
    // Prepared in the background: the panel says so and shows progress, then polls until ready.
    await expect(exportPanel.getByRole('status')).toContainText("We're preparing your export.");
    await expect(exportPanel.getByLabel('Export progress')).toBeVisible();
    const settingsDownload = exportPanel.getByRole('link', { name: /^Download \(/ });
    await expect(settingsDownload).toBeVisible({ timeout: 20_000 });
    await expect(exportPanel.getByText(/^Available until /)).toBeVisible();
    for (const width of [390, 768, 1280]) {
      await ownerPage.setViewportSize({ width, height: 900 });
      await settingsDownload.scrollIntoViewIfNeeded();
      // Wholly visible: the button and its size fit the width, with no sideways scroll.
      await expect(settingsDownload).toBeInViewport({ ratio: 1 });
      expect(
        await ownerPage.evaluate(
          () => document.documentElement.scrollWidth <= document.documentElement.clientWidth
        ),
        `no sideways scroll at ${width}px`
      ).toBe(true);
    }
    const settingsExport = ownerPage.waitForEvent('download');
    await settingsDownload.click();
    expect((await settingsExport).suggestedFilename()).toBe('community-export.zip');
    // An erasure deletes ready exports; the panel checks before downloading and says why.
    await pool.query(
      "DELETE FROM export_archives WHERE scope='owner' AND state='ready' AND community_id IN (SELECT community_id FROM members)"
    );
    await settingsDownload.click();
    await expect(exportPanel.getByRole('status')).toContainText(
      'deleted because someone in this community erased their data'
    );
    await expect(exportPanel.getByRole('button', { name: 'Export this community' })).toBeVisible();
    await ownerPage.setViewportSize({ width: 390, height: 844 });
    await ownerPage.getByRole('button', { name: 'Schedule deletion' }).click();
    const deletionDialog = ownerPage.getByRole('dialog', {
      name: 'Permanently delete Gathering Place?',
    });
    await expect(deletionDialog).toBeVisible();
    await expect(deletionDialog.getByLabel('Type Gathering Place')).toBeFocused();
    await deletionDialog.getByRole('button', { name: 'Cancel' }).focus();
    await ownerPage.keyboard.press('Tab');
    await expect(deletionDialog.getByLabel('Type Gathering Place')).toBeFocused();
    await ownerPage.keyboard.press('Escape');
    await expect(deletionDialog).toBeHidden();
    await ownerPage.getByRole('button', { name: 'Archive community' }).click();
    const archiveDialog = ownerPage.getByRole('dialog', { name: 'Archive Gathering Place?' });
    await expect(archiveDialog.getByText('History stays available.')).toBeVisible();
    await archiveDialog.getByRole('button', { name: 'Cancel' }).click();
    await ownerPage.getByRole('button', { name: 'Open people' }).click();
    await expect(ownerPage.getByRole('heading', { name: 'Community members' })).toBeVisible();
    await ownerPage.setViewportSize({ width: 1440, height: 900 });
    const closeSettings = ownerPage.getByRole('button', { name: 'Close' });
    await closeSettings.focus();
    await expect(closeSettings).toBeFocused();
    await ownerPage.keyboard.press('Enter');
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
    const file = ownerPage.getByRole('button', { name: 'notes.txt', exact: true });
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
    await observerPage.getByRole('button', { name: 'Open community' }).click();
    await expect(observerPage.getByRole('button', { name: 'Join channel' })).toBeVisible();
    // Closing admission replaces the invite controls with the reason, at every width.
    const sections = ownerPage.getByRole('navigation', { name: 'Settings sections' });
    const viewport = ownerPage.viewportSize();
    await sections.getByRole('button', { name: 'Settings', exact: true }).click();
    await ownerPage.getByLabel('Admission policy').selectOption('closed');
    await ownerPage.getByRole('button', { name: 'Save access' }).click();
    await expect(ownerPage.getByText('Access saved.')).toBeVisible();
    await sections.getByRole('button', { name: 'Community' }).click();
    await expect(ownerPage.getByText('This community is closed to new members.')).toBeVisible();
    await expect(ownerPage.getByRole('button', { name: 'Create invite' })).toHaveCount(0);
    // The link created before closing was revoked with it, so it is no longer offered.
    await expect(ownerPage.getByLabel('One-time invite link')).toHaveCount(0);
    await ownerPage.setViewportSize({ width: 1440, height: 900 });
    await ownerPage.screenshot({ path: '/tmp/community-closed-desktop.png', fullPage: true });
    await ownerPage.setViewportSize({ width: 390, height: 844 });
    const channelsNav = ownerPage.getByRole('complementary', { name: 'Community channels' });
    if (await channelsNav.evaluate((node) => node.classList.contains('open')))
      await ownerPage.mouse.click(380, 420);
    await expect(channelsNav).not.toHaveClass(/open/);
    // Wait for the navigation to finish sliding away before the screenshot.
    await expect
      .poll(async () => {
        const box = await channelsNav.boundingBox();
        return box ? box.x + box.width : 0;
      })
      .toBeLessThanOrEqual(0);
    await expect(ownerPage.getByText('This community is closed to new members.')).toBeVisible();
    await ownerPage.screenshot({ path: '/tmp/community-closed-mobile.png', fullPage: true });
    if (viewport) await ownerPage.setViewportSize(viewport);
    await sections.getByRole('button', { name: 'Settings', exact: true }).click();
    await ownerPage.getByLabel('Admission policy').selectOption('invite_only');
    await ownerPage.getByRole('button', { name: 'Save access' }).click();
    await expect(ownerPage.getByText('Access saved.')).toBeVisible();
    await sections.getByRole('button', { name: 'Community' }).click();
    await expect(ownerPage.getByRole('button', { name: 'Create invite' })).toBeVisible();
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
    await observerPage.addInitScript(() => {
      type Listener = (event: MessageEvent) => void;
      class ControlledEventSource {
        onerror: ((event: Event) => void) | null = null;
        private listeners = new Map<string, Listener[]>();
        constructor() {
          window.__communityStream = this;
        }
        addEventListener(type: string, listener: Listener) {
          this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
        }
        close() {}
        fail() {
          this.onerror?.(new Event('error'));
        }
        emit(type: string, value: unknown) {
          for (const listener of this.listeners.get(type) ?? [])
            listener(new MessageEvent(type, { data: JSON.stringify(value) }));
        }
      }
      window.EventSource = ControlledEventSource as unknown as typeof EventSource;
    });
    await observerPage.reload();
    await expect
      .poll(() => observerPage.evaluate(() => Boolean(window.__communityStream)))
      .toBe(true);
    await observerPage.evaluate(() => window.__communityStream?.fail());
    await expect(observerPage.getByRole('alert')).toContainText(
      'Live updates paused. Reconnecting…'
    );
    await observerPage.evaluate(() =>
      window.__communityStream?.emit('snapshot', { type: 'snapshot', entries: [], cursor: '0' })
    );
    await expect(observerPage.getByRole('alert')).toHaveCount(0);
    const closeOwnerSettings = ownerPage.getByRole('button', { name: 'Close' });
    await closeOwnerSettings.focus();
    await expect(closeOwnerSettings).toBeFocused();
    await ownerPage.keyboard.press('Enter');

    const secondaryName = await ownerPage.evaluate(async () => {
      const channel = await (
        await fetch('/api/v1/channels', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name: 'updates', description: '', visibility: 'public' }),
        })
      ).json();
      await fetch(`/api/v1/channels/${channel.channel.id}/entries`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'Entry in updates', idempotencyKey: crypto.randomUUID() }),
      });
      return channel.channel.name as string;
    });
    const generalChannelId = await ownerPage.evaluate(async () => {
      const channels = await (await fetch('/api/v1/channels')).json();
      return channels.channels.find((channel: { name: string }) => channel.name === 'general')
        .id as string;
    });
    let releaseGeneralHistory: (() => void) | undefined;
    let generalHistoryRequest!: () => void;
    const generalHistorySeen = new Promise<void>((resolve) => {
      generalHistoryRequest = resolve;
    });
    const generalHistoryGate = new Promise<void>((resolve) => {
      releaseGeneralHistory = resolve;
    });
    let generalHistoryFulfilled!: () => void;
    const generalHistoryReleased = new Promise<void>((resolve) => {
      generalHistoryFulfilled = resolve;
    });
    const isGeneralHistory = (url: URL) =>
      new RegExp(`^/api/v1/communities/[0-9a-f-]+/channels/${generalChannelId}/entries$`, 'u').test(
        url.pathname
      ) && url.search === '?limit=50';
    const holdGeneralHistory = async (route: Route) => {
      const response = await route.fetch();
      generalHistoryRequest();
      await generalHistoryGate;
      await route.fulfill({ response });
      generalHistoryFulfilled();
    };
    await ownerPage.route(isGeneralHistory, holdGeneralHistory);
    await ownerPage.reload();
    await generalHistorySeen;
    await ownerPage.getByRole('button', { name: secondaryName }).click();
    await expect(ownerPage.getByText('Entry in updates', { exact: true })).toBeVisible();
    releaseGeneralHistory?.();
    await generalHistoryReleased;
    await ownerPage.unroute(isGeneralHistory, holdGeneralHistory);
    await expect(ownerPage.getByText('Entry in updates', { exact: true })).toHaveCount(1);
    await expect(ownerPage.getByText('Hello from Maya', { exact: true })).toHaveCount(0);
    await ownerPage.getByRole('button', { name: 'general' }).click();
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

    // A slow page of history must merge with an entry delivered while it was
    // still in flight. Reloading makes the history request fresh while the SSE
    // connection is a second, independent source of the newer entry.
    await ownerPage.addInitScript(() => {
      (window as Window & { __communityLiveEntry?: boolean }).__communityLiveEntry = false;
      const NativeEventSource = window.EventSource;
      class ObservedEventSource extends NativeEventSource {
        constructor(url: string | URL, configuration?: EventSourceInit) {
          super(url, configuration);
          this.addEventListener('entry', () => {
            (window as Window & { __communityLiveEntry?: boolean }).__communityLiveEntry = true;
          });
        }
      }
      window.EventSource = ObservedEventSource;
    });
    let releaseHistory: (() => void) | undefined;
    let historyRequest!: () => void;
    const historySeen = new Promise<void>((resolve) => {
      historyRequest = resolve;
    });
    const historyGate = new Promise<void>((resolve) => {
      releaseHistory = resolve;
    });
    let historyFulfilled!: () => void;
    const historyReleased = new Promise<void>((resolve) => {
      historyFulfilled = resolve;
    });
    const isInitialHistory = (url: URL) =>
      /^\/api\/v1\/communities\/[0-9a-f-]+\/channels\/[^/]+\/entries$/u.test(url.pathname) &&
      url.search === '?limit=50';
    const holdHistory = async (route: Route) => {
      const response = await route.fetch();
      historyRequest();
      await historyGate;
      await route.fulfill({ response });
      historyFulfilled();
    };
    await ownerPage.route((url) => isInitialHistory(url), holdHistory);
    await ownerPage.reload();
    await historySeen;
    await expect
      .poll(() =>
        ownerPage.evaluate(
          () =>
            (window as Window & { __communityLiveEntry?: boolean }).__communityLiveEntry === false
        )
      )
      .toBe(true);
    await memberPage.getByLabel('Message #general').fill('SSE survives delayed history');
    await memberPage.getByRole('button', { name: 'Send' }).click();
    await expect
      .poll(() =>
        ownerPage.evaluate(
          () => (window as Window & { __communityLiveEntry?: boolean }).__communityLiveEntry
        )
      )
      .toBe(true);
    releaseHistory?.();
    await historyReleased;
    await ownerPage.unroute(isInitialHistory, holdHistory);
    await expect(ownerPage.getByText('Hello from Maya', { exact: true })).toHaveCount(1);
    await expect(ownerPage.getByText('SSE survives delayed history', { exact: true })).toHaveCount(
      1
    );

    const ids = await ownerPage.evaluate(async () => {
      const [community, me, channels] = await Promise.all([
        fetch('/api/v1/community').then((response) => response.json()),
        fetch('/api/v1/me').then((response) => response.json()),
        fetch('/api/v1/channels').then((response) => response.json()),
      ]);
      return {
        communityId: community.id as string,
        ownerMemberId: me.member.memberId as string,
        channelId: channels.channels.find((channel: { name: string }) => channel.name === 'general')
          .id as string,
      };
    });
    const seededAgent = await pool.query<{ id: string }>(
      `INSERT INTO agents(community_id,owner_member_id,display_name,handle)
       VALUES($1,$2,'Browser helper','browser-helper') RETURNING id`,
      [ids.communityId, ids.ownerMemberId]
    );
    await pool.query(
      'INSERT INTO community_handles(community_id,handle,agent_id) VALUES($1,$2,$3)',
      [ids.communityId, 'browser-helper', seededAgent.rows[0].id]
    );
    await pool.query(
      'INSERT INTO agent_channel_members(community_id,channel_id,agent_id) VALUES($1,$2,$3)',
      [ids.communityId, ids.channelId, seededAgent.rows[0].id]
    );
    // The DorkOS app's "Leave community" opens this exact path: settings, at
    // the Account section, on the Community's own site.
    await memberPage.goto(`${baseUrl}${communitySettingsPath(ids.communityId, 'account')}`);
    await expect(
      memberPage
        .getByRole('navigation', { name: 'Settings sections' })
        .getByRole('button', { name: 'Account' })
    ).toHaveClass(/primary/);
    await memberPage.getByRole('button', { name: 'Download my data' }).click();
    const personalDownload = memberPage.getByRole('link', { name: /^Download \(/ });
    await expect(personalDownload).toBeVisible({ timeout: 20_000 });
    const exportDownload = memberPage.waitForEvent('download');
    await personalDownload.click();
    expect((await exportDownload).suggestedFilename()).toBe('my-community-data.zip');
    await memberPage.getByLabel('Enter Gathering Place').fill('Gathering Place');
    await memberPage.getByLabel('Confirm password').fill('password1234');
    memberPage.once('dialog', (dialog) => void dialog.accept());
    await memberPage.getByRole('button', { name: 'Leave community' }).click();
    await expect(memberPage.getByRole('heading', { name: 'Choose a community' })).toBeVisible();
    await expect(
      memberPage.getByText('This account does not have a community membership yet.')
    ).toBeVisible();
    await ownerPage.getByRole('button', { name: 'Manage' }).click();
    await ownerPage.getByRole('button', { name: 'Members' }).click();
    const agentRow = ownerPage
      .locator('.row.justify-between.border-b')
      .filter({ hasText: 'Browser helper' });
    await expect(agentRow).toBeVisible();
    await agentRow.getByRole('button', { name: 'Remove' }).click();
    await expect(agentRow).toHaveCount(0);
    await ownerPage.getByRole('button', { name: 'Account' }).click();
    await ownerPage.locator('#successor').selectOption(nikoId);
    await ownerPage.getByLabel('Confirm password').fill('password1234');
    await ownerPage.getByRole('button', { name: 'Transfer ownership' }).click();
    await expect(ownerPage.getByRole('button', { name: 'Leave community' })).toBeVisible();
    await expect(ownerPage.getByText('Community export')).toHaveCount(0);
    await expect(
      ownerPage
        .getByRole('navigation', { name: 'Settings sections' })
        .getByRole('button', { name: 'Settings', exact: true })
    ).toHaveCount(0);
    await pool.query("UPDATE members SET role='admin' WHERE id=$1", [ids.ownerMemberId]);
    await ownerPage.reload();
    await ownerPage.getByRole('button', { name: 'Manage' }).click();
    await ownerPage
      .getByRole('navigation', { name: 'Settings sections' })
      .getByRole('button', { name: 'Settings', exact: true })
      .click();
    await expect(ownerPage.getByRole('heading', { name: 'Presentation' })).toBeVisible();
    await expect(ownerPage.getByLabel('Description')).toBeVisible();
    await expect(ownerPage.getByLabel('Name', { exact: true })).toHaveCount(0);
    await expect(ownerPage.getByRole('heading', { name: 'Access' })).toHaveCount(0);
    await expect(ownerPage.getByRole('heading', { name: 'Export' })).toHaveCount(0);
    await expect(ownerPage.getByRole('heading', { name: 'Danger zone' })).toHaveCount(0);
    await ownerPage.getByRole('button', { name: 'Account' }).click();
    await ownerPage.getByLabel('Enter Gathering Place').fill('Gathering Place');
    await ownerPage.getByLabel('Confirm password').fill('password1234');
    ownerPage.once('dialog', (dialog) => void dialog.accept());
    await ownerPage.getByRole('button', { name: 'Leave community' }).click();
    await expect(ownerPage.getByRole('heading', { name: 'Choose a community' })).toBeVisible();
    await expect(
      ownerPage.getByText('This account does not have a community membership yet.')
    ).toBeVisible();

    await observerPage.goto(`${baseUrl}/c/${ids.communityId}`);
    await expect(observerPage.getByText('Gathering Place')).toBeVisible();
    const nikoAccount = await pool.query<{ user_id: string }>(
      'SELECT user_id FROM members WHERE id=$1',
      [nikoId]
    );
    const secondCommunity = await pool.connect();
    let secondCommunityId = '';
    try {
      await secondCommunity.query('BEGIN');
      const created = await secondCommunity.query<{ id: string }>(
        "INSERT INTO communities(name,lifecycle) VALUES('Second Place','pending_owner') RETURNING id"
      );
      secondCommunityId = created.rows[0].id;
      const secondMember = await secondCommunity.query<{ id: string }>(
        `INSERT INTO members(community_id,user_id,display_name,handle,role)
         VALUES($1,$2,'Niko','niko','owner') RETURNING id`,
        [secondCommunityId, nikoAccount.rows[0].user_id]
      );
      await secondCommunity.query(
        'INSERT INTO community_handles(community_id,handle,member_id) VALUES($1,$2,$3)',
        [secondCommunityId, 'niko', secondMember.rows[0].id]
      );
      await secondCommunity.query("UPDATE communities SET lifecycle='active' WHERE id=$1", [
        secondCommunityId,
      ]);
      await secondCommunity.query('COMMIT');
    } finally {
      await secondCommunity.query('ROLLBACK');
      secondCommunity.release();
    }
    // A signed-out visitor can authenticate without choosing or enumerating a tenant.
    const signedOut = await browser.newContext();
    try {
      const login = await signedOut.newPage();
      await login.goto(baseUrl);
      await expect(login.getByLabel('Email')).toBeVisible();
      await expect(login.getByLabel('Community name')).toHaveCount(0);
      await login.getByLabel('Email').fill('niko@ui.test');
      await login.getByLabel('Password').fill('password1234');
      await login.getByRole('button', { name: 'Sign in', exact: true }).last().click();
      await expect(login.getByRole('heading', { name: 'Choose a community' })).toBeVisible();
      await expect(login.getByRole('button', { name: /Second Place/ })).toBeVisible();
    } finally {
      await signedOut.close();
    }
    // A removed membership reload returns to the host's own-membership chooser.
    await memberPage.goto(`${baseUrl}/c/${ids.communityId}`);
    await expect(memberPage).toHaveURL(baseUrl + '/');
    await expect(
      memberPage.getByText('This account does not have a community membership yet.')
    ).toBeVisible();

    // An OAuth handoff uses the tenant-bound pending admission, never the raw invite.
    const oauthInvite = await observerPage.evaluate(async (communityId) => {
      const response = await fetch(`/api/v1/communities/${communityId}/invites`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
      if (!response.ok) throw new Error(`invite creation: ${response.status}`);
      return response.json() as Promise<{ token: string }>;
    }, ids.communityId);
    const oauth = await browser.newContext();
    try {
      const oauthPage = await oauth.newPage();
      await oauthPage.route('**/auth-options', (route) =>
        route.fulfill({ json: { google: true, github: false, oidc: null } })
      );
      let callbackUrl = '';
      await oauthPage.route('**/api/auth/sign-in/social', async (route) => {
        const payload = JSON.parse(route.request().postData() ?? '{}') as { callbackURL?: string };
        callbackUrl = payload.callbackURL ?? '';
        await route.fulfill({ status: 400, json: { message: 'Test-owned OAuth boundary' } });
      });
      await oauthPage.goto(
        `${baseUrl}/c/${ids.communityId}/join#invite=${encodeURIComponent(oauthInvite.token)}`
      );
      await oauthPage.getByRole('button', { name: 'Continue', exact: true }).click();
      await expect(oauthPage.getByRole('button', { name: 'Continue with Google' })).toBeVisible();
      await expect.poll(() => oauthPage.evaluate(() => location.hash)).toBe('');
      await expect
        .poll(() => oauthPage.evaluate(() => Object.keys(sessionStorage)))
        .not.toContain('communityPendingInvite');
      await oauthPage.getByRole('button', { name: 'Continue with Google' }).click();
      await expect.poll(() => callbackUrl).toBe(`${baseUrl}/c/${ids.communityId}/join`);
    } finally {
      await oauth.close();
    }

    await observerPage.getByRole('button', { name: 'Switch community' }).click();
    await expect(observerPage.getByRole('heading', { name: 'Choose a community' })).toBeVisible();
    await expect(observerPage.getByRole('button', { name: /Gathering Place/ })).toBeVisible();
    await observerPage.getByRole('button', { name: /Second Place/ }).click();
    await expect(observerPage).toHaveURL(`${baseUrl}/c/${secondCommunityId}`);
    await expect(observerPage.getByText('Second Place')).toBeVisible();
    const selectedRequests: string[] = [];
    observerPage.on('request', (request) => {
      const path = new URL(request.url()).pathname;
      if (path.startsWith('/api/v1/communities/')) selectedRequests.push(path);
    });
    await observerPage.reload();
    await expect(observerPage.getByText('Second Place')).toBeVisible();
    expect(selectedRequests.length).toBeGreaterThan(0);
    expect(
      selectedRequests.every((path) => path.startsWith(`/api/v1/communities/${secondCommunityId}/`))
    ).toBe(true);
    await pool.query(
      "UPDATE communities SET lifecycle='suspended',suspended_from_state='active',suspended_at=now() WHERE id=$1",
      [secondCommunityId]
    );
    await observerPage.reload();
    await expect(observerPage).toHaveURL(baseUrl + '/');
    const suspendedChoice = observerPage.getByRole('button', { name: /Second Place/ });
    await expect(suspendedChoice).toBeDisabled();
    await expect(suspendedChoice).toContainText('Suspended');

    await observerPage.getByRole('button', { name: /Gathering Place/ }).click();
    await observerPage.getByRole('button', { name: 'Manage' }).click();
    await observerPage
      .getByRole('navigation', { name: 'Settings sections' })
      .getByRole('button', { name: 'Settings', exact: true })
      .click();
    await observerPage.getByRole('button', { name: 'Archive community' }).click();
    const finalArchive = observerPage.getByRole('dialog', { name: 'Archive Gathering Place?' });
    await finalArchive.getByLabel('Type Gathering Place').fill('Gathering Place');
    await finalArchive.getByLabel('Password').fill('password1234');
    await pool.query('UPDATE communities SET lifecycle_version=lifecycle_version+1 WHERE id=$1', [
      ids.communityId,
    ]);
    await interceptNext(observerPage, '**/owner/lifecycle', (route) =>
      route.fulfill({
        status: 409,
        contentType: 'application/json',
        body: JSON.stringify({
          code: 'STATE_CONFLICT',
          message: 'Review the latest state and try again.',
        }),
      })
    );
    await finalArchive.getByRole('button', { name: 'Archive community' }).click();
    await expect(finalArchive.getByRole('alert')).toContainText(
      'Review the latest state and try again.'
    );
    await expect(finalArchive.getByLabel('Password')).toHaveValue('password1234');
    await finalArchive.getByRole('button', { name: 'Archive community' }).click();
    await expect(
      observerPage.getByRole('heading', { name: 'Archived', exact: true })
    ).toBeVisible();
    await expect(observerPage.getByText('Fresh read-only connections are available')).toBeVisible();
    await observerPage.getByRole('button', { name: 'Switch community' }).click();
    await expect(observerPage.getByRole('heading', { name: 'Choose a community' })).toBeVisible();
    const archivedChoice = observerPage.getByRole('button', { name: /Gathering Place/ });
    await expect(archivedChoice).toContainText('Read history');
    const archivedStreamRequests: string[] = [];
    observerPage.on('request', (request) => {
      const path = new URL(request.url()).pathname;
      if (path.endsWith('/events')) archivedStreamRequests.push(path);
    });
    await archivedChoice.click();
    await expect(observerPage).toHaveURL(`${baseUrl}/c/${ids.communityId}`);
    await expect(observerPage.getByText('Archived history is read-only.')).toBeVisible();
    await expect(observerPage.getByRole('textbox', { name: /Message/ })).toHaveCount(0);
    await expect(observerPage.getByLabel('Add files')).toHaveCount(0);
    expect(archivedStreamRequests).toEqual([]);
    await observerPage.getByRole('button', { name: 'Manage' }).click();
    await observerPage
      .getByRole('navigation', { name: 'Settings sections' })
      .getByRole('button', { name: 'Settings', exact: true })
      .click();
    await observerPage.getByRole('button', { name: 'Schedule deletion' }).click();
    const finalDeletion = observerPage.getByRole('dialog', {
      name: 'Permanently delete Gathering Place?',
    });
    await finalDeletion.getByLabel('Type Gathering Place').fill('Gathering Place');
    await finalDeletion
      .getByLabel(`Type the final eight characters: ${ids.communityId.slice(-8)}`)
      .fill(ids.communityId.slice(-8));
    await finalDeletion.getByLabel('Password').fill('password1234');
    await pool.query('UPDATE communities SET lifecycle_version=lifecycle_version+1 WHERE id=$1', [
      ids.communityId,
    ]);
    await interceptNext(observerPage, '**/owner/deletion', (route) =>
      route.fulfill({
        status: 409,
        contentType: 'application/json',
        body: JSON.stringify({
          code: 'STATE_CONFLICT',
          message: 'Review the latest state and try again.',
        }),
      })
    );
    await finalDeletion.getByRole('button', { name: 'Schedule permanent deletion' }).click();
    await expect(finalDeletion.getByRole('alert')).toContainText(
      'Review the latest state and try again.'
    );
    await expect(finalDeletion.getByLabel('Password')).toHaveValue('password1234');
    await finalDeletion.getByRole('button', { name: 'Schedule permanent deletion' }).click();
    await expect(observerPage.getByRole('heading', { name: 'Deletion scheduled' })).toBeVisible();
    await expect(observerPage.getByRole('timer')).toContainText('remaining');
    await observerPage.reload();
    await expect(observerPage).toHaveURL(`${baseUrl}/c/${ids.communityId}/deletion`);
    await expect(observerPage.getByRole('heading', { name: 'Deletion scheduled' })).toBeVisible();
    await observerPage.getByRole('button', { name: 'Cancel deletion' }).click();
    const cancelDeletion = observerPage.getByRole('dialog', {
      name: 'Cancel community deletion?',
    });
    await cancelDeletion.getByLabel('Password').fill('password1234');
    await pool.query('UPDATE communities SET lifecycle_version=lifecycle_version+1 WHERE id=$1', [
      ids.communityId,
    ]);
    await interceptNext(observerPage, '**/owner/deletion/cancel', (route) =>
      route.fulfill({
        status: 409,
        contentType: 'application/json',
        body: JSON.stringify({
          code: 'STATE_CONFLICT',
          message: 'Review the latest state and try again.',
        }),
      })
    );
    await cancelDeletion.getByRole('button', { name: 'Cancel deletion' }).click();
    await expect(cancelDeletion.getByRole('alert')).toContainText(
      'Review the latest state and try again.'
    );
    await expect(cancelDeletion.getByLabel('Password')).toHaveValue('password1234');
    await cancelDeletion.getByRole('button', { name: 'Cancel deletion' }).click();
    await expect(
      observerPage.getByRole('heading', { name: 'Archived', exact: true })
    ).toBeVisible();

    await memberPage.goto(`${baseUrl}/c/${ids.communityId}/deletion`);
    await expect(memberPage.getByRole('alert')).toContainText(
      'only available to this community’s owner'
    );
    await expect(memberPage.getByRole('button', { name: 'Schedule deletion' })).toHaveCount(0);
    await expect(memberPage.getByRole('button', { name: 'Cancel deletion' })).toHaveCount(0);

    await pool.query(
      "INSERT INTO communities(name,lifecycle) VALUES('Unclaimed Place','pending_owner')"
    );
    await ownerPage.goto(`${baseUrl}/host`);
    const unclaimed = ownerPage.getByLabel('Unclaimed Place community');
    await unclaimed.getByRole('button', { name: 'Abandon unclaimed community' }).click();
    const abandonDialog = ownerPage.getByRole('dialog', { name: 'Abandon Unclaimed Place?' });
    await expect(abandonDialog.getByRole('button', { name: 'Cancel' })).toBeFocused();
    await expect(abandonDialog).toContainText('permanently removes the empty community');
    await abandonDialog.getByRole('button', { name: 'Cancel' }).click();

    let committedCreateWasDropped = false;
    await ownerPage.route('**/api/v1/host/communities', async (route) => {
      if (route.request().method() !== 'POST' || committedCreateWasDropped) {
        await route.continue();
        return;
      }
      committedCreateWasDropped = true;
      await route.fetch();
      await route.abort('connectionfailed');
    });
    await ownerPage.getByLabel('Name', { exact: true }).fill('Retry Community');
    await ownerPage.getByLabel('Description').fill('Created once after a lost response');
    await ownerPage.getByRole('button', { name: 'Create community' }).click();
    await expect(ownerPage.getByRole('alert')).toBeVisible();
    await ownerPage.getByRole('button', { name: 'Create community' }).click();
    await expect(ownerPage.getByLabel('Retry Community community')).toHaveCount(1);
    await expect(ownerPage.getByRole('status')).toContainText('Use Reissue owner claim');
    await expect(ownerPage.getByLabel('Owner claim link')).toHaveCount(0);
    await ownerPage.unroute('**/api/v1/host/communities');
  } finally {
    await owner.close();
    await member.close();
    await observer.close();
  }
});
