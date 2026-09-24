import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { serve } from '@hono/node-server';
import { migrate } from '../migrate.js';
import { createCommunityApp } from '../app.js';
import { parseConfig } from '../config.js';
import { bootstrapFirstHost } from './bootstrap-test-helper.js';
import { startFakeIssuer, type FakeIssuer } from './fake-oidc-issuer.js';

// Task 6.2 of specs/community-host-operator-api: the host's optional OpenID Connect sign-in,
// against an in-process fake issuer over real HTTP and Postgres. No test reaches a real provider.
const adminUrl = process.env.COMMUNITY_TEST_DATABASE_URL;
if (!adminUrl) throw new Error('COMMUNITY_TEST_DATABASE_URL is required for OIDC tests');
const admin = new Pool({ connectionString: adminUrl });
const dbName = `community_oidc_${randomUUID().replaceAll('-', '')}`;
const dbUrl = new URL(adminUrl);
dbUrl.pathname = `/${dbName}`;
const PUBLIC_URL = 'http://localhost:6481';
const baseEnv = {
  COMMUNITY_DATABASE_URL: dbUrl.toString(),
  COMMUNITY_AUTH_SECRET: 'a'.repeat(32),
  COMMUNITY_INVITE_SECRET: 'b'.repeat(32),
  COMMUNITY_BOOTSTRAP_SECRET: 'c'.repeat(32),
  COMMUNITY_PUBLIC_URL: PUBLIC_URL,
  COMMUNITY_STORAGE_PATH: '/tmp/community-oidc-test-blobs',
  COMMUNITY_INVITE_PREVIEW_ATTEMPTS_PER_MINUTE: 100,
  COMMUNITY_SIGNUP_ATTEMPTS_PER_MINUTE: 100,
};
let issuer: FakeIssuer;
let pool: Pool;
let server: ReturnType<typeof serve>;
let baseUrl: string;
let ownerCookie: string;

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

/**
 * Drive one OIDC sign-in the way a browser would: start it, let the fake issuer authorize, then
 * return to the Community's callback with the cookies the start set. Returns where the callback
 * redirected and the cookies a browser would then hold.
 */
async function oidcSignIn(cookie = '') {
  const start = await call(
    '/api/auth/sign-in/social',
    'POST',
    { provider: 'oidc', callbackURL: '/signed-in', errorCallbackURL: '/sign-in-failed' },
    cookie
  );
  expect(start.status).toBe(200);
  const { url } = (await start.json()) as { url: string };
  const authorize = await fetch(url, { redirect: 'manual' });
  expect(authorize.status).toBe(302);
  const back = new URL(authorize.headers.get('location')!);
  // Better Auth builds the redirect URI from COMMUNITY_PUBLIC_URL; this server listens elsewhere.
  expect(`${back.origin}${back.pathname}`).toBe(`${PUBLIC_URL}/api/auth/callback/oidc`);
  const held = cookies(cookie, cookieOf(start));
  const callback = await call(`${back.pathname}${back.search}`, 'GET', undefined, held);
  expect(callback.status).toBe(302);
  return {
    location: new URL(callback.headers.get('location')!, PUBLIC_URL),
    cookie: cookies(held, cookieOf(callback)),
  };
}

/** Issue a one-seat invitation and return the cookie its preflight grants. */
async function invitation() {
  const issued = await call('/api/v1/invites', 'POST', { seats: 1 }, ownerCookie);
  expect(issued.status).toBe(201);
  const { token } = (await issued.json()) as { token: string };
  const preflight = await call('/api/v1/invites/preflight', 'POST', { token });
  expect(preflight.status).toBe(200);
  return cookieOf(preflight);
}

async function userIdFor(email: string) {
  const { rows } = await pool.query<{ id: string }>('SELECT id FROM "user" WHERE email=$1', [
    email,
  ]);
  return rows[0]?.id ?? null;
}

async function providersOf(email: string) {
  const { rows } = await pool.query<{ providerId: string }>(
    `SELECT a."providerId" FROM account a JOIN "user" u ON u.id=a."userId"
     WHERE u.email=$1 ORDER BY a."providerId"`,
    [email]
  );
  return rows.map((row) => row.providerId);
}

