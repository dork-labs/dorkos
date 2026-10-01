import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import {
  test,
  expect,
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
import { formatReplacementDate } from '../src/owner-replacement/dates.js';
import { FileSystemBlobStore } from '../src/storage/index.js';
import { bootstrapFirstHost } from '../src/__tests__/bootstrap-test-helper.js';
import {
  COMPOSERS,
  MINUTE,
  TestClock,
  claim,
  member,
  moveLifecycle,
  objectToken,
  ownedCommunity,
  passwordSignUp,
  preflightClaim,
  promote,
  replacementRow,
  requestReplacement,
  tick,
  toClaimable,
  toWaiting,
  type Owned,
  type ReplacementHost,
} from '../src/__tests__/owner-replacement-fixture.js';
import { TENANCY_PASSWORD, type TenancyHarness } from '../src/__tests__/tenancy-test-harness.js';

// Replacing a community owner in a real browser (specs/community-owner-replacement task 3.1,
// DOR-2542): the host's Owner section with its form and every row state, the owner's banner
// with each combination of options, the admins' banner, the page the owner's emailed link
// opens, the new owner's claim page before and after its date, and every member's notice
// afterwards. Each state passes axe at phone and desktop width with no sideways scroll.
// COMMUNITY_OWNER_REPLACEMENT_SCREENSHOTS optionally names a directory for reviewable shots.
const { COMMUNITY_TEST_DATABASE_URL: adminUrl, COMMUNITY_OWNER_REPLACEMENT_SCREENSHOTS: shots } =
  process.env;
if (!adminUrl)
  throw new Error('COMMUNITY_TEST_DATABASE_URL is required for community browser tests');
const dbName = `community_browser_replace_${randomUUID().replaceAll('-', '')}`;
const dbUrl = new URL(adminUrl);
dbUrl.pathname = `/${dbName}`;
const admin = new Pool({ connectionString: adminUrl });
const AXE_BUNDLE = createRequire(import.meta.url).resolve('axe-core/axe.min.js');
const DAY = 24 * 60 * MINUTE;
// Each test audits several states at two widths, which takes longer than the default.
test.setTimeout(120_000);
const operator = { email: 'operator@replace.test', password: TENANCY_PASSWORD };
// The server's clock for owner replacements; sessions keep the wall clock.
const clock = new TestClock();
let pool: Pool;
let server: ReturnType<typeof serve>;
let baseUrl: string;
let blobDir: string;
let host: ReplacementHost;
let operatorUserId: string;

async function freePort() {
  const socket = createServer();
  await new Promise<void>((resolve) => socket.listen(0, '127.0.0.1', resolve));
  const address = socket.address();
  if (!address || typeof address === 'string') throw new Error('No browser test port');
  await new Promise<void>((resolve) => socket.close(() => resolve()));
  return address.port;
}

/** A date as every owner-replacement sentence says it. */
function day(value: Date | number): string {
  return formatReplacementDate(new Date(value));
}

/**
 * Check the page as it stands at phone and desktop width: axe's WCAG A and AA rules and no
 * sideways scroll, then save a screenshot of each width when screenshots are asked for: of
 * `shotOf` when given (one record on the long host page), otherwise of the whole page.
 */
async function audit(page: Page, name: string, subject?: Locator, shotOf?: Locator) {
  const original = page.viewportSize();
  for (const width of [390, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await subject?.scrollIntoViewIfNeeded();
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
      `${name} at ${width}px: axe`
    ).toEqual([]);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth),
      `${name} at ${width}px: sideways scroll`
    ).toBe(false);
    const path = shots ? join(shots, `${name}-${width}.png`) : null;
    if (path && shotOf) await shotOf.screenshot({ path });
    else if (path) await page.screenshot({ path, fullPage: true });
  }
  if (original) await page.setViewportSize(original);
}

/** A browser context signed in with a session cookie header from the API fixtures. */
async function contextFor(browser: Browser, cookie = ''): Promise<BrowserContext> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  if (cookie)
    await context.addCookies(
      cookie
        .split('; ')
        .filter(Boolean)
        .map((pair) => {
          const at = pair.indexOf('=');
          return { name: pair.slice(0, at), value: pair.slice(at + 1), url: baseUrl };
        })
    );
  return context;
}

