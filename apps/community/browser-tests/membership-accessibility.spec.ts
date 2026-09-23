import { createHash, randomBytes, randomUUID } from 'node:crypto';
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
  type BrowserContext,
  type Page,
  type TestInfo,
} from '@playwright/test';
import type { AxeResults, Result } from 'axe-core';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Pool } from 'pg';
import { createCommunityApp } from '../src/app.js';
import { parseConfig } from '../src/config.js';
import { migrate } from '../src/migrate.js';
import { bootstrapFirstHost } from '../src/__tests__/bootstrap-test-helper.js';

// Accessibility proof (task 3.2) of specs/community-membership-journeys: every membership
// surface of the Community site passes axe at desktop and 390px phone width, in light and dark,
// with phone touch targets of at least 44px; and a person can join and leave by keyboard alone,
// with focus moved and every change announced.
const { COMMUNITY_TEST_DATABASE_URL: adminUrl } = process.env;
if (!adminUrl)
  throw new Error('COMMUNITY_TEST_DATABASE_URL is required for community browser tests');
const dbName = `community_browser_access_${randomUUID().replaceAll('-', '')}`;
const dbUrl = new URL(adminUrl);
dbUrl.pathname = `/${dbName}`;
const admin = new Pool({ connectionString: adminUrl });
const password = 'password1234';
const operatorEmail = 'operator@access.test';
const AXE_BUNDLE = createRequire(import.meta.url).resolve('axe-core/axe.min.js');
/** The phone touch-target floor the DorkOS design system uses for rows and controls. */
const TOUCH_TARGET = 44;
let pool: Pool;
let server: ReturnType<typeof serve>;
let baseUrl: string;
let blobDir: string;
let firstId: string;
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

function post(path: string, body: unknown, cookie = '') {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { origin: baseUrl, 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  });
}

async function invite(communityId: string) {
  const response = await post(
    `/api/v1/communities/${communityId}/invites`,
    { seats: 1 },
    operatorCookie
  );
  expect(response.status).toBe(201);
  const { token } = (await response.json()) as { token: string };
  return `${baseUrl}/c/${communityId}/join#invite=${encodeURIComponent(token)}`;
}

/** Admit an account through the production invitation protocol, off-screen. */
async function admit(communityId: string, name: string, email: string, existing = false) {
  const link = await invite(communityId);
  const token = decodeURIComponent(new URL(link).hash.slice('#invite='.length));
  const api = await playwrightRequest.newContext({
    baseURL: baseUrl,
    extraHTTPHeaders: { origin: baseUrl },
  });
  try {
    const tenant = `/api/v1/communities/${communityId}`;
    if (existing)
      expect((await api.post('/api/auth/sign-in/email', { data: { email, password } })).ok()).toBe(
        true
      );
    expect((await api.post(`${tenant}/invites/preflight`, { data: { token } })).ok()).toBe(true);
    if (!existing)
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

/** Record a connected installation the way a completed pairing leaves it. */
async function connectInstallation(communityId: string, memberId: string, installName: string) {
  await pool.query(
    `INSERT INTO connection_grants(community_id,member_id,token_hash,scopes,install_name)
     VALUES($1,$2,$3,$4,$5)`,
    [
      communityId,
      memberId,
      createHash('sha256').update(randomBytes(32)).digest('hex'),
      ['read', 'post', 'enroll-agent'],
      installName,
    ]
  );
}

/** Start a pairing the way a local DorkOS server does, and return its approval URL. */
async function startPairing(communityId: string, installName: string) {
  const challenge = createHash('sha256')
    .update(randomBytes(32).toString('base64url'))
    .digest('base64url');
  const started = await fetch(`${baseUrl}/api/v1/communities/${communityId}/pairings/start`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ installName, challenge, scopes: ['read', 'post', 'enroll-agent'] }),
  });
  expect(started.status).toBe(201);
  return ((await started.json()) as { approvalUrl: string }).approvalUrl;
}

async function signIn(context: BrowserContext, email: string) {
  const response = await context.request.post(`${baseUrl}/api/auth/sign-in/email`, {
    headers: { origin: baseUrl },
    data: { email, password },
  });
  expect(response.ok()).toBe(true);
}

function describeViolation(violation: Result): string {
  return `${violation.id} (${violation.impact}): ${violation.nodes
    .map((node) => `${node.target.join(' ')} — ${node.failureSummary?.replace(/\s+/g, ' ')}`)
    .join(' | ')}`;
}