beforeAll(async () => {
  issuer = await startFakeIssuer();
  await admin.query(`CREATE DATABASE ${dbName}`);
  await migrate(dbUrl.toString());
  pool = new Pool({ connectionString: dbUrl.toString() });
  const config = parseConfig({
    ...baseEnv,
    COMMUNITY_OIDC_ISSUER_URL: issuer.issuer,
    COMMUNITY_OIDC_CLIENT_ID: issuer.clientId,
    COMMUNITY_OIDC_CLIENT_SECRET: issuer.clientSecret,
    COMMUNITY_OIDC_LABEL: 'Example sign-in',
  });
  const app = createCommunityApp({ config, pool });
  server = serve({ fetch: app.fetch, port: 0 });
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing HTTP address');
  baseUrl = `http://localhost:${address.port}`;
  const setup = await bootstrapFirstHost((path, body, cookie) => call(path, 'POST', body, cookie), {
    secret: config.bootstrapSecret,
    accountName: 'Owner',
    email: 'owner@example.com',
    password: 'password1234',
    communityName: 'OIDC test',
    channelName: 'General',
  });
  ownerCookie = setup.cookie;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server?.close(() => resolve()));
  await issuer?.close();
  await pool?.end();
  await admin.query(`DROP DATABASE IF EXISTS ${dbName}`);
  await admin.end();
});