/** Every URL, referrer and body the page sent, to prove a secret never left it. */
function recordRequests(page: Page): string[] {
  const seen: string[] = [];
  page.on('request', (request) => {
    seen.push(request.url(), request.headers().referer ?? '');
  });
  return seen;
}

/** Every console line the page wrote. */
function recordConsole(page: Page): string[] {
  const lines: string[] = [];
  page.on('console', (message) => lines.push(message.text()));
  return lines;
}

const hash = () => createHash('sha256').update(randomUUID()).digest('hex');

/**
 * Write one replacement exactly as the server's own steps leave it, for the host's list. The
 * real request, notice and claim steps are driven through the browser and the API in the
 * other tests; this shows every state side by side.
 */
async function seed(
  c: Owned,
  row: {
    state: string;
    reason?: string;
    reference?: string | null;
    notice?: 'pending' | 'accepted' | 'failed';
    verified?: boolean | null;
    afterObjection?: boolean;
    afterWithdrawal?: boolean;
    cause?: 'cancelled' | 'suspended' | 'deletion' | null;
    requestedAt: number;
    resolvedAt?: number | null;
    claimableAfter?: number | null;
    claimExpiresAt?: number | null;
    endedAt?: number | null;
    newOwnerMemberId?: string | null;
  }
): Promise<void> {
  const open = ['notifying', 'waiting', 'claimable'].includes(row.state);
  const at = (value: number | null | undefined) =>
    value === null || value === undefined ? null : new Date(value);
  await pool.query(
    `INSERT INTO owner_replacements(community_id,state,reason,reference,claimant_named,
       claim_token_hash,requested_by_host_actor,idempotency_key,payload_hash,after_objection,
       after_withdrawal,withdrawn_cause,prior_owner_member_id,new_owner_member_id,notice_state,
       notice_resolved_at,verified_address,claimable_after,claim_expires_at,requested_at,ended_at)
     VALUES($1,$2,$3,$4,false,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)`,
    [
      c.communityId,
      row.state,
      row.reason ?? 'owner_unreachable',
      row.reference === undefined ? 'CASE-7' : row.reference,
      open ? hash() : null,
      `person:${operatorUserId}`,
      randomUUID(),
      hash(),
      row.afterObjection ?? false,
      row.afterWithdrawal ?? false,
      row.cause ?? null,
      c.owner.memberId,
      row.newOwnerMemberId ?? null,
      row.notice ?? 'accepted',
      at(row.notice === 'pending' ? null : (row.resolvedAt ?? row.requestedAt)),
      row.verified === undefined ? true : row.verified,
      at(row.claimableAfter),
      at(row.claimExpiresAt),
      at(row.requestedAt),
      at(row.endedAt),
    ]
  );
}

/** The host page's record for one community. */
function record(page: Page, c: Owned): Locator {
  return page.getByRole('article', { name: `${c.name} community` });
}

/** The host page's record for one community, with its Owner part open. */
async function ownerSection(page: Page, c: Owned): Promise<Locator> {
  const section = record(page, c).getByRole('region', { name: `Owner of ${c.name}` });
  if (!(await section.isVisible()))
    await record(page, c).getByText('Owner', { exact: true }).click();
  await expect(section.getByText('Loading requests…')).toHaveCount(0);
  return section;
}