/** Every visible control on screen smaller than the touch floor, described for a failure. */
async function smallTargets(page: Page, exclude: string | undefined): Promise<string[]> {
  return page.evaluate(
    ([floor, outside]) => {
      const found: string[] = [];
      for (const element of Array.from(
        document.querySelectorAll<HTMLElement>(
          'button, a.button, input:not([type="hidden"]), select, textarea, [role="button"]'
        )
      )) {
        const box = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        // Off-canvas navigation, hidden and zero-size elements are not on screen to tap.
        if (!box.width || !box.height || style.visibility === 'hidden') continue;
        if (box.right <= 0 || box.left >= window.innerWidth) continue;
        if (element.closest('[inert], [aria-hidden="true"]')) continue;
        if (outside && element.closest(outside)) continue;
        if (box.height < floor - 0.5 || box.width < floor - 0.5)
          found.push(
            `${element.tagName.toLowerCase()} "${(element.getAttribute('aria-label') || element.textContent || element.id).trim().slice(0, 40)}" ${Math.round(box.width)}×${Math.round(box.height)}`
          );
      }
      return found;
    },
    [TOUCH_TARGET, exclude] as const
  );
}

/** One surface's audit, kept for the attached per-surface report. */
interface SurfaceAudit {
  surface: string;
  viewport: string;
  scheme: string;
  violations: string[];
  smallTargets: string[];
  horizontalScroll: boolean;
}
const audits: SurfaceAudit[] = [];

/**
 * Audit the page as it stands at desktop and 390px phone width, in light and dark: axe's WCAG
 * 2.2 A/AA rules find nothing, the phone layout never scrolls sideways, and every control on a
 * phone is at least a 44px target. The page's own viewport is restored afterwards.
 */
async function audit(page: Page, surface: string, exclude?: string) {
  const original = page.viewportSize();
  for (const [viewport, size] of [
    ['desktop', { width: 1440, height: 900 }],
    ['phone', { width: 390, height: 844 }],
  ] as const) {
    await page.setViewportSize(size);
    for (const scheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
      // Axe must sample settled theme colors, not a frame during a control's color transition.
      await page.waitForFunction(() =>
        document
          .getAnimations()
          .filter((animation) => animation instanceof CSSTransition)
          .every((animation) => animation.playState !== 'running')
      );
      await page.addScriptTag({ path: AXE_BUNDLE });
      const results = (await page.evaluate(
        (outside) =>
          (
            window as unknown as {
              axe: { run: (context: object, options: object) => Promise<unknown> };
            }
          ).axe.run(
            { include: [['html']], exclude: outside ? [[outside]] : [] },
            {
              runOnly: {
                type: 'tag',
                values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'],
              },
            }
          ),
        exclude
      )) as AxeResults;
      const record: SurfaceAudit = {
        surface,
        viewport,
        scheme,
        violations: results.violations.map(describeViolation),
        smallTargets: viewport === 'phone' ? await smallTargets(page, exclude) : [],
        horizontalScroll: await page.evaluate(
          () => document.documentElement.scrollWidth > window.innerWidth
        ),
      };
      audits.push(record);
      expect.soft(record.violations, `${surface} ${viewport} ${scheme}: axe`).toEqual([]);
      expect
        .soft(record.smallTargets, `${surface} ${viewport} ${scheme}: touch targets`)
        .toEqual([]);
      expect.soft(record.horizontalScroll, `${surface} ${viewport}: sideways scroll`).toBe(false);
    }
  }
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'no-preference' });
  if (original) await page.setViewportSize(original);
}

async function attachAudits(testInfo: TestInfo) {
  await testInfo.attach('membership-accessibility.json', {
    body: JSON.stringify(audits, null, 2),
    contentType: 'application/json',
  });
}

/** Press Tab until `name` has focus, as a keyboard user would, and fail if it never does. */
async function tabTo(page: Page, name: RegExp, limit = 40) {
  for (let step = 0; step < limit; step++) {
    await page.keyboard.press('Tab');
    const focused = await page.evaluate(() => {
      const element = document.activeElement as HTMLInputElement | null;
      return (
        element?.getAttribute('aria-label') ??
        element?.labels?.[0]?.textContent ??
        element?.textContent ??
        ''
      ).trim();
    });
    if (name.test(focused)) return;
  }
  throw new Error(`Tab never reached ${name}`);
}

