import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { test, expect, type BrowserContext, type Page, type Route } from '@playwright/test';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Pool } from 'pg';
import { interceptNext } from '@dorkos/test-utils/playwright-routes';
import { createCommunityApp } from '../src/app.js';
import { parseConfig } from '../src/config.js';
import { migrate } from '../src/migrate.js';

// COMMUNITY_OWNER_CLAIM_SCREENSHOTS optionally names a directory for reviewable screenshots.
const { COMMUNITY_TEST_DATABASE_URL: adminUrl, COMMUNITY_OWNER_CLAIM_SCREENSHOTS: shots } =
  process.env;
if (!adminUrl)
  throw new Error('COMMUNITY_TEST_DATABASE_URL is required for community browser tests');
const dbName = `community_browser_claim_${randomUUID().replaceAll('-', '')}`;
const dbUrl = new URL(adminUrl);
dbUrl.pathname = `/${dbName}`;
const admin = new Pool({ connectionString: adminUrl });
const operator = { email: 'operator@claim.test', password: 'password1234' };
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

/** Sign the context in to the host through the same Better Auth endpoint the page uses. */
async function signIn(context: BrowserContext, email: string, password: string) {
  const response = await context.request.post(`${baseUrl}/api/auth/sign-in/email`, {
    headers: { origin: baseUrl },
    data: { email, password },
  });
  expect(response.ok()).toBe(true);
}

/** Create a pending community in host administration and return the displayed claim link. */
async function createPendingCommunity(page: Page, name: string) {
  await page.goto(`${baseUrl}/host`);
  await page.getByLabel('Name', { exact: true }).fill(name);
  await page.getByRole('button', { name: 'Create community' }).click();
  await expect(page.getByRole('status')).toContainText('Send the owner claim link');
  const link = await page.getByLabel('Owner claim link').inputValue();
  expect(link).toMatch(new RegExp(`^${baseUrl}/claim#claim=[\\w-]+$`, 'u'));
  return { link, secret: new URL(link).hash.slice('#claim='.length) };
}

/** Intercept the next owner-claim request once, then let later ones reach the server. */
function interceptNextClaim(page: Page, handle: (route: Route) => Promise<void>) {
  return interceptNext(page, '**/api/v1/owner-claims/claim', handle);
}

/** Record every request URL and referrer so a test can prove the secret never left the page. */
function recordRequests(page: Page) {
  const seen: string[] = [];
  page.on('request', (request) => {
    seen.push(request.url(), request.headers().referer ?? '', request.postData() ?? '');
  });
  return seen;
}

async function ownerRole(email: string, communityName: string) {
  const result = await pool.query<{ role: string; lifecycle: string }>(
    `SELECT m.role,c.lifecycle FROM members m
     JOIN communities c ON c.id=m.community_id
     JOIN "user" u ON u.id=m.user_id
     WHERE u.email=$1 AND c.name=$2 AND m.active`,
    [email, communityName]
  );
  return result.rows[0] ?? null;
}

test.beforeAll(async () => {
  await admin.query(`CREATE DATABASE ${dbName}`);
  await migrate(dbUrl.toString());
  pool = new Pool({ connectionString: dbUrl.toString() });
  blobDir = await mkdtemp(join(tmpdir(), 'community-browser-claim-'));
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
  for (const path of ['/', '/host', '/claim', '/c/:communityId', '/c/:communityId/*'])
    app.get(
      path,
      serveStatic({ path: fileURLToPath(new URL('../dist/index.html', import.meta.url)) })
    );
  server = serve({ fetch: app.fetch, port, hostname: '127.0.0.1' });
  await new Promise<void>((resolve) => server.once('listening', resolve));

  // First-host setup makes the operator; later communities start from host administration.
  const post = (path: string, body: unknown, cookie = '') =>
    fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: {
        origin: baseUrl,
        'content-type': 'application/json',
        ...(cookie ? { cookie } : {}),
      },
      body: JSON.stringify(body),
    });
  const grant = await post('/api/v1/bootstrap/preflight', { secret: config.bootstrapSecret });
  const cookie = grant.headers
    .getSetCookie()
    .map((header) => header.split(';')[0])
    .join('; ');
  const completed = await post(
    '/api/v1/bootstrap/complete',
    {
      secret: config.bootstrapSecret,
      accountName: 'Host Operator',
      email: operator.email,
      password: operator.password,
      communityName: 'First Place',
      channelName: 'general',
    },
    cookie
  );
  expect(completed.status).toBe(201);
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

