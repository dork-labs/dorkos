import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { serve } from '@hono/node-server';
import { migrate } from '../migrate.js';
import { createCommunityApp } from '../app.js';
import { parseConfig } from '../config.js';
import { signValue } from '../security.js';
import { AGE_CONFIRMATION_COOKIE } from '../sign-up/minimum-age.js';
import { startFakeIssuer, type FakeIssuer } from './fake-oidc-issuer.js';

// DOR-2554: a host's optional minimum age. Two servers share one database: one with
// COMMUNITY_MINIMUM_AGE=18 and single sign-on, one with neither, so the same invitations prove
// that every sign-up path asks when it is set and that nothing changes when it is not.
const adminUrl = process.env.COMMUNITY_TEST_DATABASE_URL;
if (!adminUrl) throw new Error('COMMUNITY_TEST_DATABASE_URL is required for minimum-age tests');
const admin = new Pool({ connectionString: adminUrl });
const dbName = `community_minimum_age_${randomUUID().replaceAll('-', '')}`;
const dbUrl = new URL(adminUrl);
dbUrl.pathname = `/${dbName}`;
const PUBLIC_URL = 'http://localhost:6481';
const AUTH_SECRET = 'a'.repeat(32);
const BOOTSTRAP_SECRET = 'c'.repeat(32);
const baseEnv = {
  COMMUNITY_DATABASE_URL: dbUrl.toString(),
  COMMUNITY_AUTH_SECRET: AUTH_SECRET,
  COMMUNITY_INVITE_SECRET: 'b'.repeat(32),
  COMMUNITY_BOOTSTRAP_SECRET: BOOTSTRAP_SECRET,
  COMMUNITY_PUBLIC_URL: PUBLIC_URL,
  COMMUNITY_STORAGE_PATH: '/tmp/community-minimum-age-test-blobs',
  COMMUNITY_INVITE_PREVIEW_ATTEMPTS_PER_MINUTE: 100,
  COMMUNITY_SIGNUP_ATTEMPTS_PER_MINUTE: 100,
};
const AGE_MESSAGE = 'Confirm you are at least 18 years old to create an account here.';
let issuer: FakeIssuer;
let pool: Pool;
const servers: ReturnType<typeof serve>[] = [];
let agedUrl: string;
let plainUrl: string;
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

