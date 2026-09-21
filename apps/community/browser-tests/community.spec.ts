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
import { createCommunityApp } from '../src/app.js';
import { parseConfig } from '../src/config.js';
import { migrate } from '../src/migrate.js';

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
  for (const path of ['/', '/join', '/pairing', '/c/:communityId', '/c/:communityId/*'])
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
    expect(inviteLink).toMatch(/\/c\/[0-9a-f-]+\/join#invite=/u);
    await memberPage.goto(inviteLink.replace('#invite=', '#token='));
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
    // The scrim deliberately sits below the open sidebar. Click its exposed
    // right gutter, as a person dismissing the mobile navigation would.
    await memberPage.mouse.click(380, 420);
    await expect(
      memberPage.getByRole('complementary', { name: 'Community channels' })
    ).not.toHaveClass(/open/);
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
    await memberPage.getByRole('button', { name: 'Manage' }).click();
    await memberPage.getByRole('button', { name: 'Account' }).click();
    const exportDownload = memberPage.waitForEvent('download');
    await memberPage.getByRole('button', { name: 'Export my data' }).click();
    expect((await exportDownload).suggestedFilename()).toBe('my-community-data.zip');
    await memberPage.getByLabel('Enter Gathering Place').fill('Gathering Place');
    await memberPage.locator('#leave-password').fill('password1234');
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
    await ownerPage.getByLabel('Enter Gathering Place').fill('Gathering Place');
    await ownerPage.locator('#leave-password').fill('password1234');
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

    // Preflight keeps the raw invitation out of browser storage and OAuth callback state.
    const createdInvite = await observerPage.evaluate(async (communityId) => {
      const response = await fetch(`/api/v1/communities/${communityId}/invites`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
      if (!response.ok) throw new Error(`invite creation: ${response.status}`);
      return response.json() as Promise<{ token: string }>;
    }, ids.communityId);
    const oauth = await browser.newContext();
    let releasePreflight = () => {};
    try {
      const oauthPage = await oauth.newPage();
      await oauthPage.route('**/auth-options', (route) =>
        route.fulfill({ json: { google: true, github: false } })
      );
      let callbackUrl = '';
      await oauthPage.route('**/api/auth/sign-in/social', async (route) => {
        callbackUrl = (route.request().postDataJSON() as { callbackURL: string }).callbackURL;
        await route.fulfill({ status: 400, json: { message: 'Test-owned OAuth boundary' } });
      });
      let urlAtPreflight = '';
      const preflightBarrier = new Promise<void>((resolve) => {
        releasePreflight = resolve;
      });
      await oauthPage.route('**/invites/preflight', async (route) => {
        urlAtPreflight = oauthPage.url();
        await preflightBarrier;
        await route.continue();
      });
      const rawToken = createdInvite.token;
      await oauthPage.goto(
        `${baseUrl}/c/${ids.communityId}/join#invite=${encodeURIComponent(rawToken)}`
      );
      await expect(oauthPage).toHaveURL(`${baseUrl}/c/${ids.communityId}/join`);
      expect(
        await oauthPage.evaluate((token) => {
          const values = Object.values(sessionStorage);
          return values.some((value) => value.includes(token));
        }, rawToken)
      ).toBe(false);
      const continueAdmission = oauthPage.getByRole('button', { name: 'Continue', exact: true });
      const continueAdmissionRequest = continueAdmission.click();
      await expect.poll(() => urlAtPreflight).toBe(`${baseUrl}/c/${ids.communityId}/join`);
      releasePreflight();
      await continueAdmissionRequest;
      await expect
        .poll(() =>
          oauthPage.evaluate(
            (token) => ({
              readHook: '__readDorkosInviteFragment' in window,
              clearHook: '__clearDorkosInviteFragment' in window,
              storage: [...Object.values(sessionStorage), ...Object.values(localStorage)].some(
                (value) => value.includes(token)
              ),
              document: document.documentElement.textContent?.includes(token) ?? false,
            }),
            rawToken
          )
        )
        .toEqual({ readHook: false, clearHook: false, storage: false, document: false });
      await oauthPage.getByRole('button', { name: 'Continue with Google' }).click();
      await expect.poll(() => callbackUrl).toBe(`${baseUrl}/c/${ids.communityId}/join`);
      expect(callbackUrl).not.toContain(rawToken);
      expect(await oauthPage.evaluate(() => location.hash)).toBe('');
      expect(
        await oauthPage.evaluate((token) => {
          document.querySelector('#root')?.remove();
          return {
            readHook: '__readDorkosInviteFragment' in window,
            clearHook: '__clearDorkosInviteFragment' in window,
            storage: [...Object.values(sessionStorage), ...Object.values(localStorage)].some(
              (value) => value.includes(token)
            ),
            document: document.documentElement.textContent?.includes(token) ?? false,
          };
        }, rawToken)
      ).toEqual({ readHook: false, clearHook: false, storage: false, document: false });
    } finally {
      releasePreflight();
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
      `UPDATE communities SET lifecycle='suspended',suspended_from_state='active',
         suspended_at=now(),lifecycle_version=lifecycle_version+1 WHERE id=$1`,
      [secondCommunityId]
    );
    await observerPage.reload();
    await expect(observerPage).toHaveURL(baseUrl + '/');
    const suspendedChoice = observerPage.getByRole('button', { name: /Second Place/ });
    await expect(suspendedChoice).toBeDisabled();
    await expect(suspendedChoice).toContainText('Suspended');
  } finally {
    await owner.close();
    await member.close();
    await observer.close();
  }
});
