import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import {
  test,
  expect,
  request as playwrightRequest,
  type BrowserContext,
  type Page,
} from '@playwright/test';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Pool } from 'pg';
import { interceptNext } from '@dorkos/test-utils/playwright-routes';
import { createCommunityApp } from '../src/app.js';
import { parseConfig } from '../src/config.js';
import { migrate } from '../src/migrate.js';
import { bootstrapFirstHost } from '../src/__tests__/bootstrap-test-helper.js';

// Membership entry (task 2.1) and invitation continuation (task 2.2) of
// specs/community-membership-journeys. COMMUNITY_MEMBERSHIP_SCREENSHOTS optionally names a
// directory for reviewable desktop and phone screenshots of every state.
const { COMMUNITY_TEST_DATABASE_URL: adminUrl, COMMUNITY_MEMBERSHIP_SCREENSHOTS: shots } =
  process.env;
if (!adminUrl)
  throw new Error('COMMUNITY_TEST_DATABASE_URL is required for community browser tests');
const dbName = `community_browser_membership_${randomUUID().replaceAll('-', '')}`;
const dbUrl = new URL(adminUrl);
dbUrl.pathname = `/${dbName}`;
const admin = new Pool({ connectionString: adminUrl });
const password = 'password1234';
const operatorEmail = 'operator@membership.test';
let pool: Pool;
let server: ReturnType<typeof serve>;
let baseUrl: string;
let blobDir: string;
let firstId: string;
let generalId: string;
let secondId: string;
let operatorCookie: string;

async function freePort() {
  const socket = createServer();
  await new Promise<void>((resolve) => socket.listen(0, '127.0.0.1', resolve));
  const address = socket.address();
  if (!address || typeof address === 'string') throw new Error('No browser test port');
  await new Promise<void>((resolve) => socket.close(() => resolve()));
  return address.port;
}

/** Capture one state at desktop and phone width, then restore the page's own viewport. */
async function shot(page: Page, name: string) {
  if (!shots) return;
  const original = page.viewportSize();
  for (const [label, size] of [
    ['desktop', { width: 1440, height: 900 }],
    ['mobile', { width: 390, height: 844 }],
  ] as const) {
    await page.setViewportSize(size);
    await page.screenshot({ path: join(shots, `${name}-${label}.png`), fullPage: true });
  }
  if (original) await page.setViewportSize(original);
}

function post(path: string, body: unknown, cookie = '') {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { origin: baseUrl, 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  });
}

/** Issue an invitation as the operator, who owns both communities. */
async function invite(communityId: string, channelId?: string) {
  const response = await post(
    `/api/v1/communities/${communityId}/invites`,
    { seats: 1, ...(channelId ? { channelId } : {}) },
    operatorCookie
  );
  expect(response.status).toBe(201);
  const { token } = (await response.json()) as { token: string };
  return {
    token,
    link: `${baseUrl}/c/${communityId}/join#invite=${encodeURIComponent(token)}`,
  };
}

/** Admit a brand-new account through the production invitation protocol, off-screen. */
async function admitNewAccount(communityId: string, name: string, email: string) {
  const { token } = await invite(communityId);
  const api = await playwrightRequest.newContext({
    baseURL: baseUrl,
    extraHTTPHeaders: { origin: baseUrl },
  });
  try {
    const tenant = `/api/v1/communities/${communityId}`;
    expect((await api.post(`${tenant}/invites/preflight`, { data: { token } })).ok()).toBe(true);
    expect(
      (await api.post('/api/auth/sign-up/email', { data: { name, email, password } })).ok()
    ).toBe(true);
    expect((await api.post(`${tenant}/invites/bind`, { data: {} })).ok()).toBe(true);
    const redeemed = await api.post(`${tenant}/invites/redeem`, { data: {} });
    expect(redeemed.ok()).toBe(true);
    return ((await redeemed.json()) as { memberId: string }).memberId;
  } finally {
    await api.dispose();
  }
}

/** Admit an existing account into another community through the same protocol. */
async function admitExistingAccount(communityId: string, email: string) {
  const { token } = await invite(communityId);
  const api = await playwrightRequest.newContext({
    baseURL: baseUrl,
    extraHTTPHeaders: { origin: baseUrl },
  });
  try {
    const tenant = `/api/v1/communities/${communityId}`;
    expect((await api.post('/api/auth/sign-in/email', { data: { email, password } })).ok()).toBe(
      true
    );
    expect((await api.post(`${tenant}/invites/preflight`, { data: { token } })).ok()).toBe(true);
    expect((await api.post(`${tenant}/invites/bind`, { data: {} })).ok()).toBe(true);
    expect((await api.post(`${tenant}/invites/redeem`, { data: {} })).ok()).toBe(true);
  } finally {
    await api.dispose();
  }
}