test.beforeAll(async () => {
  await admin.query(`CREATE DATABASE ${dbName}`);
  await migrate(dbUrl.toString());
  pool = new Pool({ connectionString: dbUrl.toString(), max: 10 });
  blobDir = await mkdtemp(join(tmpdir(), 'community-browser-replace-'));
  if (shots) await mkdir(shots, { recursive: true });
  const port = await freePort();
  baseUrl = `http://127.0.0.1:${port}`;
  const config = parseConfig({
    COMMUNITY_DATABASE_URL: dbUrl.toString(),
    COMMUNITY_AUTH_SECRET: 'a'.repeat(32),
    COMMUNITY_INVITE_SECRET: 'b'.repeat(32),
    COMMUNITY_BOOTSTRAP_SECRET: 'c'.repeat(32),
    COMMUNITY_PUBLIC_URL: baseUrl,
    COMMUNITY_STORAGE_PATH: blobDir,
    COMMUNITY_SIGNUP_ATTEMPTS_PER_MINUTE: 100,
    COMMUNITY_BOOTSTRAP_ATTEMPTS_PER_MINUTE: 100,
    COMMUNITY_HOST_KEY_ATTEMPTS_PER_MINUTE: 100,
    COMMUNITY_REAUTH_ATTEMPTS_PER_MINUTE: 20,
    // Mail is set up; nothing here runs the mail worker, so the address is never dialled.
    COMMUNITY_SMTP_URL: 'smtp://127.0.0.1:2525',
    COMMUNITY_MAIL_FROM: 'notices@community.test',
    COMMUNITY_OWNER_REPLACEMENT_NOTICE_DAYS: 7,
    COMMUNITY_OWNER_REPLACEMENT_UNREACHABLE_DAYS: 14,
  });
  const blobStore = new FileSystemBlobStore(blobDir);
  const app = createCommunityApp({
    config,
    pool,
    blobStore,
    hooks: { now: clock.now },
    noticeComposers: COMPOSERS,
    ownerReplacementOpen: true,
  });
  const staticRoot = fileURLToPath(new URL('../dist/', import.meta.url));
  app.use('/assets/*', serveStatic({ root: staticRoot }));
  for (const path of [
    '/',
    '/host',
    '/keep-ownership',
    '/owner-replacement',
    '/c/:communityId',
    '/c/:communityId/*',
  ])
    app.get(
      path,
      serveStatic({ path: fileURLToPath(new URL('../dist/index.html', import.meta.url)) })
    );
  server = serve({ fetch: app.fetch, port, hostname: '127.0.0.1' });
  await new Promise<void>((resolve) => server.once('listening', resolve));

  // The API fixtures drive this same server through a harness-shaped handle.
  const h = {
    config,
    pool,
    blobStore,
    baseUrl,
    call(path, init = {}) {
      const headers: Record<string, string> = { ...init.headers };
      if (init.cookie) headers.cookie = init.cookie;
      if (init.bearer) headers.authorization = `Bearer ${init.bearer}`;
      else headers.origin = baseUrl;
      const body = init.body === undefined ? init.raw : JSON.stringify(init.body);
      if (init.body !== undefined) headers['content-type'] = 'application/json';
      return fetch(`${baseUrl}${path}`, {
        method: init.method ?? (body === undefined ? 'GET' : 'POST'),
        headers,
        body,
      });
    },
    close: async () => {},
  } satisfies TenancyHarness;
  const post = (path: string, body: unknown, cookie: string) =>
    h.call(path, { body, cookie: cookie || undefined });
  const first = await bootstrapFirstHost(post, {
    secret: config.bootstrapSecret,
    accountName: 'Host Operator',
    email: operator.email,
    password: operator.password,
    communityName: 'First Place',
  });
  operatorUserId = (
    await pool.query<{ id: string }>('SELECT id FROM "user" WHERE email=$1', [operator.email])
  ).rows[0].id;
  const issued = await h.call('/api/v1/host/api-keys', {
    cookie: first.cookie,
    body: {
      label: 'Ownership',
      scopes: ['communities:ownership'],
      expiresInDays: null,
      password: TENANCY_PASSWORD,
    },
  });
  expect(issued.status).toBe(201);
  host = {
    h,
    clock,
    operator: first.cookie,
    ownershipKey: ((await issued.json()) as { secret: string }).secret,
  };
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

test('the host asks, sees the claim link once, sends it again, and cancels', async ({
  browser,
}) => {
  const c = await ownedCommunity(host);
  const context = await contextFor(browser, host.operator);
  const page = await context.newPage();
  try {
    await page.goto(`${baseUrl}/host`);
    let section = await ownerSection(page, c);
    await expect(section.getByText('No change requested.')).toBeVisible();
    await audit(page, 'host-owner-empty', section, record(page, c));

    await section.getByRole('button', { name: 'Replace the owner' }).click();
    const dialog = page.getByRole('dialog', { name: `Replace the owner of ${c.name}?` });
    // No single sign-on on this host, so no sign-in ID is asked for.
    await expect(dialog.getByLabel('Sign-in ID of the new owner')).toHaveCount(0);
    await dialog.getByLabel('The owner has left the group this community belongs to').check();
    await dialog.getByLabel('Your reference (optional)').fill('TICKET-42');
    await dialog.getByLabel('Your password').fill(TENANCY_PASSWORD);
    await audit(page, 'host-owner-form', dialog);
    await dialog.getByRole('button', { name: 'Send the request' }).click();

    await expect(
      section.getByText(
        'Send this link to the new owner. It works only after the waiting period, and only once.'
      )
    ).toBeVisible();
    const link = await section.getByLabel('Link for the new owner').inputValue();
    expect(link).toMatch(new RegExp(`^${baseUrl}/owner-replacement#[\\w-]+$`, 'u'));
    await expect(section.getByText('Sending the notice to the owner.')).toBeVisible();
    await expect(section.getByText('Your reference: TICKET-42.')).toBeVisible();
    await audit(page, 'host-owner-link-shown', section, record(page, c));
    const [row] = (
      await pool.query<{ id: string; state: string; reason: string; reference: string }>(
        'SELECT id,state,reason,reference FROM owner_replacements WHERE community_id=$1',
        [c.communityId]
      )
    ).rows;
    expect(row).toMatchObject({
      state: 'notifying',
      reason: 'owner_left_group',
      reference: 'TICKET-42',
    });

    // A reload forgets the link; the host sends a new one, and the owner is told.
    await page.reload();
    section = await ownerSection(page, c);
    await expect(section.getByLabel('Link for the new owner')).toHaveCount(0);
    await section.getByRole('button', { name: 'Send the claim link again' }).click();
    const resend = page.getByRole('dialog', { name: 'Send the claim link again?' });
    await expect(
      resend.getByText('The owner will be told that the link was sent again.')
    ).toBeVisible();
    await audit(page, 'host-owner-resend-confirm', resend);
    await resend.getByRole('button', { name: 'Send it again' }).click();
    await expect(section.getByText('The link you sent before no longer works.')).toBeVisible();
    const again = await section.getByLabel('Link for the new owner').inputValue();
    expect(again).not.toBe(link);
    expect((await replacementRow(host, row.id)).claim_reissued_at).not.toBeNull();

    await section.getByRole('button', { name: 'Cancel', exact: true }).click();
    const cancel = page.getByRole('dialog', { name: 'Cancel this request?' });
    await cancel.getByRole('button', { name: 'Cancel request' }).click();
    await expect(section.getByText('Request withdrawn.')).toBeVisible();
    await expect(section.getByText(`Withdrawn on ${day(clock.now())} by you.`)).toBeVisible();
    expect((await replacementRow(host, row.id)).state).toBe('withdrawn');
  } finally {
    await context.close();
  }
});

test('every request state reads as a sentence on the host page', async ({ browser }) => {
  const now = clock.ms;
  const history = await ownedCommunity(host);
  const successor = await member(host, history, 'Riley Chen');
  // Closed requests, one of each, and an objection whose cooling-off still runs.
  await seed(history, {
    state: 'objected',
    requestedAt: now - 40 * DAY,
    endedAt: now - 35 * DAY,
  });
  await seed(history, {
    state: 'completed',
    requestedAt: now - 200 * DAY,
    claimableAfter: now - 186 * DAY,
    claimExpiresAt: now - 172 * DAY,
    endedAt: now - 180 * DAY,
    newOwnerMemberId: successor.memberId,
  });
  await seed(history, {
    state: 'withdrawn',
    cause: 'suspended',
    requestedAt: now - 160 * DAY,
    endedAt: now - 150 * DAY,
  });
  await seed(history, {
    state: 'withdrawn',
    cause: 'deletion',
    requestedAt: now - 145 * DAY,
    endedAt: now - 140 * DAY,
  });
  await seed(history, {
    state: 'superseded',
    requestedAt: now - 135 * DAY,
    endedAt: now - 130 * DAY,
  });
  await seed(history, {
    state: 'expired',
    requestedAt: now - 120 * DAY,
    claimableAfter: now - 106 * DAY,
    claimExpiresAt: now - 92 * DAY,
    endedAt: now - 92 * DAY,
  });

  // One open request per community, in each open state and each reason for the longer wait.
  const open: [Owned, string][] = [];
  const notifying = await ownedCommunity(host);
  await seed(notifying, { state: 'notifying', notice: 'pending', requestedAt: now - MINUTE });
  open.push([notifying, 'Sending the notice to the owner.']);
  const standard = await ownedCommunity(host);
  await seed(standard, {
    state: 'waiting',
    requestedAt: now - DAY,
    claimableAfter: now + 6 * DAY,
  });
  open.push([
    standard,
    `The owner’s mail server accepted the notice on ${day(now - DAY)}. The owner has until ${day(now + 6 * DAY)}.`,
  ]);
  const failed = await ownedCommunity(host);
  await seed(failed, {
    state: 'waiting',
    notice: 'failed',
    verified: null,
    requestedAt: now - 3 * DAY,
    claimableAfter: now + 11 * DAY,
  });
  open.push([
    failed,
    `The owner has until ${day(now + 11 * DAY)}. The notice couldn’t be delivered by email.`,
  ]);
  const unverified = await ownedCommunity(host);
  await seed(unverified, {
    state: 'waiting',
    verified: false,
    requestedAt: now - DAY,
    claimableAfter: now + 13 * DAY,
  });
  open.push([
    unverified,
    `The owner has until ${day(now + 13 * DAY)}. The owner’s email address was never confirmed.`,
  ]);
  const left = await ownedCommunity(host);
  await seed(left, {
    state: 'waiting',
    reason: 'owner_left_group',
    requestedAt: now - DAY,
    claimableAfter: now + 13 * DAY,
  });
  open.push([
    left,
    `The owner has until ${day(now + 13 * DAY)}. Requests saying the owner has left always have the longer wait.`,
  ]);
  const objectedBefore = await ownedCommunity(host);
  await seed(objectedBefore, {
    state: 'objected',
    requestedAt: now - 130 * DAY,
    endedAt: now - 120 * DAY,
  });
  await seed(objectedBefore, {
    state: 'waiting',
    afterObjection: true,
    requestedAt: now - DAY,
    claimableAfter: now + 13 * DAY,
  });
  open.push([
    objectedBefore,
    `The owner has until ${day(now + 13 * DAY)}. The owner kept ownership before, so this request has the longer wait.`,
  ]);
  const withdrawnRecently = await ownedCommunity(host);
  await seed(withdrawnRecently, {
    state: 'withdrawn',
    cause: 'cancelled',
    requestedAt: now - 12 * DAY,
    endedAt: now - 10 * DAY,
  });
  await seed(withdrawnRecently, {
    state: 'waiting',
    afterWithdrawal: true,
    requestedAt: now - DAY,
    claimableAfter: now + 13 * DAY,
  });
  open.push([
    withdrawnRecently,
    `The owner has until ${day(now + 13 * DAY)}. An earlier request was withdrawn less than 30 days ago, so this one has the longer wait.`,
  ]);
  const claimable = await ownedCommunity(host);
  await seed(claimable, {
    state: 'claimable',
    requestedAt: now - 8 * DAY,
    claimableAfter: now - DAY,
    claimExpiresAt: now + 13 * DAY,
  });
  open.push([claimable, `The new owner can accept until ${day(now + 13 * DAY)}.`]);

  const context = await contextFor(browser, host.operator);
  const page = await context.newPage();
  try {
    await page.goto(`${baseUrl}/host`);
    const section = await ownerSection(page, history);
    const kept = `The owner kept ownership on ${day(now - 35 * DAY)}. You can ask again after ${day(now + 55 * DAY)}.`;
    for (const sentence of [
      `The new owner accepted on ${day(now - 180 * DAY)}.`,
      `Withdrawn on ${day(now - 150 * DAY)} because the community was suspended.`,
      `Withdrawn on ${day(now - 140 * DAY)} because the community is being deleted.`,
      `Ended on ${day(now - 130 * DAY)} because the owner handed the community to someone or asked to delete it.`,
      `The new owner didn’t accept in time. Ended on ${day(now - 92 * DAY)}.`,
    ])
      await expect(section.getByText(sentence, { exact: true })).toBeVisible();
    // Closed requests offer nothing to do, and the cooling-off holds the button with its dates.
    await expect(section.getByRole('button', { name: 'Cancel', exact: true })).toHaveCount(0);
    await expect(section.getByRole('button', { name: 'Replace the owner' })).toBeDisabled();
    await expect(section.getByText(kept, { exact: true })).toHaveCount(2);
    await audit(page, 'host-owner-closed-rows', section, record(page, history));

    for (const [c, sentence] of open) {
      const openSection = await ownerSection(page, c);
      await expect(openSection.getByText(sentence, { exact: true })).toBeVisible();
      await expect(
        openSection.getByRole('button', { name: 'Send the claim link again' })
      ).toBeVisible();
      await expect(openSection.getByRole('button', { name: 'Replace the owner' })).toHaveCount(0);
    }
    const labels = [
      'notifying',
      'waiting-standard',
      'waiting-failed-mail',
      'waiting-unverified',
      'waiting-owner-left',
      'waiting-after-objection',
      'waiting-after-withdrawal',
      'claimable',
    ];
    for (const [index, [c]] of open.entries())
      await audit(page, `host-owner-open-${labels[index]}`, undefined, record(page, c));
  } finally {
    await context.close();
  }
});

test('the host page says why it cannot ask when this host has no mail', async ({ browser }) => {
  const c = await ownedCommunity(host);
  const context = await contextFor(browser, host.operator);
  const page = await context.newPage();
  try {
    // What a host without mail answers; everything else is the real page.
    await page.route('**/api/v1/host/capabilities', (route) =>
      route.fulfill({ json: { mail: false, oidc: false } })
    );
    await page.goto(`${baseUrl}/host`);
    const section = await ownerSection(page, c);
    await expect(section.getByRole('button', { name: 'Replace the owner' })).toBeDisabled();
    await expect(
      section.getByText(
        'This host can’t send email, so it can’t give the owner notice. Set up mail first.'
      )
    ).toBeVisible();
    await audit(page, 'host-owner-no-mail', section, record(page, c));
  } finally {
    await context.close();
  }
});

test('the owner sees only what they can do; admins and members see their own notice', async ({
  browser,
}) => {
  const c = await ownedCommunity(host);
  const adminMember = await member(host, c, 'Ada Admin');
  await promote(host, c, adminMember.memberId);
  const plain = await member(host, c, 'Mia Member');
  // A reference that looks like an address stays text.
  const { replacementId } = await requestReplacement(host, c, { reference: 'www.example.com' });
  const claimableAfter = await toWaiting(host, replacementId);
  const banner = `The host has been asked to make someone else the owner of this community. Unless you keep ownership, that can happen on or after ${day(claimableAfter)}.`;
  const transfer = 'You can hand the community to someone yourself.';
  const remove = 'You can delete the community.';
  const addPassword = 'To hand it to someone or delete it, add a password to your account first.';
  // Held: only deletion would open with a password, so that is all it promises.
  const addPasswordToDelete = 'To delete it, add a password to your account first.';

  const owner = await contextFor(browser, c.owner.cookie);
  const page = await owner.newPage();
  const adminContext = await contextFor(browser, adminMember.cookie);
  const memberContext = await contextFor(browser, plain.cookie);
  try {
    const expectOptions = async (shown: string[], name: string) => {
      await page.goto(`${baseUrl}/c/${c.communityId}`);
      await expect(page.getByText(banner)).toBeVisible();
      await page.getByRole('button', { name: 'What this means' }).click();
      await expect(page.getByText('The host couldn’t reach you.')).toBeVisible();
      const reference = page.getByText('The host’s reference: “www.example.com”');
      await expect(reference).toBeVisible();
      await expect(reference.locator('a')).toHaveCount(0);
      await expect(page.getByRole('link', { name: /example\.com/u })).toHaveCount(0);
      for (const sentence of [transfer, remove, addPassword, addPasswordToDelete])
        await expect(page.getByText(sentence, { exact: true })).toHaveCount(
          shown.includes(sentence) ? 1 : 0
        );
      await audit(page, name, page.getByText(banner));
    };
    await expectOptions([transfer, remove], 'owner-banner-active');
    await moveLifecycle(host, c, 'held');
    await expectOptions([remove], 'owner-banner-held');
    // An owner who signs in only through single sign-on has no password.
    await pool.query(
      `UPDATE account SET password=NULL WHERE "userId"=$1 AND "providerId"='credential'`,
      [c.ownerUserId]
    );
    await expectOptions([addPasswordToDelete], 'owner-banner-no-password');

    const adminPage = await adminContext.newPage();
    await adminPage.goto(`${baseUrl}/c/${c.communityId}`);
    const adminSentence = `The host has been asked to make someone else the owner. The owner has until ${day(claimableAfter)} to respond.`;
    await expect(adminPage.getByText(adminSentence)).toBeVisible();
    await expect(adminPage.getByRole('button', { name: 'Keep ownership' })).toHaveCount(0);
    await audit(adminPage, 'admin-banner', adminPage.getByText(adminSentence));

    const memberPage = await memberContext.newPage();
    await memberPage.goto(`${baseUrl}/c/${c.communityId}`);
    await expect(memberPage.getByRole('heading', { level: 2 }).first()).toBeVisible();
    await expect(memberPage.getByText(/make someone else the owner/u)).toHaveCount(0);

    // The owner keeps ownership in the product, without a password.
    await page.getByRole('button', { name: 'Keep ownership' }).click();
    const confirm = page.getByRole('dialog', { name: `Keep ownership of ${c.name}?` });
    await expect(
      confirm.getByText(
        'The host’s request will end. The host can ask again after 90 days, and you’ll be told again.'
      )
    ).toBeVisible();
    await audit(page, 'owner-keep-confirm', confirm);
    await confirm.getByRole('button', { name: 'Keep ownership' }).click();
    await expect(page.getByText('You kept ownership. The host has been told.')).toBeVisible();
    await expect(page.getByText(banner)).toHaveCount(0);
    expect((await replacementRow(host, replacementId)).state).toBe('objected');
  } finally {
    await owner.close();
    await adminContext.close();
    await memberContext.close();
  }
});

test('the emailed link keeps ownership only when the owner presses the button', async ({
  browser,
}) => {
  const c = await ownedCommunity(host);
  const { replacementId } = await requestReplacement(host, c);
  await toWaiting(host, replacementId);
  const token = await objectToken(host, c, replacementId);
  const context = await contextFor(browser);
  const page = await context.newPage();
  const seen = recordRequests(page);
  const logged = recordConsole(page);
  try {
    await page.goto(`${baseUrl}/keep-ownership#${token}`);
    await expect(page.getByRole('heading', { name: `Keep ownership of ${c.name}?` })).toBeVisible();
    await expect(
      page.getByText(
        'The host’s request will end. The host can ask again after 90 days, and you’ll be told again.'
      )
    ).toBeVisible();
    // Opening the page only checked the link; nothing changed.
    expect(page.url()).toBe(`${baseUrl}/keep-ownership`);
    expect((await replacementRow(host, replacementId)).state).toBe('waiting');
    expect(await page.evaluate(() => typeof window.__readDorkosOwnerReplacementFragment)).toBe(
      'undefined'
    );
    await audit(page, 'keep-ownership-ready', page.getByRole('button', { name: 'Keep ownership' }));

    await page.getByRole('button', { name: 'Keep ownership' }).click();
    await expect(
      page.getByRole('heading', { name: 'You kept ownership. The host has been told.' })
    ).toBeVisible();
    expect((await replacementRow(host, replacementId)).state).toBe('objected');
    await audit(page, 'keep-ownership-kept');

    // The same link, opened again, is used up. A fresh document first: the page strips the
    // fragment, so opening the link from here would only change the hash.
    await page.goto('about:blank');
    await page.goto(`${baseUrl}/keep-ownership#${token}`);
    await expect(page.getByRole('heading', { name: 'This link no longer works.' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Keep ownership' })).toHaveCount(0);
    await audit(page, 'keep-ownership-dead');
    expect(seen.join('\n')).not.toContain(token);
    expect(logged.join('\n')).not.toContain(token);
  } finally {
    await context.close();
  }
});

test('every member is told for a week after a new owner takes over', async ({ browser }) => {
  const c = await ownedCommunity(host);
  const plain = await member(host, c, 'Mia Member');
  const { replacementId, claimToken } = await requestReplacement(host, c);
  await toClaimable(host, replacementId);
  const { cookie } = await preflightClaim(host, claimToken);
  const signedUp = await passwordSignUp(host, cookie, 'Riley Chen');
  expect((await claim(host, signedUp.cookie)).status).toBe(200);
  const completedAt = (await replacementRow(host, replacementId)).ended_at as Date;

  const context = await contextFor(browser, plain.cookie);
  const page = await context.newPage();
  try {
    await page.goto(`${baseUrl}/c/${c.communityId}`);
    const sentence = `The host made Riley Chen the owner of this community on ${day(completedAt)}.`;
    await expect(page.getByText(sentence)).toBeVisible();
    await audit(page, 'member-completion-notice', page.getByText(sentence));
    await page.getByRole('button', { name: 'Dismiss' }).click();
    await expect(page.getByText(sentence)).toHaveCount(0);
    await page.reload();
    await expect(page.getByRole('heading', { level: 2 }).first()).toBeVisible();
    await expect(page.getByText(sentence)).toHaveCount(0);
  } finally {
    await context.close();
  }
});

test('the claim link says when it opens, then lets the new owner take ownership', async ({
  browser,
}) => {
  const c = await ownedCommunity(host);
  const { replacementId, claimToken } = await requestReplacement(host, c);
  const claimableAfter = await toWaiting(host, replacementId);
  const context = await contextFor(browser);
  const page = await context.newPage();
  const seen = recordRequests(page);
  const logged = recordConsole(page);
  try {
    await page.goto(`${baseUrl}/owner-replacement#${claimToken}`);
    await expect(
      page.getByText(
        `You can take ownership of ${c.name} on or after ${day(claimableAfter)}. Keep this link.`
      )
    ).toBeVisible();
    expect(page.url()).toBe(`${baseUrl}/owner-replacement`);
    await expect(page.getByRole('button', { name: /Take ownership|Create account/u })).toHaveCount(
      0
    );
    await audit(page, 'claim-before-date');

    // The server's clock passes the date and its timeline opens the claim.
    clock.ms = claimableAfter.getTime() + MINUTE;
    await tick(host);
    expect((await replacementRow(host, replacementId)).state).toBe('claimable');

    await page.goto('about:blank');
    await page.goto(`${baseUrl}/owner-replacement#${claimToken}`);
    await expect(
      page.getByText('Sign in, or create an account on this host, to take ownership.')
    ).toBeVisible();
    await audit(page, 'claim-account');
    await page.getByLabel('Your name').fill('Noor New');
    await page.getByLabel('Email').fill('noor@new-owner.test');
    await page.getByLabel('Password').fill(TENANCY_PASSWORD);
    await page.getByRole('button', { name: 'Create account and continue' }).click();
    await page.getByRole('button', { name: 'Take ownership' }).click();
    const confirm = page.getByRole('dialog', { name: `Take ownership of ${c.name}?` });
    await expect(
      confirm.getByText(`You’ll become the owner of ${c.name}. The current owner stays a member.`)
    ).toBeVisible();
    await audit(page, 'claim-confirm', confirm);
    await confirm.getByRole('button', { name: 'Take ownership' }).click();
    await page.waitForURL(`${baseUrl}/c/${c.communityId}/settings`);
    const owner = await pool.query<{ email: string }>(
      `SELECT u.email FROM members m JOIN "user" u ON u.id=m.user_id
       WHERE m.community_id=$1 AND m.role='owner' AND m.active`,
      [c.communityId]
    );
    expect(owner.rows).toEqual([{ email: 'noor@new-owner.test' }]);
    expect((await replacementRow(host, replacementId)).state).toBe('completed');
    await audit(page, 'claim-settings');

    // The used link is unavailable now.
    await page.goto('about:blank');
    await page.goto(`${baseUrl}/owner-replacement#${claimToken}`);
    await expect(
      page.getByRole('heading', { name: 'This ownership claim is unavailable.' })
    ).toBeVisible();
    await audit(page, 'claim-unavailable');
    expect(seen.join('\n')).not.toContain(claimToken);
    expect(logged.join('\n')).not.toContain(claimToken);
  } finally {
    await context.close();
  }
});
