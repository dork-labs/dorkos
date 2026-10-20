import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { serve } from '@hono/node-server';
import { migrate } from '../migrate.js';
import { createCommunityApp } from '../app.js';
import { parseConfig } from '../config.js';
import { signValue } from '../security.js';
import { COUNTRY_CONFIRMATION_COOKIE } from '../sign-up/allowed-countries.js';
import { startFakeIssuer, type FakeIssuer } from './fake-oidc-issuer.js';

// DOR-2847: a host's optional allowed countries. Servers share one database: one allowing US and
// Canada and trusting a proxy's country header, one allowing the US only (a changed list), one
// asking both the age and the countries, and one with neither, so the same invitations prove that
// every sign-up path asks when it is set, that existing accounts are never asked, and that
// nothing changes when it is not set.
const adminUrl = process.env.COMMUNITY_TEST_DATABASE_URL;
if (!adminUrl) throw new Error('COMMUNITY_TEST_DATABASE_URL is required for allowed-country tests');
const admin = new Pool({ connectionString: adminUrl });
const dbName = `community_countries_${randomUUID().replaceAll('-', '')}`;
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
  COMMUNITY_STORAGE_PATH: '/tmp/community-allowed-countries-test-blobs',
  COMMUNITY_INVITE_PREVIEW_ATTEMPTS_PER_MINUTE: 100,
  COMMUNITY_SIGNUP_ATTEMPTS_PER_MINUTE: 100,
  COMMUNITY_OPEN_JOINS_PER_MINUTE: 100,
  COMMUNITY_OPEN_JOINS_PER_HOST_PER_MINUTE: 10_000,
};
const CONFIRM_MESSAGE = 'Confirm where you live to create an account here.';
const CLOSED_MESSAGE = "Sign-up isn't open in your country yet.";
const AGE_MESSAGE = 'Confirm you are at least 18 years old to create an account here.';
let issuer: FakeIssuer;
let pool: Pool;
const servers: ReturnType<typeof serve>[] = [];
let countriesUrl: string;
let usOnlyUrl: string;
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

