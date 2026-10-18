import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { serve } from '@hono/node-server';
import { hashPassword } from 'better-auth/crypto';
import { migrate } from '../migrate.js';
import { createCommunityApp } from '../app.js';
import { parseConfig, type CommunityConfig } from '../config.js';
import { banEmailKey, normaliseBanEmail } from '../moderation/bans.js';
import { eraseMembership } from '../erasure/erasure.js';
import { bootstrapFirstHost } from './bootstrap-test-helper.js';
import { startFakeIssuer, type FakeIssuer } from './fake-oidc-issuer.js';

// DOR-2764 (specs/official-community-space D1, D3, D6): open admission through the host's single
// sign-on, auto-join channels, and bans, over real HTTP and Postgres against a fake issuer.
const adminUrl = process.env.COMMUNITY_TEST_DATABASE_URL;
if (!adminUrl) throw new Error('COMMUNITY_TEST_DATABASE_URL is required for open admission tests');
const admin = new Pool({ connectionString: adminUrl });
const dbName = `community_open_${randomUUID().replaceAll('-', '')}`;
const dbUrl = new URL(adminUrl);
dbUrl.pathname = `/${dbName}`;
const PUBLIC_URL = 'http://localhost:6481';
let issuer: FakeIssuer;
let pool: Pool;
let config: CommunityConfig;
let baseUrl: string;
const servers: ReturnType<typeof serve>[] = [];
let ownerCookie: string;
let ownerId: string;
let communityId: string;
let welcomeId: string;
let helpId: string;
let randomId: string;

function cookieOf(response: Response) {
  return response.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .join('; ');
}

/** Merge cookie headers, a later value replacing an earlier one of the same name. */
function cookies(...headers: string[]) {
  const jar = new Map<string, string>();
  for (const header of headers)
    for (const part of header.split('; ').filter(Boolean)) jar.set(part.split('=')[0], part);
  return [...jar.values()].join('; ');
}