describe('OpenID Connect sign-in against a fake issuer', () => {
  it('starts, signs people in with passwords, and offers the button without touching the issuer', async () => {
    // Purpose: fails if discovery runs at startup (a down issuer would then stop the server or
    // disable single sign-on until a restart), or if the options leak more than the label.
    const options = await call('/api/v1/auth-options', 'GET');
    expect(await options.json()).toEqual({
      google: false,
      github: false,
      oidc: { label: 'Example sign-in' },
    });
    expect(issuer.requests).toEqual([]);
  });

  it('refuses an uninvited person and creates no account', async () => {
    // Purpose: fails if an OIDC sign-up skips the invitation or owner-claim admission check.
    issuer.identity = {
      sub: 'uninvited',
      email: 'uninvited@example.com',
      email_verified: true,
      name: 'Uninvited',
    };
    const result = await oidcSignIn();
    expect(result.location.pathname).toBe('/sign-in-failed');
    expect(result.location.searchParams.get('error')).toBe('invitation_required');
    expect(await userIdFor('uninvited@example.com')).toBeNull();
    // Discovery ran on this first use, not before.
    expect(issuer.requests[0]).toBe('GET /.well-known/openid-configuration');
  });

  it('refuses an identity whose email the issuer did not verify', async () => {
    // Purpose: fails if `email_verified: false` (or missing) can create or sign in an account.
    issuer.identity = {
      sub: 'unverified',
      email: 'unverified@example.com',
      email_verified: false,
      name: 'Unverified',
    };
    const result = await oidcSignIn(await invitation());
    expect(result.location.pathname).toBe('/sign-in-failed');
    expect(result.location.searchParams.get('error')).toBe('unable_to_get_user_info');
    expect(await userIdFor('unverified@example.com')).toBeNull();
  });

  it('refuses an identity matching an existing password account, and links nothing', async () => {
    // Purpose: fails if implicit linking lets whoever controls an issuer account with the same
    // email take over an existing Community account.
    issuer.identity = {
      sub: 'owner-lookalike',
      email: 'owner@example.com',
      email_verified: true,
      name: 'Not the owner',
    };
    const result = await oidcSignIn(await invitation());
    expect(result.location.pathname).toBe('/sign-in-failed');
    expect(result.location.searchParams.get('error')).toBe('account_not_linked');
    expect(await providersOf('owner@example.com')).toEqual(['credential']);
  });

  it('admits an invited person, who can then set a password and use it while the issuer is down', async () => {
    // Purpose: fails if invited OIDC sign-up breaks, if an OIDC-only account can pass a password
    // check it cannot answer (or is told its non-existent password is wrong), if setting a
    // password is not audited, or if the password does not work without the issuer.
    issuer.identity = {
      sub: 'invited',
      email: 'invited@example.com',
      email_verified: true,
      name: 'Invited',
    };
    const signedIn = await oidcSignIn(await invitation());
    expect(signedIn.location.pathname).toBe('/signed-in');
    expect(await providersOf('invited@example.com')).toEqual(['oidc']);
    expect((await call('/api/v1/invites/bind', 'POST', {}, signedIn.cookie)).status).toBe(200);
    const redeemed = await call('/api/v1/invites/redeem', 'POST', {}, signedIn.cookie);
    expect(redeemed.status).toBe(200);
    const { memberId } = (await redeemed.json()) as { memberId: string };

    const methods = await call(
      '/api/v1/account/sign-in-methods',
      'GET',
      undefined,
      signedIn.cookie
    );
    expect(await methods.json()).toEqual({ password: false, oidc: true });
    const leave = { password: 'anything-at-all', communityName: 'Not this name' };
    const refused = await call('/api/v1/me/leave', 'POST', leave, signedIn.cookie);
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({
      code: 'PASSWORD_REQUIRED',
      message: 'Set a password in your account to do this.',
    });

    expect(
      (await call('/api/v1/account/password', 'POST', { newPassword: 'short' }, signedIn.cookie))
        .status
    ).toBe(400);
    const set = await call(
      '/api/v1/account/password',
      'POST',
      { newPassword: 'new-password-1234' },
      signedIn.cookie
    );
    expect(set.status).toBe(204);
    expect(await providersOf('invited@example.com')).toEqual(['credential', 'oidc']);
    const audit = await pool.query(
      `SELECT actor_member_id FROM audit_events WHERE action='account.password_set'`
    );
    expect(audit.rows).toEqual([{ actor_member_id: memberId }]);
    // A second password is refused; this route never changes an existing one.
    expect(
      (
        await call(
          '/api/v1/account/password',
          'POST',
          { newPassword: 'another-password-1234' },
          signedIn.cookie
        )
      ).status
    ).toBe(409);
    // The password check now runs: a right password reaches the next check (the name).
    const checked = await call(
      '/api/v1/me/leave',
      'POST',
      { password: 'new-password-1234', communityName: 'Not this name' },
      signedIn.cookie
    );
    expect(checked.status).toBe(409);

    // The same identity signs in again later, with no invitation: it is already this account's.
    const again = await oidcSignIn();
    expect(again.location.pathname).toBe('/signed-in');

    issuer.down = true;
    const requestsBefore = issuer.requests.length;
    try {
      const password = await call('/api/auth/sign-in/email', 'POST', {
        email: 'invited@example.com',
        password: 'new-password-1234',
      });
      expect(password.status).toBe(200);
      expect(issuer.requests.length).toBe(requestsBefore);
    } finally {
      issuer.down = false;
    }
  });

  it('keeps a signed-in person from adding a password to a session older than five minutes', async () => {
    // Purpose: fails if a stolen, older session can quietly add a password to an OIDC account.
    issuer.identity = { sub: 'stale', email: 'stale@example.com', email_verified: true, name: 'S' };
    const signedIn = await oidcSignIn(await invitation());
    expect(signedIn.location.pathname).toBe('/signed-in');
    // A Date parameter, as Better Auth writes it, so the column's time zone handling matches.
    await pool.query(
      `UPDATE session SET "createdAt"=$1
       WHERE "userId"=(SELECT id FROM "user" WHERE email='stale@example.com')`,
      [new Date(Date.now() - 6 * 60_000)]
    );
    const set = await call(
      '/api/v1/account/password',
      'POST',
      { newPassword: 'new-password-1234' },
      signedIn.cookie
    );
    expect(set.status).toBe(403);
    expect(((await set.json()) as { code: string }).code).toBe('REAUTH_REQUIRED');
    expect(await providersOf('stale@example.com')).toEqual(['oidc']);
  });
});