/** One request; `country` is what the host's trusted proxy would put in its header. */
function call(
  url: string,
  path: string,
  method: string,
  body?: unknown,
  cookie = '',
  country?: string
) {
  return fetch(`${url}${path}`, {
    method,
    redirect: 'manual',
    headers: {
      origin: PUBLIC_URL,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(cookie ? { cookie } : {}),
      ...(country === undefined ? {} : { 'x-country': country }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function start(env: Record<string, string>) {
  const config = parseConfig({
    ...baseEnv,
    COMMUNITY_OIDC_ISSUER_URL: issuer.issuer,
    COMMUNITY_OIDC_CLIENT_ID: issuer.clientId,
    COMMUNITY_OIDC_CLIENT_SECRET: issuer.clientSecret,
    ...env,
  });
  const app = createCommunityApp({ config, pool });
  const server = serve({ fetch: app.fetch, port: 0 });
  await new Promise<void>((resolve) => server.once('listening', resolve));
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing HTTP address');
  return `http://localhost:${address.port}`;
}

/** Confirm where this person lives on `url`; returns the cookie it set. */
async function confirmCountry(url = countriesUrl) {
  const confirmed = await call(url, '/api/v1/country-confirmation', 'POST', { confirmed: true });
  expect(confirmed.status).toBe(200);
  return cookieOf(confirmed);
}

/** A signed confirmation cookie for any list and expiry, as only the server could mint it. */
function forgedConfirmation(list: string, expiresAt: number, secret = AUTH_SECRET) {
  return `${COUNTRY_CONFIRMATION_COOKIE}=${signValue(`countries-${list}-${expiresAt}`, secret)}`;
}

/** Whether a response tells the browser to drop its country confirmation. */
function clearsConfirmation(response: Response) {
  return response.headers
    .getSetCookie()
    .some(
      (value) => value.startsWith(`${COUNTRY_CONFIRMATION_COOKIE}=;`) && /Max-Age=0/iu.test(value)
    );
}

/** Issue a one-seat invitation and return the cookie its preflight grants. */
async function invitation() {
  const issued = await call(countriesUrl, '/api/v1/invites', 'POST', { seats: 1 }, ownerCookie);
  expect(issued.status).toBe(201);
  const { token } = (await issued.json()) as { token: string };
  const preflight = await call(countriesUrl, '/api/v1/invites/preflight', 'POST', { token });
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

function signUp(url: string, email: string, cookie: string, country?: string) {
  return call(
    url,
    '/api/auth/sign-up/email',
    'POST',
    { name: email.split('@')[0], email, password: 'password1234' },
    cookie,
    country
  );
}

/** Drive one OIDC round trip the way a browser behind the host's proxy would. */
async function oidcSignIn(url: string, cookie: string, country?: string) {
  const begin = await call(
    url,
    '/api/auth/sign-in/social',
    'POST',
    { provider: 'oidc', callbackURL: '/signed-in', errorCallbackURL: '/sign-in-failed' },
    cookie,
    country
  );
  expect(begin.status).toBe(200);
  const { url: authorizeUrl } = (await begin.json()) as { url: string };
  const authorize = await fetch(authorizeUrl, { redirect: 'manual' });
  expect(authorize.status).toBe(302);
  const back = new URL(authorize.headers.get('location')!);
  const held = cookies(cookie, cookieOf(begin));
  const callback = await call(
    url,
    `${back.pathname}${back.search}`,
    'GET',
    undefined,
    held,
    country
  );
  expect(callback.status).toBe(302);
  return Object.assign(new URL(callback.headers.get('location')!, PUBLIC_URL), {
    cleared: clearsConfirmation(callback),
    cookie: cookies(held, cookieOf(callback)),
  });
}

function signInAs(sub: string, email: string) {
  issuer.identity = { sub, email, email_verified: true, name: sub };
}

beforeAll(async () => {
  issuer = await startFakeIssuer();
  await admin.query(`CREATE DATABASE ${dbName}`);
  await migrate(dbUrl.toString());
  pool = new Pool({ connectionString: dbUrl.toString() });
  countriesUrl = await start({
    COMMUNITY_ALLOWED_COUNTRIES: 'US,CA',
    COMMUNITY_COUNTRY_HEADER: 'X-Country',
  });
  usOnlyUrl = await start({ COMMUNITY_ALLOWED_COUNTRIES: 'US' });
  agedUrl = await start({ COMMUNITY_ALLOWED_COUNTRIES: 'US,CA', COMMUNITY_MINIMUM_AGE: '18' });
  plainUrl = await start({});
});

afterAll(async () => {
  for (const server of servers) await new Promise<void>((resolve) => server.close(() => resolve()));
  await issuer?.close();
  await pool?.end();
  await admin.query(`DROP DATABASE IF EXISTS ${dbName}`);
  await admin.end();
});

describe('allowed countries set by the host', () => {
  it('tells the sign-up page the list, and only accepts an explicit confirmation', async () => {
    // Purpose: fails if the page cannot learn the list, anything short of `true` confirms it, or
    // the confirmation refuses on the proxy's header (which would lock out existing accounts).
    const options = await call(countriesUrl, '/api/v1/auth-options', 'GET');
    expect(((await options.json()) as { allowedCountries: unknown }).allowedCountries).toEqual([
      'US',
      'CA',
    ]);
    for (const body of [{}, { confirmed: false }, { confirmed: 'yes' }, { confirmed: true, x: 1 }])
      expect(
        (await call(countriesUrl, '/api/v1/country-confirmation', 'POST', body)).status,
        JSON.stringify(body)
      ).toBe(400);
    const confirmed = await call(countriesUrl, '/api/v1/country-confirmation', 'POST', {
      confirmed: true,
    });
    expect(confirmed.status).toBe(200);
    const set = confirmed.headers.getSetCookie().join('\n');
    expect(set).toContain(`${COUNTRY_CONFIRMATION_COOKIE}=`);
    expect(set).toMatch(/HttpOnly/i);
    expect(set).toMatch(/Max-Age=1800/i);
    // The route never reads the proxy's country: the page may send it before a single sign-on
    // that turns out to be an existing account's. Only account creation refuses it.
    for (const country of ['FR', 'CA', 'us', 'XX', 'T1'])
      expect(
        (
          await call(
            countriesUrl,
            '/api/v1/country-confirmation',
            'POST',
            { confirmed: true },
            '',
            country
          )
        ).status,
        country
      ).toBe(200);
  });

  it('refuses the first owner setup until the owner confirms, and creates nothing', async () => {
    // Purpose: fails if the first-install path, which writes its account directly rather than
    // through sign-up, skips the check.
    const preflight = await call(countriesUrl, '/api/v1/bootstrap/preflight', 'POST', {
      secret: BOOTSTRAP_SECRET,
    });
    expect(preflight.status).toBe(200);
    const grant = cookieOf(preflight);
    const body = {
      secret: BOOTSTRAP_SECRET,
      accountName: 'Owner',
      email: 'owner@example.com',
      password: 'password1234',
      communityName: 'Country test',
      channelName: 'general',
    };
    const refused = await call(countriesUrl, '/api/v1/bootstrap/complete', 'POST', body, grant);
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({ code: 'FORBIDDEN', message: CONFIRM_MESSAGE });
    expect(await userCount()).toBe(0);

    const done = await call(
      countriesUrl,
      '/api/v1/bootstrap/complete',
      'POST',
      body,
      cookies(grant, await confirmCountry())
    );
    expect(done.status).toBe(201);
    // One tick makes one account: the next person in this browser is asked again.
    expect(clearsConfirmation(done)).toBe(true);
    expect(clearsConfirmation(refused)).toBe(false);
    // Signing in to an account that already exists never asks, wherever the proxy says it is.
    const signIn = await call(
      countriesUrl,
      '/api/auth/sign-in/email',
      'POST',
      { email: 'owner@example.com', password: 'password1234' },
      '',
      'FR'
    );
    expect(signIn.status).toBe(200);
    ownerCookie = cookieOf(signIn);
  });

  it('refuses an invited password sign-up without a live confirmation of this list', async () => {
    // Purpose: fails if the check can be skipped, forged, replayed after it expires, or carried
    // over from a different list (adding or dropping a country retires earlier confirmations).
    const admission = await invitation();
    const before = await userCount();
    for (const [label, confirmation] of [
      ['none', ''],
      ['unsigned', `${COUNTRY_CONFIRMATION_COOKIE}=countries-CA_US-${Date.now() + 600_000}`],
      ['wrong key', forgedConfirmation('CA_US', Date.now() + 600_000, 'z'.repeat(32))],
      ['expired', forgedConfirmation('CA_US', Date.now() - 1_000)],
      ['an older list', forgedConfirmation('US', Date.now() + 600_000)],
      ['a changed list', await confirmCountry(usOnlyUrl)],
    ] as const) {
      const refused = await signUp(
        countriesUrl,
        `refused-${label.replaceAll(' ', '-')}@example.com`,
        cookies(admission, confirmation)
      );
      expect(refused.status, label).toBe(403);
      expect(((await refused.json()) as { message: string }).message, label).toBe(CONFIRM_MESSAGE);
    }
    // A confirmed person the proxy places outside the list is refused, whatever they ticked.
    const outside = await signUp(
      countriesUrl,
      'outside@example.com',
      cookies(admission, await confirmCountry()),
      'FR'
    );
    expect(outside.status).toBe(403);
    expect(((await outside.json()) as { message: string }).message).toBe(CLOSED_MESSAGE);
    expect(await userCount()).toBe(before);

    // A missing header is not a refusal: the person's own word stands.
    const created = await signUp(
      countriesUrl,
      'confirmed@example.com',
      cookies(admission, await confirmCountry())
    );
    expect(created.status).toBe(200);
    expect(await userIdFor('confirmed@example.com')).not.toBeNull();
    expect(clearsConfirmation(created)).toBe(true);
  });

  it('asks for the age and the country together when the host sets both', async () => {
    // Purpose: fails if one confirmation stands in for the other.
    const admission = await invitation();
    const onlyCountry = await signUp(
      agedUrl,
      'only-country@example.com',
      cookies(admission, await confirmCountry(agedUrl))
    );
    expect(onlyCountry.status).toBe(403);
    expect(((await onlyCountry.json()) as { message: string }).message).toBe(AGE_MESSAGE);
    const age = await call(agedUrl, '/api/v1/age-confirmation', 'POST', { confirmed: true });
    const onlyAge = await signUp(
      agedUrl,
      'only-age@example.com',
      cookies(admission, cookieOf(age))
    );
    expect(onlyAge.status).toBe(403);
    expect(((await onlyAge.json()) as { message: string }).message).toBe(CONFIRM_MESSAGE);
    const both = await signUp(
      agedUrl,
      'both@example.com',
      cookies(admission, cookieOf(age), await confirmCountry(agedUrl))
    );
    expect(both.status).toBe(200);
  });

  it('refuses a single sign-on sign-up without the confirmation, and admits one with it', async () => {
    // Purpose: fails if an account created by a provider callback (which carries no form) skips
    // the check or the proxy's country. Google and GitHub sign-ups reach the same hook.
    signInAs('sso-person', 'sso@example.com');
    const admission = await invitation();
    const refused = await oidcSignIn(countriesUrl, admission);
    expect(refused.pathname).toBe('/sign-in-failed');
    expect(refused.searchParams.get('error')).toBe('country_confirmation_required');
    const outside = await oidcSignIn(
      countriesUrl,
      cookies(admission, await confirmCountry()),
      'FR'
    );
    expect(outside.searchParams.get('error')).toBe('country_not_open');
    expect(await userIdFor('sso@example.com')).toBeNull();

    const admitted = await oidcSignIn(
      countriesUrl,
      cookies(admission, await confirmCountry()),
      'CA'
    );
    expect(admitted.pathname).toBe('/signed-in');
    expect(await userIdFor('sso@example.com')).not.toBeNull();
    expect(admitted.cleared).toBe(true);
    expect(refused.cleared).toBe(false);
    // The same identity signs in again later, from anywhere, with no confirmation.
    expect((await oidcSignIn(countriesUrl, '', 'FR')).pathname).toBe('/signed-in');
  });

  it('asks a new person joining an open space, never an existing account joining it', async () => {
    // Purpose: fails if open join lets a new account skip the check, or if an account that
    // already exists on this host (made before the list, or for another space) is refused.
    const current = await call(countriesUrl, '/api/v1/settings', 'GET', undefined, ownerCookie);
    const { settingsVersion } = (await current.json()) as { settingsVersion: number };
    const opened = await fetch(`${countriesUrl}/api/v1/settings`, {
      method: 'PATCH',
      headers: {
        origin: PUBLIC_URL,
        cookie: ownerCookie,
        'content-type': 'application/json',
        'if-match': `"${settingsVersion}"`,
      },
      body: JSON.stringify({ admissionPolicy: 'open' }),
    });
    expect(opened.status).toBe(200);
    const arrive = async (url: string, extra = '', country?: string) => {
      const preflight = await call(url, '/api/v1/open-admission/preflight', 'POST', {});
      expect(preflight.status).toBe(200);
      return oidcSignIn(url, cookies(cookieOf(preflight), extra), country);
    };
    const join = (url: string, cookie: string, country?: string) =>
      call(url, '/api/v1/open-admission/join', 'POST', {}, cookie, country);

    // An account made on the same host without the list (the server with no setting), not yet
    // a member: it joins from outside the list with no confirmation.
    signInAs('existing', 'existing@example.com');
    expect((await arrive(plainUrl)).pathname).toBe('/signed-in');
    expect(await userIdFor('existing@example.com')).not.toBeNull();
    const back = await arrive(countriesUrl, '', 'FR');
    expect(back.pathname).toBe('/signed-in');
    expect((await join(countriesUrl, back.cookie, 'FR')).status).toBe(200);

    // A new person is asked, as on every sign-up.
    signInAs('newcomer', 'newcomer@example.com');
    const refused = await arrive(countriesUrl);
    expect(refused.searchParams.get('error')).toBe('country_confirmation_required');
    expect(await userIdFor('newcomer@example.com')).toBeNull();
    const admitted = await arrive(countriesUrl, await confirmCountry(), 'US');
    expect(admitted.pathname).toBe('/signed-in');
    expect((await join(countriesUrl, admitted.cookie, 'US')).status).toBe(200);
  });
});

describe('no allowed countries set', () => {
  it('asks nothing: no list on the page, no confirmation route, and sign-up works as before', async () => {
    // Purpose: fails if an unset setting changes anything a self-hoster sees or does today,
    // including a country header nobody asked it to trust.
    const options = await call(plainUrl, '/api/v1/auth-options', 'GET');
    expect(((await options.json()) as { allowedCountries: unknown }).allowedCountries).toBeNull();
    expect(
      (await call(plainUrl, '/api/v1/country-confirmation', 'POST', { confirmed: true })).status
    ).toBe(404);
    const created = await signUp(plainUrl, 'plain@example.com', await invitation(), 'FR');
    expect(created.status).toBe(200);
    expect(await userIdFor('plain@example.com')).not.toBeNull();
  });
});