function call(path: string, method: string, body?: unknown, cookie = '', url = baseUrl) {
  return fetch(`${url}${path}`, {
    method,
    redirect: 'manual',
    headers: {
      origin: PUBLIC_URL,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(cookie ? { cookie } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function start(overrides: Partial<CommunityConfig> = {}) {
  const app = createCommunityApp({ config: { ...config, ...overrides }, pool });
  const server = serve({ fetch: app.fetch, port: 0 });
  await new Promise<void>((resolve) => server.once('listening', resolve));
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing HTTP address');
  return `http://localhost:${address.port}`;
}

/** Drive one single sign-on round trip the way a browser would; see oidc.integration.test.ts. */
async function oidcSignIn(cookie = '') {
  const begin = await call(
    '/api/auth/sign-in/social',
    'POST',
    { provider: 'oidc', callbackURL: '/signed-in', errorCallbackURL: '/sign-in-failed' },
    cookie
  );
  expect(begin.status).toBe(200);
  const { url } = (await begin.json()) as { url: string };
  const authorize = await fetch(url, { redirect: 'manual' });
  const back = new URL(authorize.headers.get('location')!);
  const held = cookies(cookie, cookieOf(begin));
  const callback = await call(`${back.pathname}${back.search}`, 'GET', undefined, held);
  expect(callback.status).toBe(302);
  return {
    location: new URL(callback.headers.get('location')!, PUBLIC_URL),
    cookie: cookies(held, cookieOf(callback)),
  };
}

/** Ask to join the open space, then sign up or in through single sign-on as `who`. */
async function arrive(who: { sub: string; email: string; name?: string; verified?: boolean }) {
  issuer.identity = {
    sub: who.sub,
    email: who.email,
    email_verified: who.verified ?? true,
    name: who.name ?? who.sub,
  };
  const preflight = await call('/api/v1/open-admission/preflight', 'POST', {});
  expect(preflight.status).toBe(200);
  return oidcSignIn(cookieOf(preflight));
}

async function join(cookie: string, url = baseUrl) {
  return call('/api/v1/open-admission/join', 'POST', {}, cookie, url);
}

async function waitForBlocked(fragment: string) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const result = await pool.query<{ blocked: boolean }>(
      `SELECT EXISTS(SELECT 1 FROM pg_stat_activity
       WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE $1) AS blocked`,
      [`%${fragment}%`]
    );
    if (result.rows[0].blocked) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Request did not block on ${fragment}`);
}

async function userIdFor(email: string) {
  const { rows } = await pool.query<{ id: string }>(
    'SELECT id FROM "user" WHERE lower(email)=lower($1)',
    [email]
  );
  return rows[0]?.id ?? null;
}

async function channelsOf(memberId: string) {
  const { rows } = await pool.query<{ channel_id: string }>(
    'SELECT channel_id FROM channel_members WHERE member_id=$1 ORDER BY channel_id',
    [memberId]
  );
  return rows.map((row) => row.channel_id);
}

async function createChannel(body: Record<string, unknown>) {
  const created = await call('/api/v1/channels', 'POST', body, ownerCookie);
  expect(created.status).toBe(201);
  return ((await created.json()) as { channel: { id: string } }).channel.id;
}

async function setPolicy(policy: 'open' | 'invite_only' | 'closed') {
  const current = await call('/api/v1/settings', 'GET', undefined, ownerCookie);
  const { settingsVersion } = (await current.json()) as { settingsVersion: number };
  const response = await fetch(`${baseUrl}/api/v1/settings`, {
    method: 'PATCH',
    headers: {
      origin: PUBLIC_URL,
      cookie: ownerCookie,
      'content-type': 'application/json',
      'if-match': `"${settingsVersion}"`,
    },
    body: JSON.stringify({ admissionPolicy: policy }),
  });
  return response;
}

/** A password account made outside any admission, as a host's other spaces would leave one. */
async function passwordAccount(email: string, name = 'Password person') {
  const userId = randomUUID();
  await pool.query(`INSERT INTO "user"(id,name,email,"emailVerified") VALUES($1,$2,$3,true)`, [
    userId,
    name,
    email,
  ]);
  await pool.query(
    `INSERT INTO account(id,"accountId","providerId","userId",password)
     VALUES($1,$2,'credential',$2,$3)`,
    [randomUUID(), userId, await hashPassword('password1234')]
  );
  const signedIn = await call('/api/auth/sign-in/email', 'POST', {
    email,
    password: 'password1234',
  });
  expect(signedIn.status).toBe(200);
  return { userId, cookie: cookieOf(signedIn) };
}

async function invitePreflight() {
  const issued = await call('/api/v1/invites', 'POST', { seats: 5 }, ownerCookie);
  expect(issued.status).toBe(201);
  const { token } = (await issued.json()) as { token: string };
  return token;
}

beforeAll(async () => {
  issuer = await startFakeIssuer();
  await admin.query(`CREATE DATABASE ${dbName}`);
  await migrate(dbUrl.toString());
  pool = new Pool({ connectionString: dbUrl.toString() });
  config = parseConfig({
    COMMUNITY_DATABASE_URL: dbUrl.toString(),
    COMMUNITY_AUTH_SECRET: 'a'.repeat(32),
    COMMUNITY_INVITE_SECRET: 'b'.repeat(32),
    COMMUNITY_BOOTSTRAP_SECRET: 'c'.repeat(32),
    COMMUNITY_PUBLIC_URL: PUBLIC_URL,
    COMMUNITY_STORAGE_PATH: '/tmp/community-open-admission-test-blobs',
    COMMUNITY_INVITE_PREVIEW_ATTEMPTS_PER_MINUTE: 100,
    COMMUNITY_SIGNUP_ATTEMPTS_PER_MINUTE: 100,
    COMMUNITY_OPEN_JOINS_PER_MINUTE: 100,
    COMMUNITY_OPEN_JOINS_PER_HOST_PER_MINUTE: 10_000,
    COMMUNITY_OIDC_ISSUER_URL: issuer.issuer,
    COMMUNITY_OIDC_CLIENT_ID: issuer.clientId,
    COMMUNITY_OIDC_CLIENT_SECRET: issuer.clientSecret,
    COMMUNITY_OIDC_LABEL: 'Example sign-in',
  });
  baseUrl = await start();
  const setup = await bootstrapFirstHost((path, body, cookie) => call(path, 'POST', body, cookie), {
    secret: config.bootstrapSecret,
    accountName: 'Owner',
    email: 'owner@example.com',
    password: 'password1234',
    communityName: 'Open test',
    channelName: 'General',
  });
  ownerCookie = setup.cookie;
  ownerId = setup.memberId;
  communityId = setup.communityId;
  welcomeId = await createChannel({ name: 'welcome', autoJoin: true });
  helpId = await createChannel({ name: 'help' });
  const patched = await call(
    `/api/v1/channels/${helpId}`,
    'PATCH',
    { autoJoin: true },
    ownerCookie
  );
  expect(patched.status).toBe(200);
  randomId = await createChannel({ name: 'random' });
});

afterAll(async () => {
  for (const server of servers) await new Promise<void>((resolve) => server.close(() => resolve()));
  await issuer?.close();
  await pool?.end();
  await admin.query(`DROP DATABASE IF EXISTS ${dbName}`);
  await admin.end();
});

describe('auto-join channels', () => {
  it('marks only public channels, and shows the list to owners and admins only', async () => {
    // Purpose: fails if a private channel can be joined on arrival (strangers would read it), or
    // if the auto-join list is missing a channel the owner marked.
    const refused = await call(
      '/api/v1/channels',
      'POST',
      { name: 'staff', visibility: 'private', autoJoin: true },
      ownerCookie
    );
    expect(refused.status).toBe(409);
    const list = await call('/api/v1/channels/auto-join', 'GET', undefined, ownerCookie);
    expect(list.status).toBe(200);
    expect(((await list.json()) as { channelIds: string[] }).channelIds.sort()).toEqual(
      [welcomeId, helpId].sort()
    );
    // The shared channel projection older installations read is unchanged.
    const channel = await call(`/api/v1/channels/${welcomeId}`, 'GET', undefined, ownerCookie);
    expect(Object.keys(((await channel.json()) as { channel: object }).channel)).not.toContain(
      'autoJoin'
    );
  });
});

describe('open admission', () => {
  it('says an invite-only space is not open, and refuses to open a space without single sign-on', async () => {
    // Purpose: fails if the join page offers open joining before the owner chose it, or if a
    // host with no single sign-on can be set to a policy that admits nobody.
    const before = await call('/api/v1/open-admission', 'GET');
    expect(await before.json()).toEqual({ open: false, communityName: 'Open test' });
    expect((await call('/api/v1/open-admission/preflight', 'POST', {})).status).toBe(409);
    const noSso = await start({ oidc: null });
    const current = await call('/api/v1/settings', 'GET', undefined, ownerCookie, noSso);
    const { settingsVersion } = (await current.json()) as { settingsVersion: number };
    const refused = await fetch(`${noSso}/api/v1/settings`, {
      method: 'PATCH',
      headers: {
        origin: PUBLIC_URL,
        cookie: ownerCookie,
        'content-type': 'application/json',
        'if-match': `"${settingsVersion}"`,
      },
      body: JSON.stringify({ admissionPolicy: 'open' }),
    });
    expect(refused.status).toBe(409);
    expect((await setPolicy('open')).status).toBe(200);
    const after = await call('/api/v1/open-admission', 'GET');
    expect(await after.json()).toEqual({ open: true, communityName: 'Open test' });
  });

  it('never turns the sign-up gate into public password sign-up', async () => {
    // Purpose: fails if the open-admission cookie admits a password sign-up, or if a single
    // sign-on sign-up without it (no click on the space's page) creates an account.
    const preflight = await call('/api/v1/open-admission/preflight', 'POST', {});
    const password = await call(
      '/api/auth/sign-up/email',
      'POST',
      { name: 'Pw', email: 'password-signup@example.com', password: 'password1234' },
      cookieOf(preflight)
    );
    expect(password.status).toBe(403);
    expect(await userIdFor('password-signup@example.com')).toBeNull();
    issuer.identity = {
      sub: 'no-click',
      email: 'no-click@example.com',
      email_verified: true,
      name: 'No click',
    };
    const silent = await oidcSignIn();
    expect(silent.location.searchParams.get('error')).toBe('invitation_required');
    expect(await userIdFor('no-click@example.com')).toBeNull();
  });

  it('admits a verified single sign-on account once it asks, into every auto-join channel', async () => {
    // Purpose: fails if open join skips the cap, the handle, the audit, or the auto-join channels,
    // or if it puts the person in a channel nobody marked.
    const arrived = await arrive({ sub: 'sam', email: 'Sam.Smith+space@gmail.com', name: 'Sam' });
    expect(arrived.location.pathname).toBe('/signed-in');
    // The account it made spent the open-admission cookie: one click, one account.
    expect(arrived.cookie.split('; ')).toContain('community_open_admission=');
    const joined = await join(arrived.cookie);
    expect(joined.status).toBe(200);
    const { memberId } = (await joined.json()) as { memberId: string };
    expect(await channelsOf(memberId)).toEqual([welcomeId, helpId].sort());
    expect(await channelsOf(memberId)).not.toContain(randomId);
    const audit = await pool.query(
      `SELECT actor_member_id,subject_id,next_state FROM audit_events
       WHERE action='member.admit' AND actor_member_id=$1`,
      [memberId]
    );
    expect(audit.rows).toEqual([
      { actor_member_id: memberId, subject_id: memberId, next_state: 'open' },
    ]);
    // Joining again changes nothing and keeps the channels the person chose.
    await call(`/api/v1/channels/${welcomeId}/leave`, 'POST', {}, arrived.cookie);
    const again = await join(arrived.cookie);
    expect(again.status).toBe(200);
    expect(await channelsOf(memberId)).toEqual([helpId]);
  });

  it('refuses an issuer identity with an unverified email, and an account whose email is unconfirmed', async () => {
    // Purpose: fails if open admission accepts an email nobody proved belongs to the person.
    const unverified = await arrive({
      sub: 'unverified',
      email: 'unverified@example.com',
      verified: false,
    });
    expect(unverified.location.pathname).toBe('/sign-in-failed');
    expect(await userIdFor('unverified@example.com')).toBeNull();

    const later = await arrive({ sub: 'later', email: 'later@example.com' });
    await pool.query(`UPDATE "user" SET "emailVerified"=false WHERE email='later@example.com'`);
    const refused = await join(later.cookie);
    expect(refused.status).toBe(403);
  });

  it('refuses an account that does not sign in through the single sign-on', async () => {
    // Purpose: fails if a password account (from anywhere on the host) can join an open space.
    const { cookie } = await passwordAccount('password-only@example.com');
    const refused = await join(cookie);
    expect(refused.status).toBe(403);
    expect(((await refused.json()) as { message: string }).message).toBe(
      'Sign in with Example sign-in to join this space.'
    );
  });

  it('holds open joins to the member limit', async () => {
    // Purpose: fails if open admission can take a space past its host-set member limit.
    const arrived = await arrive({ sub: 'capped', email: 'capped@example.com' });
    const { rows } = await pool.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM members WHERE community_id=$1 AND active',
      [communityId]
    );
    await pool.query(
      'INSERT INTO community_limits(community_id,max_active_members) VALUES($1,$2)',
      [communityId, rows[0].n]
    );
    try {
      const refused = await join(arrived.cookie);
      expect(refused.status).toBe(409);
      expect(((await refused.json()) as { code: string }).code).toBe('MEMBER_LIMIT_REACHED');
    } finally {
      await pool.query('DELETE FROM community_limits WHERE community_id=$1', [communityId]);
    }
    expect((await join(arrived.cookie)).status).toBe(200);
  });

  it('stops every open join while the host switch is off', async () => {
    // Purpose: fails if COMMUNITY_OPEN_ADMISSION=0 leaves any way to join an open space open.
    const off = parseConfig({
      COMMUNITY_DATABASE_URL: dbUrl.toString(),
      COMMUNITY_AUTH_SECRET: 'a'.repeat(32),
      COMMUNITY_INVITE_SECRET: 'b'.repeat(32),
      COMMUNITY_BOOTSTRAP_SECRET: 'c'.repeat(32),
      COMMUNITY_PUBLIC_URL: PUBLIC_URL,
      COMMUNITY_STORAGE_PATH: '/tmp/community-open-admission-test-blobs',
      COMMUNITY_OPEN_ADMISSION: '0',
    });
    expect(off.openAdmission).toBe(false);
    const arrived = await arrive({ sub: 'switched-off', email: 'switched-off@example.com' });
    const url = await start({ openAdmission: false });
    expect(await (await call('/api/v1/open-admission', 'GET', undefined, '', url)).json()).toEqual({
      open: false,
      communityName: 'Open test',
    });
    expect((await call('/api/v1/open-admission/preflight', 'POST', {}, '', url)).status).toBe(409);
    expect((await join(arrived.cookie, url)).status).toBe(409);
  });

  it('limits open joins per caller and per host', async () => {
    // Purpose: fails if either limit is missing: one address, or many, could flood the host.
    const arrived = await arrive({ sub: 'limited', email: 'limited@example.com' });
    const perCaller = await start({
      limits: { ...config.limits, openJoinsPerMinute: 1, openJoinsPerHostPerMinute: 100 },
    });
    expect((await join(arrived.cookie, perCaller)).status).toBe(200);
    expect((await join(arrived.cookie, perCaller)).status).toBe(429);
    const perHost = await start({
      limits: { ...config.limits, openJoinsPerMinute: 100, openJoinsPerHostPerMinute: 1 },
    });
    // A preflight needs no account, so it never spends the host's budget.
    for (let attempt = 0; attempt < 3; attempt++)
      expect((await call('/api/v1/open-admission/preflight', 'POST', {}, '', perHost)).status).toBe(
        200
      );
    expect((await join(arrived.cookie, perHost)).status).toBe(200);
    const refused = await join(arrived.cookie, perHost);
    expect(refused.status).toBe(429);
    expect(refused.headers.get('retry-after')).not.toBeNull();
  });
});

describe('bans', () => {
  it('keys the email after normalising it, never as a plain hash', () => {
    // Purpose: fails if Gmail dots, a +tag or case let the same mailbox past a ban, or if the
    // stored key is an unkeyed hash a guess could confirm.
    expect(normaliseBanEmail(' Sam.Smith+space@GoogleMail.com ')).toBe('samsmith@gmail.com');
    expect(normaliseBanEmail('first.last+x@example.com')).toBe('first.last@example.com');
    const key = banEmailKey('Sam.Smith+space@gmail.com', 'a'.repeat(32));
    expect(key).toBe(banEmailKey('samsmith@googlemail.com', 'a'.repeat(32)));
    expect(key).not.toBe(banEmailKey('samsmith@gmail.com', 'b'.repeat(32)));
    expect(key).toMatch(/^[a-f0-9]{64}$/);
  });

  it('removes the member, then refuses every way back in for the account and its email', async () => {
    // Purpose: fails if a ban leaves the membership, its credentials or its channels in place,
    // or if any admission path (open join, invitation preflight, redeem, a new account on the
    // same mailbox) lets the person back in, or if a ban shows the email.
    const sam = await arrive({ sub: 'sam', email: 'Sam.Smith+space@gmail.com', name: 'Sam' });
    const member = await pool.query<{ id: string }>(
      'SELECT id FROM members WHERE community_id=$1 AND user_id=$2',
      [communityId, await userIdFor('Sam.Smith+space@gmail.com')]
    );
    const samId = member.rows[0].id;
    const banned = await call(
      `/api/v1/members/${samId}/ban`,
      'POST',
      { reason: 'Spam in #welcome' },
      ownerCookie
    );
    expect(banned.status).toBe(201);
    const { ban } = (await banned.json()) as { ban: Record<string, unknown> };
    expect(ban).toMatchObject({ memberId: samId, displayName: 'Sam', reason: 'Spam in #welcome' });
    expect(JSON.stringify(ban)).not.toContain('gmail');
    const stored = await pool.query<{ email_hash: string }>(
      'SELECT email_hash FROM bans WHERE id=$1',
      [ban.id]
    );
    expect(stored.rows[0].email_hash).toBe(banEmailKey('samsmith@gmail.com', config.authSecret));
    expect(await channelsOf(samId)).toEqual([]);
    expect((await call('/api/v1/me', 'GET', undefined, sam.cookie)).status).toBe(403);
    const audit = await pool.query(
      "SELECT 1 FROM audit_events WHERE action='member.ban' AND subject_id=$1",
      [samId]
    );
    expect(audit.rowCount).toBe(1);
    // Banning again finds the standing ban and makes no second one.
    const twice = await call(`/api/v1/members/${samId}/ban`, 'POST', {}, ownerCookie);
    expect(twice.status).toBe(200);

    // Open join.
    const reopen = await join(sam.cookie);
    expect(reopen.status).toBe(403);
    expect(((await reopen.json()) as { message: string }).message).toBe(
      "You can't join this space."
    );
    // An invitation, previewed and redeemed while signed in as the banned account.
    const token = await invitePreflight();
    expect((await call('/api/v1/invites/preflight', 'POST', { token }, sam.cookie)).status).toBe(
      403
    );
    const fresh = await call('/api/v1/invites/preflight', 'POST', { token });
    expect(fresh.status).toBe(200);
    const withInvite = cookies(sam.cookie, cookieOf(fresh));
    expect((await call('/api/v1/invites/bind', 'POST', {}, withInvite)).status).toBe(200);
    expect((await call('/api/v1/invites/redeem', 'POST', {}, withInvite)).status).toBe(403);
    // A new single sign-on account on the same mailbox, written another way.
    const twin = await arrive({ sub: 'sam-twin', email: 'samsmith@googlemail.com', name: 'Sam' });
    expect(twin.location.searchParams.get('error')).toBe('admission_refused');
    expect(await userIdFor('samsmith@googlemail.com')).toBeNull();
    // A password sign-up only types an email, so the email ban does not meet it until the
    // address is confirmed: anyone could type someone else's. The account is checked instead.
    const inviteForTwin = await call('/api/v1/invites/preflight', 'POST', {
      token: await invitePreflight(),
    });
    const passwordTwin = await call(
      '/api/auth/sign-up/email',
      'POST',
      { name: 'Sam', email: 'SAM.smith+other@gmail.com', password: 'password1234' },
      cookieOf(inviteForTwin)
    );
    expect(passwordTwin.status).toBe(200);
    // Confirmed, the same mailbox is refused at redeem.
    await pool.query(
      `UPDATE "user" SET "emailVerified"=true WHERE lower(email)='sam.smith+other@gmail.com'`
    );
    const twinCookie = cookies(cookieOf(inviteForTwin), cookieOf(passwordTwin));
    expect((await call('/api/v1/invites/bind', 'POST', {}, twinCookie)).status).toBe(200);
    expect((await call('/api/v1/invites/redeem', 'POST', {}, twinCookie)).status).toBe(403);
    // Approving a pairing needs a membership the ban ended.
    expect(
      (await call('/api/v1/pairings/approve', 'POST', { pairingId: randomUUID() }, sam.cookie))
        .status
    ).toBe(403);
    // A different mailbox still gets in: a ban is a speed bump, not a wall.
    const other = await arrive({ sub: 'sam-new', email: 'sam.new@example.com', name: 'Sam' });
    expect((await join(other.cookie)).status).toBe(200);

    const list = await call('/api/v1/bans', 'GET', undefined, ownerCookie);
    expect(list.status).toBe(200);
    const { bans } = (await list.json()) as { bans: { id: string }[] };
    expect(bans.map((row) => row.id)).toEqual([ban.id]);

    // Lifting the ban lets the person come back the usual way.
    expect(
      (await call(`/api/v1/bans/${String(ban.id)}`, 'DELETE', undefined, ownerCookie)).status
    ).toBe(204);
    expect((await join(sam.cookie)).status).toBe(200);
    const lifted = await pool.query(
      "SELECT 1 FROM audit_events WHERE action='member.unban' AND subject_id=$1",
      [samId]
    );
    expect(lifted.rowCount).toBe(1);
  });

  it('lets an admin ban members but not another admin or the owner', async () => {
    // Purpose: fails if an admin can ban a peer admin or the owner, or if a member can ban.
    const ada = await arrive({ sub: 'ada', email: 'ada@example.com', name: 'Ada' });
    const adaId = ((await (await join(ada.cookie)).json()) as { memberId: string }).memberId;
    const bea = await arrive({ sub: 'bea', email: 'bea@example.com', name: 'Bea' });
    const beaId = ((await (await join(bea.cookie)).json()) as { memberId: string }).memberId;
    const cy = await arrive({ sub: 'cy', email: 'cy@example.com', name: 'Cy' });
    const cyId = ((await (await join(cy.cookie)).json()) as { memberId: string }).memberId;
    expect((await call(`/api/v1/members/${cyId}/ban`, 'POST', {}, ada.cookie)).status).toBe(403);
    for (const id of [adaId, beaId])
      expect(
        (await call(`/api/v1/members/${id}/role`, 'PATCH', { role: 'admin' }, ownerCookie)).status
      ).toBe(200);
    expect((await call(`/api/v1/members/${beaId}/ban`, 'POST', {}, ada.cookie)).status).toBe(403);
    expect((await call(`/api/v1/members/${ownerId}/ban`, 'POST', {}, ada.cookie)).status).toBe(403);
    expect((await call(`/api/v1/members/${adaId}/ban`, 'POST', {}, ada.cookie)).status).toBe(409);
    expect((await call(`/api/v1/members/${cyId}/ban`, 'POST', {}, ada.cookie)).status).toBe(201);
    // The owner can ban an admin.
    expect((await call(`/api/v1/members/${beaId}/ban`, 'POST', {}, ownerCookie)).status).toBe(201);
    expect((await call('/api/v1/bans', 'GET', undefined, cy.cookie)).status).toBe(403);
  });

  it('keeps a ban through erasure of the banned membership, without the account or the reason', async () => {
    // Purpose: fails if erasing a banned membership leaves the moderator's words or the account
    // on the ban, or drops the keyed email so erasing becomes a way back in.
    const dee = await arrive({ sub: 'dee', email: 'dee@example.com', name: 'Dee' });
    const deeId = ((await (await join(dee.cookie)).json()) as { memberId: string }).memberId;
    expect(
      (await call(`/api/v1/members/${deeId}/ban`, 'POST', { reason: 'Abuse' }, ownerCookie)).status
    ).toBe(201);
    expect(await eraseMembership(pool, communityId, deeId, { log: () => {} })).toBe('erased');
    const row = await pool.query('SELECT user_id,reason,email_hash FROM bans WHERE member_id=$1', [
      deeId,
    ]);
    expect(row.rows).toEqual([
      {
        user_id: null,
        reason: null,
        email_hash: banEmailKey('dee@example.com', config.authSecret),
      },
    ]);
  });
  it('keys no email the account never confirmed, and bans the account alone', async () => {
    // Purpose: fails if an unconfirmed address (anyone's to type) is keyed into a ban.
    const { userId } = await passwordAccount('typed@example.com', 'Typed');
    await pool.query(`UPDATE "user" SET "emailVerified"=false WHERE id=$1`, [userId]);
    const member = await pool.query<{ id: string }>(
      `INSERT INTO members(community_id,user_id,display_name,handle,role)
       VALUES($1,$2,'Typed','typed','member') RETURNING id`,
      [communityId, userId]
    );
    const banned = await call(`/api/v1/members/${member.rows[0].id}/ban`, 'POST', {}, ownerCookie);
    expect(banned.status).toBe(201);
    const row = await pool.query('SELECT user_id,email_hash FROM bans WHERE member_id=$1', [
      member.rows[0].id,
    ]);
    expect(row.rows).toEqual([{ user_id: userId, email_hash: null }]);
  });

  it('checks an unconfirmed email by account only, so a typed address bans nobody', async () => {
    // Purpose: fails if an address someone merely typed (never confirmed) meets an email ban at
    // redeem: anyone could otherwise lock a person out by typing their address.
    const ivy = await arrive({ sub: 'ivy', email: 'ivy@example.com', name: 'Ivy' });
    const ivyId = ((await (await join(ivy.cookie)).json()) as { memberId: string }).memberId;
    expect((await call(`/api/v1/members/${ivyId}/ban`, 'POST', {}, ownerCookie)).status).toBe(201);
    const typed = await passwordAccount('ivy+typed@example.com', 'Not Ivy');
    await pool.query(`UPDATE "user" SET "emailVerified"=false WHERE id=$1`, [typed.userId]);
    const preflight = await call('/api/v1/invites/preflight', 'POST', {
      token: await invitePreflight(),
    });
    const cookie = cookies(typed.cookie, cookieOf(preflight));
    expect((await call('/api/v1/invites/bind', 'POST', {}, cookie)).status).toBe(200);
    expect((await call('/api/v1/invites/redeem', 'POST', {}, cookie)).status).toBe(200);
  });

  it('lets only the owner lift a ban on an admin', async () => {
    // Purpose: fails if an admin can undo the owner's ban of another admin.
    const eve = await arrive({ sub: 'eve', email: 'eve@example.com', name: 'Eve' });
    const eveId = ((await (await join(eve.cookie)).json()) as { memberId: string }).memberId;
    const fay = await arrive({ sub: 'fay', email: 'fay@example.com', name: 'Fay' });
    const fayId = ((await (await join(fay.cookie)).json()) as { memberId: string }).memberId;
    for (const id of [eveId, fayId])
      expect(
        (await call(`/api/v1/members/${id}/role`, 'PATCH', { role: 'admin' }, ownerCookie)).status
      ).toBe(200);
    const ban = await call(`/api/v1/members/${eveId}/ban`, 'POST', {}, ownerCookie);
    const banId = ((await ban.json()) as { ban: { id: string } }).ban.id;
    expect((await call(`/api/v1/bans/${banId}`, 'DELETE', undefined, fay.cookie)).status).toBe(403);
    expect((await call(`/api/v1/bans/${banId}`, 'DELETE', undefined, ownerCookie)).status).toBe(
      204
    );
  });

  it('never lets a ban and a join that overlap leave the banned person in', async () => {
    // Purpose: fails if a ban can commit between a join's ban check and its membership write,
    // which would leave a banned person active (MAJOR from review). The join is held just
    // before its membership write; the ban is fired; then the join is let go.
    const gus = await arrive({ sub: 'gus', email: 'gus@example.com', name: 'Gus' });
    const gusId = ((await (await join(gus.cookie)).json()) as { memberId: string }).memberId;
    expect((await call(`/api/v1/members/${gusId}`, 'DELETE', undefined, ownerCookie)).status).toBe(
      204
    );
    // A member limit row makes the join take its lock right before the membership write.
    await pool.query(
      'INSERT INTO community_limits(community_id,max_active_members) VALUES($1,1000000)',
      [communityId]
    );
    const holder = await pool.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT 1 FROM community_limits WHERE community_id=$1 FOR UPDATE', [
        communityId,
      ]);
      const joining = join(gus.cookie);
      await waitForBlocked('community_limits');
      const banning = call(`/api/v1/members/${gusId}/ban`, 'POST', {}, ownerCookie);
      // Give the ban every chance to commit first, as it would without the community lock.
      await new Promise((resolve) => setTimeout(resolve, 300));
      await holder.query('COMMIT');
      await Promise.all([joining, banning]);
    } finally {
      holder.release();
      await pool.query('DELETE FROM community_limits WHERE community_id=$1', [communityId]);
    }
    const state = await pool.query<{ active: boolean }>('SELECT active FROM members WHERE id=$1', [
      gusId,
    ]);
    expect(state.rows[0].active).toBe(false);
    const standing = await pool.query(
      'SELECT 1 FROM bans WHERE member_id=$1 AND lifted_at IS NULL',
      [gusId]
    );
    expect(standing.rowCount).toBe(1);
  });
});