function call(url: string, path: string, method: string, body?: unknown, cookie = '') {
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

async function start(env: Record<string, string>) {
  const config = parseConfig({ ...baseEnv, ...env });
  const app = createCommunityApp({ config, pool });
  const server = serve({ fetch: app.fetch, port: 0 });
  await new Promise<void>((resolve) => server.once('listening', resolve));
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing HTTP address');
  return `http://localhost:${address.port}`;
}

/** Confirm the minimum age on the aged server; returns the cookie it set. */
async function confirmAge() {
  const confirmed = await call(agedUrl, '/api/v1/age-confirmation', 'POST', { confirmed: true });
  expect(confirmed.status).toBe(200);
  return cookieOf(confirmed);
}

/** A signed confirmation cookie with any age and expiry, as only the server could mint it. */
function forgedConfirmation(age: number, expiresAt: number, secret = AUTH_SECRET) {
  return `${AGE_CONFIRMATION_COOKIE}=${signValue(`age-${age}-${expiresAt}`, secret)}`;
}

/** Whether a response tells the browser to drop its age confirmation. */
function clearsConfirmation(response: Response) {
  return response.headers
    .getSetCookie()
    .some((value) => value.startsWith(`${AGE_CONFIRMATION_COOKIE}=;`) && /Max-Age=0/iu.test(value));
}

/** Issue a one-seat invitation and return the cookie its preflight grants. */
async function invitation() {
  const issued = await call(agedUrl, '/api/v1/invites', 'POST', { seats: 1 }, ownerCookie);
  expect(issued.status).toBe(201);
  const { token } = (await issued.json()) as { token: string };
  const preflight = await call(agedUrl, '/api/v1/invites/preflight', 'POST', { token });
  expect(preflight.status).toBe(200);
  return cookieOf(preflight);
}

async function userCount() {
  const { rows } = await pool.query<{ count: string }>('SELECT count(*) FROM "user"');
  return Number(rows[0].count);
}

async function userIdFor(email: string) {
  const { rows } = await pool.query<{ id: string }>('SELECT id FROM "user" WHERE email=$1', [
    email,
  ]);
  return rows[0]?.id ?? null;
}

function signUp(url: string, email: string, cookie: string) {
  return call(
    url,
    '/api/auth/sign-up/email',
    'POST',
    { name: email.split('@')[0], email, password: 'password1234' },
    cookie
  );
}

/** Drive one OIDC round trip on the aged server the way a browser would. */
async function oidcSignIn(cookie: string) {
  const begin = await call(
    agedUrl,
    '/api/auth/sign-in/social',
    'POST',
    { provider: 'oidc', callbackURL: '/signed-in', errorCallbackURL: '/sign-in-failed' },
    cookie
  );
  expect(begin.status).toBe(200);
  const { url } = (await begin.json()) as { url: string };
  const authorize = await fetch(url, { redirect: 'manual' });
  expect(authorize.status).toBe(302);
  const back = new URL(authorize.headers.get('location')!);
  const held = cookies(cookie, cookieOf(begin));
  const callback = await call(agedUrl, `${back.pathname}${back.search}`, 'GET', undefined, held);
  expect(callback.status).toBe(302);
  return Object.assign(new URL(callback.headers.get('location')!, PUBLIC_URL), {
    cleared: clearsConfirmation(callback),
  });
}

beforeAll(async () => {
  issuer = await startFakeIssuer();
  await admin.query(`CREATE DATABASE ${dbName}`);
  await migrate(dbUrl.toString());
  pool = new Pool({ connectionString: dbUrl.toString() });
  agedUrl = await start({
    COMMUNITY_MINIMUM_AGE: '18',
    COMMUNITY_OIDC_ISSUER_URL: issuer.issuer,
    COMMUNITY_OIDC_CLIENT_ID: issuer.clientId,
    COMMUNITY_OIDC_CLIENT_SECRET: issuer.clientSecret,
  });
  plainUrl = await start({});
});

afterAll(async () => {
  for (const server of servers) await new Promise<void>((resolve) => server.close(() => resolve()));
  await issuer?.close();
  await pool?.end();
  await admin.query(`DROP DATABASE IF EXISTS ${dbName}`);
  await admin.end();
});

describe('a minimum age set by the host', () => {
  it('tells the sign-up page the age, and only accepts an explicit confirmation', async () => {
    // Purpose: fails if the page cannot learn the age, or anything short of `true` confirms it.
    const options = await call(agedUrl, '/api/v1/auth-options', 'GET');
    expect(((await options.json()) as { minimumAge: unknown }).minimumAge).toBe(18);
    for (const body of [{}, { confirmed: false }, { confirmed: 'yes' }, { confirmed: true, x: 1 }])
      expect(
        (await call(agedUrl, '/api/v1/age-confirmation', 'POST', body)).status,
        JSON.stringify(body)
      ).toBe(400);
    const confirmed = await call(agedUrl, '/api/v1/age-confirmation', 'POST', { confirmed: true });
    expect(confirmed.status).toBe(200);
    const set = confirmed.headers.getSetCookie().join('\n');
    expect(set).toContain(`${AGE_CONFIRMATION_COOKIE}=`);
    expect(set).toMatch(/HttpOnly/i);
    expect(set).toMatch(/Max-Age=1800/i);
  });

  it('refuses the first owner setup until the owner confirms, and creates nothing', async () => {
    // Purpose: fails if the first-install path, which writes its account directly rather than
    // through sign-up, skips the check.
    const preflight = await call(agedUrl, '/api/v1/bootstrap/preflight', 'POST', {
      secret: BOOTSTRAP_SECRET,
    });
    expect(preflight.status).toBe(200);
    const grant = cookieOf(preflight);
    const body = {
      secret: BOOTSTRAP_SECRET,
      accountName: 'Owner',
      email: 'owner@example.com',
      password: 'password1234',
      communityName: 'Age test',
      channelName: 'general',
    };
    const refused = await call(agedUrl, '/api/v1/bootstrap/complete', 'POST', body, grant);
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({ code: 'FORBIDDEN', message: AGE_MESSAGE });
    expect(await userCount()).toBe(0);

    const done = await call(
      agedUrl,
      '/api/v1/bootstrap/complete',
      'POST',
      body,
      cookies(grant, await confirmAge())
    );
    expect(done.status).toBe(201);
    // One tick makes one account: the next person in this browser is asked again.
    expect(clearsConfirmation(done)).toBe(true);
    expect(clearsConfirmation(refused)).toBe(false);
    // Signing in to an account that already exists never asks.
    const signIn = await call(agedUrl, '/api/auth/sign-in/email', 'POST', {
      email: 'owner@example.com',
      password: 'password1234',
    });
    expect(signIn.status).toBe(200);
    ownerCookie = cookieOf(signIn);
  });

  it('refuses an invited password sign-up without a live confirmation of this age', async () => {
    // Purpose: fails if the check can be skipped, forged, replayed after it expires, or carried
    // over from an earlier, lower setting.
    const admission = await invitation();
    const before = await userCount();
    for (const [label, confirmation] of [
      ['none', ''],
      ['unsigned', `${AGE_CONFIRMATION_COOKIE}=age-18-${Date.now() + 600_000}`],
      ['wrong key', forgedConfirmation(18, Date.now() + 600_000, 'z'.repeat(32))],
      ['expired', forgedConfirmation(18, Date.now() - 1_000)],
      ['a lower age', forgedConfirmation(16, Date.now() + 600_000)],
    ] as const) {
      const refused = await signUp(
        agedUrl,
        `refused-${label.replace(' ', '-')}@example.com`,
        cookies(admission, confirmation)
      );
      expect(refused.status, label).toBe(403);
      expect(((await refused.json()) as { message: string }).message, label).toBe(AGE_MESSAGE);
    }
    expect(await userCount()).toBe(before);

    const created = await signUp(
      agedUrl,
      'confirmed@example.com',
      cookies(admission, await confirmAge())
    );
    expect(created.status).toBe(200);
    expect(await userIdFor('confirmed@example.com')).not.toBeNull();
    expect(clearsConfirmation(created)).toBe(true);
  });

  it('refuses a single sign-on sign-up without the confirmation, and admits one with it', async () => {
    // Purpose: fails if an account created by a provider callback (which carries no form) skips
    // the check. Google and GitHub sign-ups reach the same account-creation hook.
    issuer.identity = {
      sub: 'sso-person',
      email: 'sso@example.com',
      email_verified: true,
      name: 'SSO person',
    };
    const admission = await invitation();
    const refused = await oidcSignIn(admission);
    expect(refused.pathname).toBe('/sign-in-failed');
    expect(refused.searchParams.get('error')).toBe('age_confirmation_required');
    expect(await userIdFor('sso@example.com')).toBeNull();

    const admitted = await oidcSignIn(cookies(admission, await confirmAge()));
    expect(admitted.pathname).toBe('/signed-in');
    expect(await userIdFor('sso@example.com')).not.toBeNull();
    expect(admitted.cleared).toBe(true);
    expect(refused.cleared).toBe(false);
    // The same identity signs in again later with no confirmation: no account is created.
    expect((await oidcSignIn('')).pathname).toBe('/signed-in');
  });
});

describe('no minimum age set', () => {
  it('asks nothing: no age on the page, no confirmation route, and sign-up works as before', async () => {
    // Purpose: fails if an unset setting changes anything a self-hoster sees or does today.
    const options = await call(plainUrl, '/api/v1/auth-options', 'GET');
    expect(await options.json()).toEqual({
      google: false,
      github: false,
      oidc: null,
      minimumAge: null,
    });
    expect(
      (await call(plainUrl, '/api/v1/age-confirmation', 'POST', { confirmed: true })).status
    ).toBe(404);
    const created = await signUp(plainUrl, 'plain@example.com', await invitation());
    expect(created.status).toBe(200);
    expect(await userIdFor('plain@example.com')).not.toBeNull();
  });
});