test('a host administrator creates a community and its intended owner signs up and claims it', async ({
  browser,
}) => {
  const hostContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const hostPage = await hostContext.newPage();
  const ownerContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const ownerPage = await ownerContext.newPage();
  try {
    await signIn(hostContext, operator.email, operator.password);
    const { link, secret } = await createPendingCommunity(hostPage, 'Second Place');
    // A refused clipboard says so and leaves the whole link selected for copying by hand.
    await hostPage.evaluate(() => {
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: { writeText: () => Promise.reject(new Error('blocked')) },
      });
    });
    await hostPage.getByRole('button', { name: 'Copy link' }).click();
    await expect(hostPage.getByText('Copy the selected link by hand.')).toBeVisible();
    await expect(hostPage.getByLabel('Owner claim link')).toBeFocused();
    expect(
      await hostPage
        .getByLabel('Owner claim link')
        .evaluate((input: HTMLInputElement) =>
          input.value.slice(input.selectionStart ?? 0, input.selectionEnd ?? 0)
        )
    ).toBe(link);
    await hostPage.evaluate(() => {
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: {
          writeText: (text: string) => {
            (window as unknown as { copiedLink: string }).copiedLink = text;
            return Promise.resolve();
          },
        },
      });
    });
    await hostPage.getByRole('button', { name: 'Copy link' }).click();
    await expect(hostPage.getByText('Link copied.')).toBeVisible();
    expect(
      await hostPage.evaluate(() => (window as unknown as { copiedLink: string }).copiedLink)
    ).toBe(link);
    await shot(hostPage, 'host-link');
    await expect(hostPage.getByLabel('Second Place community')).toContainText('pending owner');

    const requests = recordRequests(ownerPage);
    await ownerPage.goto(link);
    await expect(ownerPage.getByRole('heading', { name: 'Become the owner.' })).toBeVisible();
    await expect(ownerPage.getByText('Owner claim link found')).toBeVisible();
    await expect.poll(() => ownerPage.evaluate(() => location.href)).toBe(`${baseUrl}/claim`);
    await shot(ownerPage, 'found');

    await ownerPage.getByRole('button', { name: 'Continue' }).click();
    await expect(
      ownerPage.getByRole('button', { name: 'Create account', exact: true })
    ).toBeVisible();
    await expect(ownerPage.getByRole('heading', { name: 'Become the owner.' })).toBeFocused();
    // A reload after preflight resumes from the HTTP-only claim, with no secret in the page.
    await ownerPage.reload();
    await expect(ownerPage.getByLabel('Your name')).toBeVisible();
    await shot(ownerPage, 'account');

    await ownerPage.getByLabel('Your name').fill('Priya');
    await ownerPage.getByLabel('Email').fill('priya@claim.test');
    await ownerPage.getByLabel('Password').fill('password1234');
    await ownerPage.getByRole('button', { name: 'Create account and claim' }).click();
    await expect(
      ownerPage.getByRole('heading', { name: 'You’re the owner of Second Place.' })
    ).toBeVisible();
    await expect(ownerPage.getByText('Connect this DorkOS installation')).toBeVisible();
    await shot(ownerPage, 'claimed');
    expect(await ownerRole('priya@claim.test', 'Second Place')).toEqual({
      role: 'owner',
      lifecycle: 'active',
    });

    await ownerPage.getByRole('button', { name: 'Open community' }).click();
    await expect(ownerPage).toHaveURL(/\/c\/[0-9a-f-]{36}$/u);
    await expect(ownerPage.getByRole('heading', { name: 'No channels yet' })).toBeVisible({
      timeout: 15_000,
    });

    // The secret stayed in page memory: never in a request, referrer, body, or browser storage.
    const preflightBodies = requests.filter((entry) => entry.includes(secret));
    expect(preflightBodies).toEqual([JSON.stringify({ token: secret })]);
    const stored = await ownerPage.evaluate(() =>
      JSON.stringify({ ...localStorage, ...sessionStorage })
    );
    expect(stored).not.toContain(secret);

    await hostPage.reload();
    await expect(hostPage.getByLabel('Second Place community')).toContainText('Owner assigned');

    // The link works once. Reopening it shows the same answer as any unusable claim.
    const lateContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const latePage = await lateContext.newPage();
    await latePage.goto(link);
    await latePage.getByRole('button', { name: 'Continue' }).click();
    await expect(
      latePage.getByRole('heading', { name: 'This owner claim can’t be used.' })
    ).toBeVisible();
    await shot(latePage, 'unavailable');
    await latePage.getByRole('button', { name: 'Use a different claim link' }).click();
    await expect(latePage.getByLabel('Owner claim link')).toBeVisible();
    await shot(latePage, 'enter');
    await latePage.getByLabel('Owner claim link').fill('https://elsewhere.test/claim#claim=nope');
    await latePage.getByLabel('Owner claim link').press('Enter');
    await expect(
      latePage.getByRole('heading', { name: 'This owner claim can’t be used.' })
    ).toBeVisible();
    await lateContext.close();
  } finally {
    await hostContext.close();
    await ownerContext.close();
  }
});