describe('linking single sign-on from the account page', () => {
  /** Start a link as the signed-in `cookie`, authorize at the fake issuer, and return. */
  async function link(cookie: string) {
    const start = await call(
      '/api/auth/link-social',
      'POST',
      { provider: 'oidc', callbackURL: '/linked', errorCallbackURL: '/link-failed' },
      cookie
    );
    expect(start.status).toBe(200);
    const { url } = (await start.json()) as { url: string };
    const back = new URL((await fetch(url, { redirect: 'manual' })).headers.get('location')!);
    const held = cookies(cookie, cookieOf(start));
    const callback = await call(`${back.pathname}${back.search}`, 'GET', undefined, held);
    expect(callback.status).toBe(302);
    return new URL(callback.headers.get('location')!, PUBLIC_URL);
  }

  it('refuses an issuer identity with a different email, and links a matching one explicitly', async () => {
    // Purpose: fails if a signed-in person can attach someone else's issuer identity, or if the
    // one explicit path the refusal above points people to does not work.
    issuer.identity = {
      sub: 'someone-else',
      email: 'someone-else@example.com',
      email_verified: true,
      name: 'Someone else',
    };
    const refused = await link(ownerCookie);
    expect(refused.pathname).toBe('/link-failed');
    expect(refused.searchParams.get('error')).toBe('email_does_not_match');
    expect(await providersOf('owner@example.com')).toEqual(['credential']);

    issuer.identity = {
      sub: 'owner-at-issuer',
      email: 'owner@example.com',
      email_verified: true,
      name: 'Owner',
    };
    expect((await link(ownerCookie)).pathname).toBe('/linked');
    expect(await providersOf('owner@example.com')).toEqual(['credential', 'oidc']);
    const methods = await call('/api/v1/account/sign-in-methods', 'GET', undefined, ownerCookie);
    expect(await methods.json()).toEqual({ password: true, oidc: true });
    const signedIn = await oidcSignIn();
    expect(signedIn.location.pathname).toBe('/signed-in');
  });
});

describe('OpenID Connect discovery', () => {
  it('retries after an issuer outage instead of disabling sign-in until a restart', async () => {
    // Purpose: fails if one failed discovery is cached, as Better Auth does at startup.
    const down = await startFakeIssuer();
    down.down = true;
    const config = parseConfig({
      ...baseEnv,
      COMMUNITY_OIDC_ISSUER_URL: down.issuer,
      COMMUNITY_OIDC_CLIENT_ID: down.clientId,
      COMMUNITY_OIDC_CLIENT_SECRET: down.clientSecret,
    });
    const app = createCommunityApp({ config, pool });
    const second = serve({ fetch: app.fetch, port: 0 });
    await new Promise<void>((resolve) => second.once('listening', resolve));
    const address = second.address();
    if (!address || typeof address === 'string') throw new Error('Missing HTTP address');
    const url = `http://localhost:${address.port}`;
    const start = () =>
      call(
        '/api/auth/sign-in/social',
        'POST',
        { provider: 'oidc', callbackURL: '/signed-in' },
        '',
        url
      );
    try {
      expect(down.requests).toEqual([]);
      const unavailable = await start();
      expect(unavailable.status).toBe(503);
      down.down = false;
      const available = await start();
      expect(available.status).toBe(200);
      expect(((await available.json()) as { url: string }).url).toContain(
        `${down.issuer}/authorize`
      );
    } finally {
      await new Promise<void>((resolve) => second.close(() => resolve()));
      await down.close();
    }
  });

  it('is absent when unset: no button and no provider to sign in with', async () => {
    // Purpose: fails if a self-hosted Community without OIDC shows the button or accepts it.
    const app = createCommunityApp({ config: parseConfig(baseEnv), pool });
    const options = await app.request('/api/v1/auth-options');
    expect(await options.json()).toEqual({ google: false, github: false, oidc: null });
    const start = await app.request('/api/auth/sign-in/social', {
      method: 'POST',
      headers: { origin: PUBLIC_URL, 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'oidc', callbackURL: '/signed-in' }),
    });
    expect(start.status).toBeGreaterThanOrEqual(400);
  });
});