async function removeMember(communityId: string, memberId: string) {
  const response = await fetch(`${baseUrl}/api/v1/communities/${communityId}/members/${memberId}`, {
    method: 'DELETE',
    headers: { origin: baseUrl, cookie: operatorCookie },
  });
  expect(response.status).toBe(204);
}

async function signIn(context: BrowserContext, email: string) {
  const response = await context.request.post(`${baseUrl}/api/auth/sign-in/email`, {
    headers: { origin: baseUrl },
    data: { email, password },
  });
  expect(response.ok()).toBe(true);
}

/** Answer the next matching request once with a failure, then let later ones through. */
function failNext(page: Page, pattern: string, status: number) {
  return interceptNext(page, pattern, (route) =>
    route.fulfill({
      status,
      contentType: 'application/json',
      body: JSON.stringify({ code: 'UNAVAILABLE', message: 'The community is unavailable.' }),
    })
  );
}

/** Everything the page could have persisted, so a test can prove the invitation never was. */
async function persistedState(page: Page) {
  return page.evaluate(() => ({
    url: location.href,
    local: JSON.stringify({ ...localStorage }),
    session: JSON.stringify({ ...sessionStorage }),
    cookie: document.cookie,
  }));
}

test.beforeAll(async () => {
  await admin.query(`CREATE DATABASE ${dbName}`);
  await migrate(dbUrl.toString());
  pool = new Pool({ connectionString: dbUrl.toString() });
  blobDir = await mkdtemp(join(tmpdir(), 'community-browser-membership-'));
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
  for (const path of ['/', '/host', '/c/:communityId', '/c/:communityId/*'])
    app.get(
      path,
      serveStatic({ path: fileURLToPath(new URL('../dist/index.html', import.meta.url)) })
    );
  server = serve({ fetch: app.fetch, port, hostname: '127.0.0.1' });
  await new Promise<void>((resolve) => server.once('listening', resolve));

  const setup = await bootstrapFirstHost(post, {
    secret: config.bootstrapSecret,
    accountName: 'Host Operator',
    email: operatorEmail,
    password,
    communityName: 'First Place',
    channelName: 'general',
  });
  operatorCookie = setup.cookie;
  firstId = setup.communityId;
  generalId = setup.channelId;
  // A second community the operator also owns, set up the way host creation leaves it.
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const created = await client.query<{ id: string }>(
      "INSERT INTO communities(name,lifecycle) VALUES('Second Place','pending_owner') RETURNING id"
    );
    secondId = created.rows[0].id;
    const owner = await client.query<{ id: string }>(
      `INSERT INTO members(community_id,user_id,display_name,handle,role)
       SELECT $1,id,'Host Operator','host-operator','owner' FROM "user" WHERE email=$2
       RETURNING id`,
      [secondId, operatorEmail]
    );
    await client.query(
      'INSERT INTO community_handles(community_id,handle,member_id) VALUES($1,$2,$3)',
      [secondId, 'host-operator', owner.rows[0].id]
    );
    await client.query("UPDATE communities SET lifecycle='active' WHERE id=$1", [secondId]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
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

test('the chooser routes one, several, suspended, removed, stale and zero memberships by keyboard', async ({
  browser,
}) => {
  const rinId = await admitNewAccount(firstId, 'Rin', 'rin@membership.test');
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  try {
    await signIn(context, 'rin@membership.test');

    // One active membership enters its canonical route directly.
    await page.goto(baseUrl);
    await expect(page).toHaveURL(`${baseUrl}/c/${firstId}`);
    await expect(page.getByRole('heading', { name: 'First Place' })).toBeVisible();

    // With that same single membership, a link it cannot open stops at the chooser to say so
    // instead of silently carrying the person into the one community they do have.
    await page.goto(`${baseUrl}/c/${randomUUID()}`);
    await expect(page).toHaveURL(`${baseUrl}/`);
    await expect(page.getByRole('status')).toHaveText(
      'That community is not available to this account.'
    );
    await expect(
      page.getByRole('list', { name: 'Choose a community' }).getByRole('button')
    ).toHaveCount(1);
    await page.getByRole('button', { name: /First Place/ }).click();
    await expect(page).toHaveURL(`${baseUrl}/c/${firstId}`);

    // Several show the chooser, focused on its heading, in keyboard order.
    await admitExistingAccount(secondId, 'rin@membership.test');
    // A remembered choice this account cannot see is ignored and forgotten.
    const stale = randomUUID();
    await page.evaluate((id) => localStorage.setItem('communityLastAuthorizedId', id), stale);
    await page.goto(baseUrl);
    const heading = page.getByRole('heading', { name: 'Choose a community' });
    await expect(heading).toBeFocused();
    const choices = page.getByRole('list', { name: 'Choose a community' }).getByRole('button');
    await expect(choices).toHaveCount(2);
    await expect(choices.nth(0)).toContainText('First Place');
    await expect(choices.nth(1)).toContainText('Second Place');
    await expect(page.getByText('Last opened')).toHaveCount(0);
    expect(await page.evaluate(() => localStorage.getItem('communityLastAuthorizedId'))).toBeNull();
    await shot(page, 'chooser-several');
    await page.keyboard.press('Tab');
    await expect(choices.nth(0)).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(choices.nth(1)).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(`${baseUrl}/c/${secondId}`);
    await expect(page.getByRole('heading', { name: 'Second Place' })).toBeVisible();
    // The last authorized choice is remembered by immutable ID and labelled, never trusted.
    await page.goto(baseUrl);
    await expect(choices.nth(1)).toContainText('Last opened');

    // A suspended community stays listed, reachable by keyboard, and explains itself; it
    // cannot be entered, and its route returns here with a notice that reveals nothing.
    await pool.query(
      "UPDATE communities SET lifecycle='suspended',suspended_from_state='active',suspended_at=now() WHERE id=$1",
      [secondId]
    );
    await page.goto(`${baseUrl}/c/${secondId}`);
    await expect(page).toHaveURL(`${baseUrl}/`);
    await expect(heading).toBeFocused();
    await expect(page.getByRole('status')).toHaveText(
      'That community is not available to this account.'
    );
    const suspended = choices.filter({ hasText: 'Second Place' });
    await expect(suspended).toBeDisabled();
    await expect(suspended).toHaveAccessibleDescription(
      'The person running this host has paused it. Your membership is unchanged.'
    );
    await expect(suspended).toContainText('Suspended');
    await shot(page, 'chooser-suspended');
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    await expect(suspended).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(`${baseUrl}/`);
    // The notice is shown once, not on every later visit.
    await page.reload();
    await expect(heading).toBeVisible();
    await expect(page.getByText('That community is not available to this account.')).toHaveCount(0);

    // A removed member can still sign in, but that community is gone from the chooser and its
    // route returns here with the same notice as a community that never existed.
    await removeMember(firstId, rinId);
    await page.goto(`${baseUrl}/c/${firstId}`);
    await expect(page).toHaveURL(`${baseUrl}/`);
    await expect(page.getByRole('status')).toHaveText(
      'That community is not available to this account.'
    );
    await expect(choices).toHaveCount(1);
    await expect(choices.first()).toContainText('Second Place');
    await shot(page, 'chooser-removed');
    await page.goto(`${baseUrl}/c/${randomUUID()}`);
    await expect(page).toHaveURL(`${baseUrl}/`);
    await expect(page.getByRole('status')).toHaveText(
      'That community is not available to this account.'
    );
    await pool.query(
      "UPDATE communities SET lifecycle='active',suspended_from_state=NULL,suspended_at=NULL WHERE id=$1",
      [secondId]
    );

    // Zero memberships: an empty state with the way in, and no host administration path for
    // an account that does not run the host.
    await pool.query(
      `UPDATE members SET active=false,removed_at=now()
       WHERE community_id=$1 AND user_id=(SELECT id FROM "user" WHERE email=$2)`,
      [secondId, 'rin@membership.test']
    );
    await page.goto(baseUrl);
    await expect(heading).toBeFocused();
    await expect(
      page.getByText('This account does not have a community membership yet.')
    ).toBeVisible();
    await expect(
      page.getByText(
        'To join one, open an invitation link from one of its members in this browser.'
      )
    ).toBeVisible();
    await expect(page.getByRole('link', { name: 'Host administration' })).toHaveCount(0);
    await shot(page, 'chooser-zero');
    // A failed membership read says so and offers a retry instead of an empty chooser.
    await failNext(page, '**/api/v1/memberships', 503);
    await page.reload();
    await expect(page.getByRole('alert')).toContainText('The community is unavailable.');
    await page.getByRole('button', { name: 'Try again' }).click();
    await expect(
      page.getByText('This account does not have a community membership yet.')
    ).toBeVisible();
  } finally {
    await context.close();
  }

  // A host operator with no membership of their own is offered host administration. Rin,
  // who now has none, is made an operator only for this check.
  const operator = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  try {
    await pool.query(
      `INSERT INTO host_operators(user_id) SELECT id FROM "user" WHERE email='rin@membership.test'`
    );
    await signIn(operator, 'rin@membership.test');
    const operatorPage = await operator.newPage();
    await operatorPage.goto(baseUrl);
    await expect(
      operatorPage.getByText('This account does not have a community membership yet.')
    ).toBeVisible();
    await expect(operatorPage.getByRole('link', { name: 'Host administration' })).toHaveAttribute(
      'href',
      '/host'
    );
    await shot(operatorPage, 'chooser-zero-operator');
  } finally {
    await pool.query(
      `DELETE FROM host_operators WHERE user_id=(SELECT id FROM "user" WHERE email='rin@membership.test')`
    );
    await operator.close();
  }
});

test('an invitation survives reload, says when membership was not added, and shows rejoin scope', async ({
  browser,
}) => {
  // A new person opens a channel invitation at phone width.
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  try {
    const { token, link } = await invite(firstId, generalId);
    await page.goto(link);
    await expect(page.getByRole('heading', { name: 'Come on in.' })).toBeVisible();
    await expect.poll(() => page.evaluate(() => location.hash)).toBe('');
    await shot(page, 'invite-found');
    await page.getByRole('button', { name: 'Continue' }).click();
    const review = page.getByRole('heading', { name: 'Join First Place' });
    await expect(review).toBeFocused();
    await expect(page.getByText('Invited by Host Operator to #general')).toBeVisible();
    await expect(page.getByText(/^Finish joining by /u)).toBeVisible();
    const account = page.getByRole('group', { name: 'Account' });
    await expect(
      account.getByRole('button', { name: 'Create an account on this host' })
    ).toHaveAttribute('aria-pressed', 'true');
    await expect(account.getByRole('button', { name: 'Sign in to this host' })).toHaveAttribute(
      'aria-pressed',
      'false'
    );
    await shot(page, 'invite-review');

    // A reload keeps the review from the server-held join attempt, never from the page.
    await page.reload();
    await expect(review).toBeVisible();
    await expect(page.getByText('Invited by Host Operator to #general')).toBeVisible();
    const persisted = await persistedState(page);
    expect(persisted.url).toBe(`${baseUrl}/c/${firstId}/join`);
    for (const value of Object.values(persisted)) expect(value).not.toContain(token);
    expect(persisted.cookie).not.toContain('community_admission');

    // Keyboard only: fill the account form and submit it with Enter. The account is created,
    // but the join fails once, and the page says exactly that.
    await failNext(page, '**/invites/redeem', 503);
    await page.getByLabel('Your name').focus();
    await page.keyboard.type('Noor');
    await page.keyboard.press('Tab');
    await page.keyboard.type('noor@membership.test');
    await page.keyboard.press('Tab');
    await page.keyboard.type(password);
    await page.keyboard.press('Enter');
    const partial = page.getByRole('heading', {
      name: 'Your account was created, but membership was not added.',
    });
    await expect(partial).toBeFocused();
    await expect(page.getByRole('alert')).toHaveText('The community did not respond.');
    await shot(page, 'invite-failed-after-account');
    const noor = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM members m JOIN "user" u ON u.id=m.user_id
       WHERE u.email='noor@membership.test' AND m.active`
    );
    expect(noor.rows[0].n).toBe(0);
    await page.getByRole('button', { name: 'Try again' }).click();
    const joined = page.getByRole('heading', { name: 'You’re in First Place.' });
    await expect(joined).toBeFocused();
    await shot(page, 'invite-joined');
    await page.getByRole('button', { name: 'Open community' }).click();
    await expect(page).toHaveURL(`${baseUrl}/c/${firstId}`);
    await expect(page.getByRole('heading', { name: '# general' })).toBeVisible();
  } finally {
    await context.close();
  }

  // An unusable link reads the same as every other one and offers only a new invitation.
  const stranger = await browser.newContext({ viewport: { width: 390, height: 844 } });
  try {
    const page2 = await stranger.newPage();
    await page2.goto(`${baseUrl}/c/${firstId}/join#invite=not-a-real-invitation`);
    await page2.getByRole('button', { name: 'Continue' }).click();
    await expect(page2.getByRole('heading', { name: 'Membership was not added.' })).toBeFocused();
    const refusal = page2.getByRole('alert');
    await expect(refusal).toContainText('This invitation cannot be used.');
    await expect(refusal).toContainText(
      'Ask the person who invited you for a new invitation link.'
    );
    await expect(page2.getByRole('button', { name: 'Try again' })).toHaveCount(0);
    await shot(page2, 'invite-unusable');

    // Reloading before the invitation was checked leaves nothing to resume.
    const { link } = await invite(firstId);
    // Leave the join path first: a link differing only by fragment would not reload the page.
    await page2.goto('about:blank');
    await page2.goto(link);
    await expect(page2.getByRole('button', { name: 'Continue' })).toBeVisible();
    await page2.reload();
    await expect(page2).toHaveURL(`${baseUrl}/c/${firstId}/join`);
    await expect(page2.getByText('Open your invitation link again.')).toBeVisible();
    await expect(
      page2.getByText('This page no longer holds an invitation, so membership was not added.', {
        exact: false,
      })
    ).toBeVisible();
    await shot(page2, 'invite-reopen');

    // An expired join attempt is not resumed either.
    const expiring = await invite(firstId);
    await page2.goto('about:blank');
    await page2.goto(expiring.link);
    await page2.getByRole('button', { name: 'Continue' }).click();
    await expect(page2.getByRole('heading', { name: 'Join First Place' })).toBeFocused();
    await pool.query(
      'UPDATE pending_admissions SET expires_at=now() WHERE community_id=$1 AND consumed_at IS NULL AND account_id IS NULL AND expires_at>now()',
      [firstId]
    );
    await page2.reload();
    await expect(page2.getByText('Open your invitation link again.')).toBeVisible();
  } finally {
    await stranger.close();
  }

  // A removed member, already signed in, sees what rejoining restores before anything
  // changes, and the review survives a reload.
  const kaiId = await admitNewAccount(firstId, 'Kai', 'kai@membership.test');
  await removeMember(firstId, kaiId);
  const returning = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  try {
    await signIn(returning, 'kai@membership.test');
    const page3 = await returning.newPage();
    const { link } = await invite(firstId);
    await page3.goto(link);
    await page3.getByRole('button', { name: 'Continue' }).click();
    const rejoin = page3.getByRole('heading', { name: 'Rejoin First Place?' });
    await expect(rejoin).toBeFocused();
    await expect(page3.getByRole('heading', { name: 'What stays removed' })).toBeVisible();
    await expect(
      page3.getByText(
        'DorkOS installations you connected before. Connect each one again if you need it.'
      )
    ).toBeVisible();
    await expect(page3.getByText('Your role. You rejoin as a member.')).toBeVisible();
    await shot(page3, 'invite-rejoin');
    expect(
      (await pool.query('SELECT active FROM members WHERE id=$1', [kaiId])).rows[0].active
    ).toBe(false);
    await page3.reload();
    await expect(rejoin).toBeVisible();
    await page3.getByRole('button', { name: 'Rejoin community' }).click();
    await expect(page3.getByRole('heading', { name: 'You’re in First Place.' })).toBeVisible();
    expect(
      (await pool.query('SELECT active FROM members WHERE id=$1', [kaiId])).rows[0].active
    ).toBe(true);

    // An active member opening another invitation is not added twice and goes straight in.
    const again = await invite(firstId);
    await page3.goto('about:blank');
    await page3.goto(again.link);
    await page3.getByRole('button', { name: 'Continue' }).click();
    await expect(page3).toHaveURL(`${baseUrl}/c/${firstId}`);
    await expect(page3.getByRole('heading', { name: '# general' })).toBeVisible();
    expect(
      (
        await pool.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM members WHERE community_id=$1
           AND user_id=(SELECT id FROM "user" WHERE email='kai@membership.test')`,
          [firstId]
        )
      ).rows[0].n
    ).toBe(1);
  } finally {
    await returning.close();
  }
});