test('a signed-in account confirms, can switch accounts, and recovers from failed claims', async ({
  browser,
}) => {
  const hostContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const hostPage = await hostContext.newPage();
  try {
    await signIn(hostContext, operator.email, operator.password);

    // The operator opening the link is still asked to claim as the signed-in account.
    const third = await createPendingCommunity(hostPage, 'Third Place');
    await hostPage.goto(third.link);
    await hostPage.getByRole('button', { name: 'Continue' }).click();
    await expect(hostPage.getByText('Signed in as Host Operator')).toBeVisible();
    await shot(hostPage, 'confirm');
    expect(await ownerRole(operator.email, 'Third Place')).toBeNull();

    // A server failure keeps the claim and says what went wrong; retrying finishes it.
    await interceptNextClaim(hostPage, async (route) =>
      route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ code: 'UNAVAILABLE', message: 'The host is busy. Try again.' }),
      })
    );
    await hostPage.getByRole('button', { name: 'Claim community' }).click();
    await expect(hostPage.getByRole('alert')).toContainText('The host is busy');
    await shot(hostPage, 'server-error');
    await hostPage.getByRole('button', { name: 'Claim community' }).click();
    await expect(
      hostPage.getByRole('heading', { name: 'You’re the owner of Third Place.' })
    ).toBeVisible();
    await shot(hostPage, 'claimed');

    // A claim whose response is lost still lands: the page finds the new ownership.
    const fourth = await createPendingCommunity(hostPage, 'Fourth Place');
    await hostPage.goto(fourth.link);
    await hostPage.getByRole('button', { name: 'Continue' }).click();
    await interceptNextClaim(hostPage, async (route) => {
      await route.fetch();
      await route.abort('connectionfailed');
    });
    await hostPage.getByRole('button', { name: 'Claim community' }).click();
    await expect(
      hostPage.getByRole('heading', { name: 'You’re the owner of Fourth Place.' })
    ).toBeVisible();

    // The wrong account switches away without spending the claim.
    const fifth = await createPendingCommunity(hostPage, 'Fifth Place');
    const switchContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const switchPage = await switchContext.newPage();
    await signIn(switchContext, operator.email, operator.password);
    await switchPage.goto(fifth.link);
    await switchPage.getByRole('button', { name: 'Continue' }).click();
    await switchPage.getByRole('button', { name: 'Use a different account' }).click();
    await expect(switchPage.getByLabel('Email')).toBeVisible();
    await expect(switchPage.getByRole('button', { name: 'Sign in and claim' })).toBeVisible();
    await switchPage.getByRole('button', { name: 'Create account', exact: true }).click();
    await switchPage.getByLabel('Your name').fill('Kai');
    await switchPage.getByLabel('Email').fill('kai@claim.test');
    await switchPage.getByLabel('Password').fill('password1234');
    // The account survives a failed claim, and the page says ownership was not added yet.
    await interceptNextClaim(switchPage, async (route) =>
      route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ code: 'UNAVAILABLE', message: 'The host is busy. Try again.' }),
      })
    );
    await switchPage.getByRole('button', { name: 'Create account and claim' }).click();
    await expect(switchPage.getByRole('alert')).toContainText(
      'Your account was created, but you are not the owner yet.',
      { timeout: 15_000 }
    );
    await expect(switchPage.getByText('Signed in as Kai')).toBeVisible();
    await shot(switchPage, 'account-created-claim-failed');
    await switchPage.getByRole('button', { name: 'Claim community' }).click();
    await expect(
      switchPage.getByRole('heading', { name: 'You’re the owner of Fifth Place.' })
    ).toBeVisible();
    expect(await ownerRole('kai@claim.test', 'Fifth Place')).toEqual({
      role: 'owner',
      lifecycle: 'active',
    });
    expect(await ownerRole(operator.email, 'Fifth Place')).toBeNull();
    await switchContext.close();

    // A community that stopped waiting for an owner says so plainly.
    const sixth = await createPendingCommunity(hostPage, 'Sixth Place');
    await hostPage.goto(sixth.link);
    await hostPage.getByRole('button', { name: 'Continue' }).click();
    await interceptNextClaim(hostPage, async (route) =>
      route.fulfill({
        status: 409,
        contentType: 'application/json',
        body: JSON.stringify({
          code: 'STATE_CONFLICT',
          message: 'This community already has an owner.',
        }),
      })
    );
    await hostPage.getByRole('button', { name: 'Claim community' }).click();
    await expect(
      hostPage.getByRole('heading', { name: 'This community already has an owner.' })
    ).toBeFocused();
    await shot(hostPage, 'taken');
  } finally {
    await hostContext.close();
  }
});