test.beforeAll(async () => {
  await admin.query(`CREATE DATABASE ${dbName}`);
  await migrate(dbUrl.toString());
  pool = new Pool({ connectionString: dbUrl.toString() });
  blobDir = await mkdtemp(join(tmpdir(), 'community-browser-access-'));
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
  for (const path of ['/', '/host', '/claim', '/c/:communityId', '/c/:communityId/*'])
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
  // A second community the operator also owns, set up the way a completed claim leaves it.
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

test.setTimeout(180_000);

test('every membership surface passes axe at desktop and phone width, light and dark', async ({
  browser,
}, testInfo) => {
  try {
    // Signed out: host sign-in, and a pairing approval that asks for sign-in first.
    const visitor = await browser.newContext();
    try {
      const page = await visitor.newPage();
      await page.goto(baseUrl);
      await expect(page.getByLabel('Email')).toBeVisible();
      await audit(page, 'host sign-in');
      await page.goto(await startPairing(firstId, 'Signed-out laptop'));
      await expect(page.getByLabel('Email')).toBeVisible();
      await audit(page, 'pairing sign-in');
    } finally {
      await visitor.close();
    }

    // A new person: invitation found, review, and an unusable invitation.
    const newcomer = await browser.newContext();
    try {
      const page = await newcomer.newPage();
      await page.goto(await invite(firstId));
      await expect(page.getByRole('heading', { name: 'Come on in.' })).toBeVisible();
      await audit(page, 'invitation found');
      await page.getByRole('button', { name: 'Continue' }).click();
      await expect(page.getByRole('heading', { name: 'Join First Place' })).toBeFocused();
      await audit(page, 'invitation review');
      await page.goto('about:blank');
      await page.goto(`${baseUrl}/c/${firstId}/join#invite=not-a-real-invitation`);
      await page.getByRole('button', { name: 'Continue' }).click();
      await expect(page.getByRole('heading', { name: 'Membership was not added.' })).toBeFocused();
      await audit(page, 'invitation refused');
    } finally {
      await newcomer.close();
    }

    // A member of two communities: chooser, the community, account controls, pairing approval.
    const riaId = await admit(firstId, 'Ria', 'ria@access.test');
    await admit(secondId, 'Ria', 'ria@access.test', true);
    await connectInstallation(firstId, riaId, 'Studio desktop');
    await connectInstallation(firstId, riaId, 'Travel laptop');
    const member = await browser.newContext();
    try {
      await signIn(member, 'ria@access.test');
      const page = await member.newPage();
      await page.goto(baseUrl);
      await expect(page.getByRole('heading', { name: 'Choose a community' })).toBeFocused();
      await audit(page, 'chooser');
      await page.goto(`${baseUrl}/c/${firstId}/settings/account`);
      await expect(page.getByRole('heading', { name: 'Connected installations' })).toBeVisible();
      await expect(page.getByText('Studio desktop')).toBeVisible();
      await audit(page, 'account controls');
      await page.goto(await startPairing(firstId, 'Kitchen mini'));
      await expect(page.getByRole('button', { name: 'Approve connection' })).toBeVisible();
      await audit(page, 'pairing approval');
      await page.goto(`${baseUrl}/c/${firstId}/settings/account`);
      await page.getByRole('button', { name: 'Sign out of this browser' }).click();
      await expect(
        page.getByRole('heading', { name: 'You signed out of this browser.' })
      ).toBeFocused();
      await audit(page, 'signed out');
    } finally {
      await member.close();
    }

    // A removed member rejoining, and the joined confirmation.
    const kaiId = await admit(firstId, 'Kai', 'kai@access.test');
    await pool.query('UPDATE members SET active=false,removed_at=now() WHERE id=$1', [kaiId]);
    const returning = await browser.newContext();
    try {
      await signIn(returning, 'kai@access.test');
      const page = await returning.newPage();
      await page.goto(baseUrl);
      await expect(
        page.getByText('This account does not have a community membership yet.')
      ).toBeVisible();
      await audit(page, 'chooser with no membership');
      await page.goto(await invite(firstId));
      await page.getByRole('button', { name: 'Continue' }).click();
      await expect(page.getByRole('heading', { name: 'Rejoin First Place?' })).toBeFocused();
      await audit(page, 'invitation rejoin');
      await page.getByRole('button', { name: 'Rejoin community' }).click();
      await expect(page.getByRole('heading', { name: 'You’re in First Place.' })).toBeFocused();
      await audit(page, 'joined');
    } finally {
      await returning.close();
    }

    // Host administration issues an owner claim; the intended owner opens it.
    const operator = await browser.newContext();
    const owner = await browser.newContext();
    try {
      await signIn(operator, operatorEmail);
      const hostPage = await operator.newPage();
      await hostPage.goto(`${baseUrl}/host`);
      await hostPage.getByLabel('Name', { exact: true }).fill('Third Place');
      await hostPage.getByRole('button', { name: 'Create community' }).click();
      await expect(hostPage.getByRole('status')).toContainText('Send the owner claim link');
      // Host API keys share this page but are host operations, not a membership surface.
      await audit(hostPage, 'host administration', '[aria-labelledby="host-api-keys-title"]');
      const link = await hostPage.getByLabel('Owner claim link').inputValue();
      const page = await owner.newPage();
      await page.goto(link);
      await expect(page.getByRole('heading', { name: 'Become the owner.' })).toBeVisible();
      await audit(page, 'owner claim found');
      await page.getByRole('button', { name: 'Continue' }).click();
      await expect(page.getByRole('heading', { name: 'Become the owner.' })).toBeFocused();
      await expect(page.getByLabel('Your name')).toBeVisible();
      await audit(page, 'owner claim account');
    } finally {
      await operator.close();
      await owner.close();
    }
  } finally {
    await attachAudits(testInfo);
  }
});

test('a person joins and leaves by keyboard alone, with focus moved and every change announced', async ({
  browser,
}) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  try {
    await page.goto(await invite(firstId));
    await expect(page.getByRole('heading', { name: 'Come on in.' })).toBeVisible();
    await tabTo(page, /^Continue/);
    await page.keyboard.press('Enter');
    await expect(page.getByRole('heading', { name: 'Join First Place' })).toBeFocused();

    await tabTo(page, /^Your name$/);
    await page.keyboard.type('Sol');
    await page.keyboard.press('Tab');
    await page.keyboard.type('sol@access.test');
    await page.keyboard.press('Tab');
    await page.keyboard.type(password);
    await page.keyboard.press('Enter');
    await expect(page.getByRole('heading', { name: 'You’re in First Place.' })).toBeFocused();

    await tabTo(page, /^Open community$/);
    await page.keyboard.press('Enter');
    await expect(page.getByRole('heading', { name: '# general' })).toBeVisible();

    // At phone width the channel list is behind its menu button; Settings lives there.
    await tabTo(page, /^Open channel navigation$/);
    await page.keyboard.press('Enter');
    await tabTo(page, /^Settings$/);
    await page.keyboard.press('Enter');
    await tabTo(page, /^Account$/);
    await page.keyboard.press('Enter');
    await expect(page.getByRole('heading', { name: 'Leave community' })).toBeVisible();

    // A wrong password is announced where the person is, and nothing changes.
    await tabTo(page, /^Enter First Place$/);
    await page.keyboard.type('First Place');
    await page.keyboard.press('Tab');
    await page.keyboard.type('not-my-password');
    page.once('dialog', (dialog) => void dialog.accept());
    await tabTo(page, /^Leave community$/);
    await page.keyboard.press('Enter');
    await expect(page.getByRole('alert')).toContainText('You are still a member.');
    const still = await pool.query<{ active: boolean }>(
      `SELECT m.active FROM members m JOIN "user" u ON u.id=m.user_id
       WHERE u.email='sol@access.test' AND m.community_id=$1`,
      [firstId]
    );
    expect(still.rows[0].active).toBe(true);

    await page.getByLabel('Confirm password').focus();
    await page.keyboard.press('ControlOrMeta+A');
    await page.keyboard.type(password);
    page.once('dialog', (dialog) => void dialog.accept());
    await tabTo(page, /^Leave community$/);
    await page.keyboard.press('Enter');
    // Leaving routes to the chooser, focused on its heading, with the account still signed in.
    await expect(page).toHaveURL(`${baseUrl}/`);
    await expect(page.getByRole('heading', { name: 'Choose a community' })).toBeFocused();
    await expect(
      page.getByText('This account does not have a community membership yet.')
    ).toBeVisible();
    const left = await pool.query<{ active: boolean }>(
      `SELECT m.active FROM members m JOIN "user" u ON u.id=m.user_id
       WHERE u.email='sol@access.test' AND m.community_id=$1`,
      [firstId]
    );
    expect(left.rows[0].active).toBe(false);
  } finally {
    await context.close();
  }
});
