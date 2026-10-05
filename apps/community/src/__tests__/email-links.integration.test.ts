import { createHash, randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { serve } from '@hono/node-server';
import { hashPassword } from 'better-auth/crypto';
import { migrate } from '../migrate.js';
import { createCommunityApp } from '../app.js';
import { parseConfig, type CommunityConfig } from '../config.js';
import { signInLinkComposers } from '../sign-in/linked.js';
import { emailLinkComposers } from '../email-links/composers.js';
import { resolveEmailLinkRequests } from '../email-links/resolver.js';
import { pruneEmailLinks } from '../email-links/tokens.js';
import { deliverNextNotice, type NoticeAttempt } from '../mail/worker.js';
import { createSmtpTransport } from '../mail/transport.js';
import { recoverPassword } from '../recover-password.js';
import { releaseUnverifiedAccount } from '../host/release-unverified-account.js';
import { hashSecret, hmacSecret, signValue } from '../security.js';
import { bootstrapFirstHost } from './bootstrap-test-helper.js';
import { startFakeIssuer, type FakeIssuer } from './fake-oidc-issuer.js';
import { startSmtpFake, type SmtpFake } from './smtp-fake.js';

// specs/spaces-email (DOR-2710): mailed reset, sign-in and confirmation links. Real Postgres, a
// real Better Auth instance behind real HTTP, an in-process SMTP server, a fake OIDC issuer and a
// stand-in for GitHub's two endpoints. Each `Tn` names the row of the spec's threat table the
// test proves; each must fail on a build without that defense.
const adminUrl = process.env.COMMUNITY_TEST_DATABASE_URL;
if (!adminUrl) throw new Error('COMMUNITY_TEST_DATABASE_URL is required for email link tests');
const admin = new Pool({ connectionString: adminUrl });
const dbName = `community_email_links_${randomUUID().replaceAll('-', '')}`;
const dbUrl = new URL(adminUrl);
dbUrl.pathname = `/${dbName}`;
const PUBLIC_URL = 'http://localhost:6481';
const HTTPS_URL = 'https://space.example';
const SECRET = 'a'.repeat(32);
const PASSWORD = 'old-password-1234';
const NEW_PASSWORD = 'brand-new-password-1';
const PEER_HEADER = 'x-test-peer';
const baseEnv = {
  COMMUNITY_DATABASE_URL: dbUrl.toString(),
  COMMUNITY_AUTH_SECRET: SECRET,
  COMMUNITY_INVITE_SECRET: 'b'.repeat(32),
  COMMUNITY_BOOTSTRAP_SECRET: 'c'.repeat(32),
  COMMUNITY_PUBLIC_URL: PUBLIC_URL,
  COMMUNITY_STORAGE_PATH: '/tmp/community-email-link-test-blobs',
  COMMUNITY_INVITE_PREVIEW_ATTEMPTS_PER_MINUTE: 100,
  COMMUNITY_SIGNUP_ATTEMPTS_PER_MINUTE: 100,
  COMMUNITY_BOOTSTRAP_ATTEMPTS_PER_MINUTE: 100,
  COMMUNITY_REAUTH_ATTEMPTS_PER_MINUTE: 20,
  COMMUNITY_TRUSTED_PROXY_HEADER: PEER_HEADER,
  COMMUNITY_GITHUB_CLIENT_ID: 'github-client',
  COMMUNITY_GITHUB_CLIENT_SECRET: 'github-secret',
  COMMUNITY_OIDC_LABEL: 'DorkOS',
  COMMUNITY_OIDC_MARK: 'dorkos',
};

let issuer: FakeIssuer;
let smtp: SmtpFake;
let pool: Pool;
let communityId: string;
let ownerCookie: string;
const servers: { close: () => Promise<void> }[] = [];
/** Mail on, an untrusted issuer (so sign-ins are held), GitHub. */
let on: string;
let onConfig: CommunityConfig;
/** The same host trusting its issuer to link verified emails. */
let trusted: string;
/** The same host with no mail. */
let off: string;
let offConfig: CommunityConfig;
/** An HTTPS host with mail on. */
let secure: string;
let oidcEnv: Record<string, string>;
let mailEnv: Record<string, string>;
const raceHooks: { beforeSessionInsert?: (userId: string) => Promise<void> } = {};
let github = { id: 4242, email: 'person@example.com', verified: true };

async function serveApp(env: Record<string, unknown>) {
  const config = parseConfig({ ...baseEnv, ...env });
  const app = createCommunityApp({
    config,
    pool,
    noticeComposers: config.mail
      ? { ...signInLinkComposers(config), ...emailLinkComposers(config) }
      : {},
    hooks: {
      beforeSessionInsert: (userId) => raceHooks.beforeSessionInsert?.(userId) ?? Promise.resolve(),
    },
  });
  const server = serve({ fetch: app.fetch, port: 0 });
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing HTTP address');
  servers.push({ close: () => new Promise<void>((resolve) => server.close(() => resolve())) });
  return { url: `http://localhost:${address.port}`, config };
}

function cookieOf(response: Response) {
  return response.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .join('; ');
}

/** Merge cookie headers, a later value replacing an earlier one; an emptied cookie is dropped. */
function cookies(...headers: string[]) {
  const jar = new Map<string, string>();
  for (const header of headers)
    for (const part of header.split('; ').filter(Boolean)) {
      const [name, value] = [part.slice(0, part.indexOf('=')), part.slice(part.indexOf('=') + 1)];
      if (value) jar.set(name, part);
      else jar.delete(name);
    }
  return [...jar.values()].join('; ');
}

/** A fresh caller address per request unless one is named, so per-caller limits stay apart. */
let peerCounter = 0;
const freshPeer = () =>
  `10.${(++peerCounter >> 16) & 255}.${(peerCounter >> 8) & 255}.${peerCounter & 255}`;

function call(
  url: string,
  path: string,
  method: string,
  body?: unknown,
  cookie = '',
  extra: Record<string, string> = {}
) {
  return fetch(`${url}${path}`, {
    method,
    redirect: 'manual',
    headers: {
      origin: url === secure ? HTTPS_URL : PUBLIC_URL,
      [PEER_HEADER]: freshPeer(),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(cookie ? { cookie } : {}),
      ...extra,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function codeOf(response: Response) {
  return ((await response.json()) as { code?: string }).code;
}

/** Drive one provider sign-in the way a browser would, and return where it landed. */
async function providerSignIn(url: string, provider: 'oidc' | 'github', cookie = '') {
  const start = await call(
    url,
    '/api/auth/sign-in/social',
    'POST',
    { provider, callbackURL: '/signed-in', errorCallbackURL: '/sign-in-failed' },
    cookie
  );
  expect(start.status).toBe(200);
  const { url: away } = (await start.json()) as { url: string };
  const held = cookies(cookie, cookieOf(start));
  let back: URL;
  if (provider === 'oidc') {
    const authorize = await fetch(away, { redirect: 'manual' });
    back = new URL(authorize.headers.get('location')!);
  } else {
    const state = new URL(away).searchParams.get('state')!;
    back = new URL(`${PUBLIC_URL}/api/auth/callback/github?code=github-code&state=${state}`);
  }
  const callback = await call(url, `${back.pathname}${back.search}`, 'GET', undefined, held);
  expect(callback.status).toBe(302);
  const location = new URL(callback.headers.get('location')!, PUBLIC_URL);
  return {
    location,
    error: location.searchParams.get('error'),
    cookie: cookies(held, cookieOf(callback)),
  };
}

/** Who a cookie is signed in as, or null. */
async function whoIs(cookie: string): Promise<string | null> {
  const session = await call(on, '/api/auth/get-session', 'GET', undefined, cookie);
  const body = (await session.json()) as { user?: { email: string } } | null;
  return body?.user?.email ?? null;
}

function passwordSignIn(email: string, password = PASSWORD) {
  return call(on, '/api/auth/sign-in/email', 'POST', { email, password });
}

/** Make an account with a password and a membership, straight in the database. */
async function account(
  email: string,
  { confirmed = false, password = PASSWORD as string | null } = {}
): Promise<{ userId: string; memberId: string }> {
  const userId = randomUUID();
  await pool.query('INSERT INTO "user"(id,name,email,"emailVerified") VALUES($1,$2,$3,$4)', [
    userId,
    email.split('@')[0],
    email,
    confirmed,
  ]);
  if (password)
    await pool.query(
      `INSERT INTO account(id,"accountId","providerId","userId",password)
       VALUES($1,$2,'credential',$2,$3)`,
      [randomUUID(), userId, await hashPassword(password)]
    );
  const member = await pool.query<{ id: string }>(
    `INSERT INTO members(community_id,user_id,display_name,handle,role)
     VALUES($1,$2,$3,$3,'member') RETURNING id`,
    [communityId, userId, `m${userId.slice(0, 8)}`]
  );
  return { userId, memberId: member.rows[0].id };
}

/** Give an account every derived credential a clean-out must end, and return their ids. */
async function derivedAccess(userId: string, memberId: string) {
  const grant = await pool.query<{ id: string }>(
    `INSERT INTO connection_grants(community_id,member_id,token_hash,scopes)
     VALUES($1,$2,$3,'{read,post}') RETURNING id`,
    [communityId, memberId, `grant-${userId}`]
  );
  await pool.query(
    `INSERT INTO connection_pairings(community_id,verifier_hash,member_id,expires_at)
     VALUES($1,$2,$3,now()+interval '10 minutes')`,
    [communityId, `pairing-${userId}`, memberId]
  );
  const agent = await pool.query<{ id: string }>(
    `INSERT INTO agents(community_id,owner_member_id,display_name,handle,local_agent_id)
     VALUES($1,$2,'Agent',$3,'local') RETURNING id`,
    [communityId, memberId, `a${userId.slice(0, 8)}`]
  );
  await pool.query(
    `INSERT INTO agent_credentials(community_id,agent_id,token_hash) VALUES($1,$2,$3)`,
    [communityId, agent.rows[0].id, `agent-${userId}`]
  );
  const key = await pool.query<{ id: string }>(
    `INSERT INTO host_api_keys(label,prefix,secret_hash,scopes,issued_via,issued_by_user_id)
     VALUES('Key',$1,$2,'{communities:read}','browser',$3) RETURNING id`,
    [`dkh_${userId.slice(0, 6)}`, createHash('sha256').update(userId).digest('hex'), userId]
  );
  const invite = await pool.query<{ id: string }>(
    `INSERT INTO invites(community_id,issuer_member_id,token_hash,seat_limit,expires_at)
     VALUES($1,$2,$3,1,now()+interval '1 day') RETURNING id`,
    [communityId, memberId, `invite-${userId}`]
  );
  const revoked = async () => ({
    grant:
      (await pool.query('SELECT revoked_at FROM connection_grants WHERE id=$1', [grant.rows[0].id]))
        .rows[0].revoked_at !== null,
    pairing:
      (
        await pool.query('SELECT cancelled_at FROM connection_pairings WHERE member_id=$1', [
          memberId,
        ])
      ).rows[0].cancelled_at !== null,
    agent:
      (
        await pool.query('SELECT revoked_at FROM agent_credentials WHERE agent_id=$1', [
          agent.rows[0].id,
        ])
      ).rows[0].revoked_at !== null,
    key:
      (await pool.query('SELECT revoked_at FROM host_api_keys WHERE id=$1', [key.rows[0].id]))
        .rows[0].revoked_at !== null,
    invite:
      (await pool.query('SELECT revoked_at FROM invites WHERE id=$1', [invite.rows[0].id])).rows[0]
        .revoked_at !== null,
  });
  return { revoked };
}

async function providersOf(userId: string) {
  const { rows } = await pool.query<{ providerId: string }>(
    'SELECT "providerId" FROM account WHERE "userId"=$1 ORDER BY "providerId"',
    [userId]
  );
  return rows.map((row) => row.providerId);
}

async function verified(userId: string) {
  return (
    await pool.query<{ emailVerified: boolean }>('SELECT "emailVerified" FROM "user" WHERE id=$1', [
      userId,
    ])
  ).rows[0].emailVerified;
}

async function audit(memberId: string, action: string) {
  const { rows } = await pool.query<{ changed_fields: string[] }>(
    'SELECT changed_fields FROM audit_events WHERE subject_id=$1 AND action=$2 ORDER BY created_at',
    [memberId, action]
  );
  return rows.map((row) => row.changed_fields);
}

async function sessionCount(userId: string) {
  return (
    await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM session WHERE "userId"=$1', [
      userId,
    ])
  ).rows[0].n;
}

async function liveTokens(userId: string) {
  return (
    await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM email_link_tokens
       WHERE user_id=$1 AND consumed_at IS NULL AND superseded_at IS NULL`,
      [userId]
    )
  ).rows[0].n;
}

const identity = (email: string, sub = `sub-${email}`, emailVerified = true) => {
  issuer.identity = { sub, email, email_verified: emailVerified, name: email.split('@')[0] };
};

const realFetch = globalThis.fetch;
function stubGitHub() {
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const reply = (body: unknown) =>
      new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
    if (href.startsWith('https://github.com/login/oauth/access_token'))
      return reply({ access_token: 'github-token', token_type: 'bearer', scope: 'user:email' });
    if (href === 'https://api.github.com/user')
      return reply({ id: github.id, login: 'person', name: 'Person', email: github.email });
    if (href === 'https://api.github.com/user/emails')
      return reply([{ email: github.email, primary: true, verified: github.verified }]);
    return realFetch(input, init);
  });
}

/** Decode a plain-text mail body as nodemailer encoded it. */
function bodyOf(raw: string): string {
  const split = raw.indexOf('\r\n\r\n');
  const head = raw.slice(0, split);
  const body = raw.slice(split + 4);
  const encoding = /^Content-Transfer-Encoding:\s*(\S+)/imu.exec(head)?.[1]?.toLowerCase();
  if (encoding === 'base64') return Buffer.from(body.replace(/\s+/gu, ''), 'base64').toString();
  if (encoding === 'quoted-printable')
    return Buffer.from(
      body
        .replace(/=\r?\n/gu, '')
        .replace(/=([0-9A-F]{2})/giu, (_, hex: string) => String.fromCharCode(parseInt(hex, 16))),
      'latin1'
    ).toString('utf8');
  return body;
}

/** Resolve every pending request and send every due notice, as the worker's ticks would. */
async function deliverAll(now?: () => Date): Promise<NoticeAttempt[]> {
  while ((await resolveEmailLinkRequests(pool, onConfig, now)) > 0);
  const attempts: NoticeAttempt[] = [];
  for (;;) {
    const attempt = await deliverNextNotice({
      pool,
      transport: createSmtpTransport(onConfig.mail!, {
        connectionMs: 2_000,
        greetingMs: 2_000,
        socketMs: 2_000,
      }),
      composers: { ...signInLinkComposers(onConfig), ...emailLinkComposers(onConfig) },
      now,
    });
    if (!attempt) return attempts;
    attempts.push(attempt);
  }
}

/** The newest mail to an address, decoded, with its link's page and token. */
function lastMailTo(email: string) {
  const mail = smtp.received.filter((message) => message.recipients.includes(email)).at(-1);
  if (!mail) return null;
  const text = bodyOf(mail.raw);
  const link =
    /(https?:\/\/[^\s/]+)(\/reset-password|\/email-sign-in|\/confirm-email)#([A-Za-z0-9_-]{43})/u.exec(
      text
    );
  return {
    raw: mail.raw,
    text,
    subject: /^Subject: (.*)$/mu.exec(mail.raw)?.[1] ?? '',
    origin: link?.[1] ?? null,
    page: link?.[2] ?? null,
    token: link?.[3] ?? null,
  };
}

/**
 * Forget the mail an address was sent, as an hour passing would, so a test that needs more than
 * three links for one address stays under the per-address cap.
 */
async function forgetRequests(email: string) {
  await pool.query('DELETE FROM email_link_requests WHERE email_hash=$1', [
    hmacSecret(email, SECRET),
  ]);
}

/** Ask for a reset for `email` and return its mailed token. */
async function resetToken(email: string): Promise<string> {
  await forgetRequests(email);
  const resets = () =>
    smtp.received.filter(
      (m) => m.recipients.includes(email) && bodyOf(m.raw).includes('/reset-password#')
    ).length;
  const before = resets();
  const asked = await call(on, '/api/v1/account/password-reset', 'POST', { email });
  expect(asked.status).toBe(202);
  await deliverAll();
  expect(resets()).toBe(before + 1);
  const mail = lastMailTo(email);
  expect(mail?.page).toBe('/reset-password');
  return mail!.token!;
}

function reset(token: string, cookie = '', newPassword = NEW_PASSWORD) {
  return call(on, '/api/auth/email-link/reset-password', 'POST', { token, newPassword }, cookie);
}

/** Hold a sign-in through the untrusted issuer for an existing account; return its cookie. */
async function hold(email: string, sub = `held-${email}`) {
  identity(email, sub);
  const result = await providerSignIn(on, 'oidc');
  expect(result.error).toBe('link_needs_password');
  return result.cookie;
}

/** Hold a sign-in, ask for a sign-in link in that browser, and return the cookie and token. */
async function signInToken(email: string, sub?: string) {
  const cookie = await hold(email, sub);
  const asked = await call(on, '/api/v1/sign-in-link/email', 'POST', undefined, cookie);
  expect(asked.status).toBe(202);
  await deliverAll();
  const mail = lastMailTo(email);
  expect(mail?.page).toBe('/email-sign-in');
  return { cookie: cookies(cookie, cookieOf(asked)), token: mail!.token! };
}

function emailSignIn(token: string, cookie: string) {
  return call(on, '/api/auth/email-link/sign-in', 'POST', { token }, cookie);
}

/** Sign in with a password and ask for a confirmation link; return the session and token. */
async function confirmationToken(email: string, password = PASSWORD) {
  const signedIn = await passwordSignIn(email, password);
  expect(signedIn.status).toBe(200);
  const session = cookieOf(signedIn);
  const asked = await call(on, '/api/v1/account/email-confirmation', 'POST', undefined, session);
  expect(asked.status).toBe(202);
  await deliverAll();
  const mail = lastMailTo(email);
  expect(mail?.page).toBe('/confirm-email');
  return { session, token: mail!.token! };
}

function confirm(token: string, cookie: string, newPassword?: string) {
  return call(
    on,
    '/api/v1/account/email-confirmation/confirm',
    'POST',
    newPassword === undefined ? { token } : { token, newPassword },
    cookie
  );
}

/** Hold the next session insert for this account and return when it is held, and the release. */
function holdNextSession(userId: string) {
  let held!: () => void;
  let release!: () => void;
  const reached = new Promise<void>((resolve) => (held = resolve));
  const gate = new Promise<void>((resolve) => (release = resolve));
  raceHooks.beforeSessionInsert = async (id) => {
    if (id !== userId) return;
    delete raceHooks.beforeSessionInsert;
    held();
    await gate;
  };
  return { reached, release };
}

beforeAll(async () => {
  issuer = await startFakeIssuer();
  smtp = await startSmtpFake();
  await admin.query(`CREATE DATABASE ${dbName}`);
  await migrate(dbUrl.toString());
  pool = new Pool({ connectionString: dbUrl.toString() });
  oidcEnv = {
    COMMUNITY_OIDC_ISSUER_URL: issuer.issuer,
    COMMUNITY_OIDC_CLIENT_ID: issuer.clientId,
    COMMUNITY_OIDC_CLIENT_SECRET: issuer.clientSecret,
  };
  mailEnv = {
    COMMUNITY_SMTP_URL: `smtp://127.0.0.1:${smtp.port}`,
    COMMUNITY_MAIL_FROM: 'Test Space <spaces@community.test>',
  };
  const oidc = oidcEnv;
  const mail = mailEnv;
  ({ url: on, config: onConfig } = await serveApp({ ...oidc, ...mail }));
  ({ url: trusted } = await serveApp({
    ...oidc,
    ...mail,
    COMMUNITY_OIDC_LINK_VERIFIED_EMAIL: '1',
  }));
  ({ url: off, config: offConfig } = await serveApp(oidc));
  ({ url: secure } = await serveApp({ ...oidc, ...mail, COMMUNITY_PUBLIC_URL: HTTPS_URL }));
  const setup = await bootstrapFirstHost(
    (path, body, cookie) => call(on, path, 'POST', body, cookie),
    {
      secret: baseEnv.COMMUNITY_BOOTSTRAP_SECRET,
      accountName: 'Owner',
      email: 'owner@example.com',
      password: 'owner-password-1234',
      communityName: 'Email links',
    }
  );
  ownerCookie = setup.cookie;
  communityId = setup.communityId;
  stubGitHub();
});

beforeEach(() => {
  smtp.behaviour = 'accept';
});

afterEach(() => {
  delete raceHooks.beforeSessionInsert;
});

afterAll(async () => {
  vi.unstubAllGlobals();
  for (const server of servers) await server.close();
  await issuer?.close();
  await smtp?.close();
  await pool?.end();
  // Wait for the pool's connections to finish closing: FORCE would terminate one mid-close into
  // an uncaught 57P01 (see migrate.integration.test.ts).
  for (let tries = 0; tries < 100; tries++) {
    const open = await admin.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=$1',
      [dbName]
    );
    if (open.rows[0].n === 0) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await admin.end();
});

describe('asking for a reset link', () => {
  it('answers byte for byte the same for known, unknown, erased and throttled addresses (T4)', async () => {
    // Purpose: fails if the answer (status, headers, body) to a reset request tells anyone
    // whether the address has an account, is being erased, or has hit its mail cap.
    await account('t4-known@example.com', { confirmed: true });
    const { userId: erased } = await account('t4-erased@example.com');
    await pool.query(
      `INSERT INTO erasure_requests(kind,user_id,state,execute_after,next_attempt_at)
       VALUES('account',$1,'scheduled',now()+interval '1 day',now()+interval '1 day')`,
      [erased]
    );
    await account('t4-throttled@example.com');
    for (let i = 0; i < 3; i++)
      await pool.query(
        `INSERT INTO email_link_requests(kind,email_hash,state,resolved_at)
         VALUES('password_reset',$1,'queued',now())`,
        [hmacSecret('t4-throttled@example.com', SECRET)]
      );
    const seen = [];
    for (const email of [
      't4-known@example.com',
      't4-nobody@example.com',
      't4-erased@example.com',
      't4-throttled@example.com',
    ]) {
      const response = await call(on, '/api/v1/account/password-reset', 'POST', { email });
      const headers = [...(response.headers as unknown as Iterable<[string, string]>)].filter(
        ([name]) => name !== 'date'
      );
      seen.push({ status: response.status, headers, body: await response.text() });
    }
    expect(seen[0]).toEqual({
      status: 202,
      headers: expect.any(Array),
      body: '{"accepted":true}',
    });
    for (const other of seen.slice(1)) expect(other).toEqual(seen[0]);
  });

  it('runs the same statements for a known and an unknown address, and never reads "user" (T5)', async () => {
    // Purpose: fails if the anonymous request path reads accounts or branches on them, which is
    // what would let its timing say whether an address exists.
    await account('t5-known@example.com');
    const seen: string[] = [];
    const recording = new Proxy(pool, {
      get(target, prop, receiver) {
        if (prop !== 'query') return Reflect.get(target, prop, receiver) as unknown;
        return (text: unknown, params?: unknown[]) => {
          const sql = typeof text === 'string' ? text : (text as { text: string }).text;
          seen.push(`${sql} ${(params ?? []).map((p) => typeof p).join(',')}`);
          return target.query(text as string, params);
        };
      },
    });
    const config = parseConfig({ ...baseEnv, ...oidcEnv, ...mailEnv });
    const app = createCommunityApp({
      config,
      pool: recording,
      noticeComposers: { ...signInLinkComposers(config), ...emailLinkComposers(config) },
    });
    const runs: string[][] = [];
    for (const email of ['t5-known@example.com', 't5-nobody@example.com']) {
      seen.length = 0;
      const response = await app.request('/api/v1/account/password-reset', {
        method: 'POST',
        headers: {
          origin: PUBLIC_URL,
          'content-type': 'application/json',
          [PEER_HEADER]: freshPeer(),
        },
        body: JSON.stringify({ email }),
      });
      expect(response.status).toBe(202);
      runs.push([...seen]);
    }
    expect(runs[0].length).toBeGreaterThan(0);
    expect(runs[1]).toEqual(runs[0]);
    expect(runs[0].join('\n')).not.toMatch(/"user"/u);
  });

  it('has no per-address limit: the 4th request answers 202, and only the resolver throttles (T6)', async () => {
    // Purpose: fails if a per-address limit in the request path answers differently once an
    // address that has an account reaches its cap.
    await account('t6-known@example.com', { confirmed: true });
    for (const email of ['t6-known@example.com', 't6-nobody@example.com'])
      for (let i = 0; i < 4; i++)
        expect((await call(on, '/api/v1/account/password-reset', 'POST', { email })).status).toBe(
          202
        );
    await deliverAll();
    const states = async (email: string) =>
      (
        await pool.query<{ state: string }>(
          'SELECT state FROM email_link_requests WHERE email_hash=$1 ORDER BY created_at,id',
          [hmacSecret(email, SECRET)]
        )
      ).rows.map((row) => row.state);
    expect(await states('t6-known@example.com')).toEqual([
      'queued',
      'queued',
      'queued',
      'throttled',
    ]);
    expect(await states('t6-nobody@example.com')).toEqual([
      'dropped',
      'dropped',
      'dropped',
      'dropped',
    ]);
  });

  it('limits one caller address a minute and an hour, counting an IPv6 /64 as one (T7)', async () => {
    // Purpose: fails if one caller (or one IPv6 /64 rotating addresses) can ask for more than
    // the per-minute setting or 20 an hour.
    const ask = (peer: string) =>
      call(on, '/api/v1/account/password-reset', 'POST', { email: 'anyone@example.com' }, '', {
        [PEER_HEADER]: peer,
      });
    for (let i = 0; i < 5; i++) expect((await ask('192.0.2.50')).status).toBe(202);
    const refused = await ask('192.0.2.50');
    expect(refused.status).toBe(429);
    expect(refused.headers.get('retry-after')).toMatch(/^\d+$/u);
    for (let i = 0; i < 5; i++) expect((await ask(`2001:db8:5:6::${i + 1}`)).status).toBe(202);
    expect((await ask('2001:db8:5:6:ffff::9')).status).toBe(429);
    expect((await ask('2001:db8:5:7::1')).status).toBe(202);
    // A host that allows many a minute still stops one caller at 20 an hour.
    const { url: generous } = await serveApp({
      ...oidcEnv,
      ...mailEnv,
      COMMUNITY_EMAIL_LINK_REQUESTS_PER_MINUTE: 100,
    });
    const askGenerous = () =>
      call(generous, '/api/v1/account/password-reset', 'POST', { email: 'a@example.com' }, '', {
        [PEER_HEADER]: '192.0.2.77',
      });
    for (let i = 0; i < 20; i++) expect((await askGenerous()).status).toBe(202);
    expect((await askGenerous()).status).toBe(429);
  });

  it('throttles the 4th mail of a kind an hour and the 21st a day to one address, and at the host cap (T7)', async () => {
    // Purpose: fails if one address can be mail-bombed past its caps, or the host past its
    // hourly total; the request still answers 202 each time.
    await account('t7-day@example.com', { confirmed: true });
    for (let i = 0; i < 20; i++)
      await pool.query(
        `INSERT INTO email_link_requests(kind,email_hash,state,resolved_at,created_at)
         VALUES('password_reset',$1,'queued',now()-interval '2 hours',now()-interval '2 hours')`,
        [hmacSecret('t7-day@example.com', SECRET)]
      );
    expect(
      (await call(on, '/api/v1/account/password-reset', 'POST', { email: 't7-day@example.com' }))
        .status
    ).toBe(202);
    await deliverAll();
    const last = await pool.query<{ state: string }>(
      `SELECT state FROM email_link_requests WHERE email_hash=$1 ORDER BY created_at DESC LIMIT 1`,
      [hmacSecret('t7-day@example.com', SECRET)]
    );
    expect(last.rows[0].state).toBe('throttled');

    await account('t7-host@example.com', { confirmed: true });
    expect(
      (await call(on, '/api/v1/account/password-reset', 'POST', { email: 't7-host@example.com' }))
        .status
    ).toBe(202);
    const queuedLastHour = (
      await pool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM email_link_requests
         WHERE state='queued' AND resolved_at > now() - interval '1 hour'`
      )
    ).rows[0].n;
    await resolveEmailLinkRequests(pool, {
      authSecret: SECRET,
      limits: { emailLinksPerHour: queuedLastHour },
    });
    const host = await pool.query<{ state: string }>(
      `SELECT state FROM email_link_requests WHERE email_hash=$1`,
      [hmacSecret('t7-host@example.com', SECRET)]
    );
    expect(host.rows[0].state).toBe('throttled');
  });

  it("never lets a stranger block a person's reset for longer than the hour (T7)", async () => {
    // Purpose: fails if someone asking for resets on another person's address can use up that
    // address's allowance for a day, so the owner's own reset is quietly throttled.
    await account('t7-victim@example.com', { confirmed: true });
    const hash = hmacSecret('t7-victim@example.com', SECRET);
    // Over the last few hours a stranger got the most the hourly cap allows each hour.
    for (let i = 0; i < 12; i++)
      await pool.query(
        `INSERT INTO email_link_requests(kind,email_hash,state,resolved_at,created_at)
         VALUES('password_reset',$1,'queued',now()-$2::interval,now()-$2::interval)`,
        [hash, `${61 + i * 15} minutes`]
      );
    // And has just spent this hour's allowance too: the owner's reset now waits for the hour.
    for (let i = 0; i < 3; i++)
      await pool.query(
        `INSERT INTO email_link_requests(kind,email_hash,state,resolved_at,created_at)
         VALUES('password_reset',$1,'queued',now()-interval '5 minutes',now()-interval '5 minutes')`,
        [hash]
      );
    const latest = async () =>
      (
        await pool.query<{ state: string }>(
          `SELECT state FROM email_link_requests WHERE email_hash=$1 ORDER BY created_at DESC LIMIT 1`,
          [hash]
        )
      ).rows[0].state;
    await call(on, '/api/v1/account/password-reset', 'POST', { email: 't7-victim@example.com' });
    await deliverAll();
    expect(await latest()).toBe('throttled');
    // An hour later the owner asks again, and gets their link.
    await pool.query(
      `UPDATE email_link_requests SET resolved_at=resolved_at-interval '1 hour',
         created_at=created_at-interval '1 hour' WHERE email_hash=$1`,
      [hash]
    );
    await call(on, '/api/v1/account/password-reset', 'POST', { email: 't7-victim@example.com' });
    await deliverAll();
    expect(await latest()).toBe('queued');
    expect(lastMailTo('t7-victim@example.com')?.page).toBe('/reset-password');
  });

  it('keeps the typed address only until it is resolved, and only hashes of links (T15)', async () => {
    // Purpose: fails if a plain address outlives the resolver, or if a database leak would hold
    // a usable link: the raw token may exist only in the mail.
    const { userId } = await account('t15@example.com', { confirmed: true });
    await call(on, '/api/v1/account/password-reset', 'POST', { email: 'T15@Example.com ' });
    const pending = await pool.query<{ email: string | null }>(
      `SELECT email FROM email_link_requests WHERE email_hash=$1`,
      [hmacSecret('t15@example.com', SECRET)]
    );
    expect(pending.rows).toEqual([{ email: 't15@example.com' }]);
    await deliverAll();
    const resolved = await pool.query(`SELECT * FROM email_link_requests WHERE email_hash=$1`, [
      hmacSecret('t15@example.com', SECRET),
    ]);
    expect(resolved.rows[0].email).toBeNull();
    expect(JSON.stringify(resolved.rows)).not.toContain('t15@');
    const token = lastMailTo('t15@example.com')!.token!;
    const stored = await pool.query('SELECT * FROM email_link_tokens WHERE user_id=$1', [userId]);
    expect(stored.rows).toHaveLength(1);
    expect(stored.rows[0].token_hash).toMatch(/^[a-f0-9]{64}$/u);
    expect(stored.rows[0].token_hash).toBe(hashSecret(token));
    expect(JSON.stringify(stored.rows)).not.toContain(token);
  });

  it('builds the link from the public URL whatever Host the request named (T16)', async () => {
    // Purpose: fails if a forged Host or X-Forwarded-Host could send a working link to an
    // attacker's domain.
    await account('t16@example.com', { confirmed: true });
    await call(on, '/api/v1/account/password-reset', 'POST', { email: 't16@example.com' }, '', {
      host: 'evil.example',
      'x-forwarded-host': 'evil.example',
    });
    await deliverAll();
    const mail = lastMailTo('t16@example.com')!;
    expect(mail.origin).toBe(PUBLIC_URL);
    expect(mail.text).not.toContain('evil.example');
  });

  it('answers 202 while mail is down, retries, and mints nothing once the mail is stale (T19)', async () => {
    // Purpose: fails if the request waits on mail, if a mail server outage loses the request, or
    // if a link the server could not send for over an hour still arrives.
    const { userId } = await account('t19@example.com', { confirmed: true });
    smtp.behaviour = 'defer-recipient';
    expect(
      (await call(on, '/api/v1/account/password-reset', 'POST', { email: 't19@example.com' }))
        .status
    ).toBe(202);
    const attempts = await deliverAll();
    expect(attempts.map((a) => a.outcome)).toContain('retrying');
    const outbox = await pool.query<{ id: string; state: string }>(
      `SELECT o.id,o.state FROM notice_outbox o JOIN email_link_requests r ON r.outbox_id=o.id
       WHERE r.email_hash=$1`,
      [hmacSecret('t19@example.com', SECRET)]
    );
    expect(outbox.rows[0].state).toBe('pending');
    smtp.behaviour = 'accept';
    await pool.query(`UPDATE notice_outbox SET next_attempt_at=now() WHERE id=$1`, [
      outbox.rows[0].id,
    ]);
    await pool.query(`DELETE FROM email_link_tokens WHERE user_id=$1`, [userId]);
    const later = () => new Date(Date.now() + 61 * 60_000);
    const stale = await deliverAll(later);
    expect(stale).toContainEqual({
      noticeId: outbox.rows[0].id,
      outcome: 'failed',
      errorClass: 'NOTICE_OBSOLETE',
    });
    expect(await liveTokens(userId)).toBe(0);
  });

  it('drops a request pending over an hour and erases its address, with mail off (T24)', async () => {
    // Purpose: fails if a host that turned mail off keeps typed addresses indefinitely.
    const response = await call(off, '/api/v1/account/password-reset', 'POST', {
      email: 'x@example.com',
    });
    expect(response.status).toBe(409);
    const row = await pool.query<{ id: string }>(
      `INSERT INTO email_link_requests(kind,email_hash,email,state,created_at)
       VALUES('password_reset',$1,'t24@example.com','pending',now()-interval '61 minutes')
       RETURNING id`,
      [hmacSecret('t24@example.com', SECRET)]
    );
    await pruneEmailLinks(pool);
    const after = await pool.query('SELECT state,email FROM email_link_requests WHERE id=$1', [
      row.rows[0].id,
    ]);
    expect(after.rows[0]).toEqual({ state: 'dropped', email: null });
  });

  it('prunes old requests and dead links', async () => {
    // Purpose: fails if request rows outlive a day, or dead links outlive their hour.
    const { userId } = await account('prune@example.com');
    const old = await pool.query<{ id: string }>(
      `INSERT INTO email_link_requests(kind,email_hash,user_id,state,resolved_at,created_at)
       VALUES('email_confirmation',$1,$2,'dropped',now(),now()-interval '25 hours') RETURNING id`,
      [hmacSecret('prune@example.com', SECRET), userId]
    );
    for (const [hash, column] of [
      ['1'.repeat(64), 'expires_at'],
      ['2'.repeat(64), 'consumed_at'],
      ['3'.repeat(64), 'superseded_at'],
    ] as const)
      await pool.query(
        `INSERT INTO email_link_tokens(token_hash,kind,user_id,request_id,outbox_id,email_hash,
           expires_at${column === 'expires_at' ? '' : `,${column}`})
         VALUES($1,'email_confirmation',$2,$3,$3,$4,
           ${column === 'expires_at' ? "now()-interval '61 minutes'" : "now()+interval '1 day',now()-interval '61 minutes'"})`,
        [hash, userId, old.rows[0].id, hmacSecret('prune@example.com', SECRET)]
      );
    await pruneEmailLinks(pool);
    expect(
      (await pool.query('SELECT 1 FROM email_link_requests WHERE id=$1', [old.rows[0].id])).rowCount
    ).toBe(0);
    expect(
      (await pool.query('SELECT 1 FROM email_link_tokens WHERE user_id=$1', [userId])).rowCount
    ).toBe(0);
  });
});

describe('mail off', () => {
  it('offers no links, refuses every new route with 409, and queues nothing', async () => {
    // Purpose: fails if a host without mail shows or half-runs any of the three flows.
    const options = await (await call(off, '/api/v1/auth-options', 'GET')).json();
    expect(options).toMatchObject({ emailLinks: false });
    expect(await (await call(on, '/api/v1/auth-options', 'GET')).json()).toMatchObject({
      emailLinks: true,
    });
    const signedIn = await call(off, '/api/auth/sign-in/email', 'POST', {
      email: 'owner@example.com',
      password: 'owner-password-1234',
    });
    const session = cookieOf(signedIn);
    const token = 'A'.repeat(43);
    for (const [path, body] of [
      ['/api/v1/account/password-reset', { email: 'owner@example.com' }],
      ['/api/v1/sign-in-link/email', undefined],
      ['/api/v1/account/email-confirmation', undefined],
      ['/api/v1/email-links/peek', { token }],
      ['/api/v1/account/email-confirmation/confirm', { token }],
      ['/api/auth/email-link/reset-password', { token, newPassword: NEW_PASSWORD }],
      ['/api/auth/email-link/sign-in', { token }],
    ] as const) {
      const response = await call(off, path, 'POST', body, session);
      expect(response.status, path).toBe(409);
      expect(await codeOf(response), path).toBe('NOTICE_DELIVERY_UNAVAILABLE');
    }
    // A password sign-up on a host without mail queues no confirmation.
    const issued = await call(off, '/api/v1/invites', 'POST', { seats: 1 }, ownerCookie);
    const { token: invite } = (await issued.json()) as { token: string };
    const preflight = await call(off, '/api/v1/invites/preflight', 'POST', { token: invite });
    const signUp = await call(
      off,
      '/api/auth/sign-up/email',
      'POST',
      { name: 'Quiet', email: 'quiet@example.com', password: PASSWORD },
      cookieOf(preflight)
    );
    expect(signUp.status).toBe(200);
    const queued = await pool.query(
      `SELECT 1 FROM email_link_requests r JOIN "user" u ON u.id=r.user_id
       WHERE u.email='quiet@example.com'`
    );
    expect(queued.rowCount).toBe(0);
    expect(offConfig.mail).toBeNull();
  });
});

describe('confirmation requests', () => {
  it('queues one for the first owner and for a password sign-up, none for a verified provider sign-up', async () => {
    // Purpose: fails if a never-confirmed new account gets no confirmation mail, or if one the
    // issuer already vouched for gets one.
    const owner = await pool.query(
      `SELECT r.kind FROM email_link_requests r JOIN "user" u ON u.id=r.user_id
       WHERE u.email='owner@example.com'`
    );
    expect(owner.rows).toEqual([{ kind: 'email_confirmation' }]);
    const invite = async () => {
      const issued = await call(on, '/api/v1/invites', 'POST', { seats: 1 }, ownerCookie);
      const { token } = (await issued.json()) as { token: string };
      return cookieOf(await call(on, '/api/v1/invites/preflight', 'POST', { token }));
    };
    const signUp = await call(
      on,
      '/api/auth/sign-up/email',
      'POST',
      { name: 'New', email: 'signup@example.com', password: PASSWORD },
      await invite()
    );
    expect(signUp.status).toBe(200);
    identity('provider-signup@example.com');
    const provider = await providerSignIn(on, 'oidc', await invite());
    expect(provider.location.pathname).toBe('/signed-in');
    const kinds = async (email: string) =>
      (
        await pool.query(
          `SELECT r.kind FROM email_link_requests r JOIN "user" u ON u.id=r.user_id
           WHERE u.email=$1`,
          [email]
        )
      ).rows;
    expect(await kinds('signup@example.com')).toEqual([{ kind: 'email_confirmation' }]);
    expect(await kinds('provider-signup@example.com')).toEqual([]);
    await deliverAll();
    const mail = lastMailTo('signup@example.com')!;
    expect(mail.subject).toBe('Confirm your email for localhost:6481');
    expect(mail.page).toBe('/confirm-email');
  });

  it('refuses a resend once confirmed, and the 4th in an hour', async () => {
    // Purpose: fails if a confirmed account can be mailed confirmations, or one account can
    // request without limit.
    await account('resend-done@example.com', { confirmed: true });
    const done = cookieOf(await passwordSignIn('resend-done@example.com'));
    const conflict = await call(on, '/api/v1/account/email-confirmation', 'POST', undefined, done);
    expect(conflict.status).toBe(409);
    await account('resend@example.com');
    const session = cookieOf(await passwordSignIn('resend@example.com'));
    for (let i = 0; i < 3; i++)
      expect(
        (await call(on, '/api/v1/account/email-confirmation', 'POST', undefined, session)).status
      ).toBe(202);
    expect(
      (await call(on, '/api/v1/account/email-confirmation', 'POST', undefined, session)).status
    ).toBe(429);
    expect(
      (await call(on, '/api/v1/account/email-confirmation', 'POST', undefined, '')).status
    ).toBe(401);
  });
});

describe('a reset link', () => {
  it('on a confirmed account: new password, derived access ended, provider links kept, signed in', async () => {
    // Purpose: fails if a reset leaves an old session, connection, agent key, pairing, server key
    // or invitation working, drops a provider sign-in on a confirmed account, or does not sign
    // the browser in with Better Auth's own cookie.
    const { userId, memberId } = await account('reset-confirmed@example.com', { confirmed: true });
    await pool.query(
      `INSERT INTO account(id,"accountId","providerId","userId") VALUES($1,'gh-rc','github',$2)`,
      [randomUUID(), userId]
    );
    const old = cookieOf(await passwordSignIn('reset-confirmed@example.com'));
    const access = await derivedAccess(userId, memberId);
    const token = await resetToken('reset-confirmed@example.com');
    const mail = lastMailTo('reset-confirmed@example.com')!;
    expect(mail.subject).toBe('Reset your password for localhost:6481');
    expect(mail.text).toContain('open this link within 30 minutes');
    const peek = await call(on, '/api/v1/email-links/peek', 'POST', { token });
    expect(await peek.json()).toMatchObject({
      kind: 'password_reset',
      email: 'reset-confirmed@example.com',
      clears: [
        'sessions',
        'connections',
        'agent_credentials',
        'pairings',
        'invites',
        'host_api_keys',
      ],
      needsPassword: false,
      signedInAs: null,
    });
    const used = await reset(token);
    expect(used.status).toBe(200);
    expect(await used.json()).toEqual({ cleared: 'access' });
    expect(used.headers.getSetCookie().join(';')).toContain('better-auth.session_token=');
    expect(await whoIs(cookieOf(used))).toBe('reset-confirmed@example.com');
    expect(await whoIs(old)).toBeNull();
    expect(await sessionCount(userId)).toBe(1);
    expect(await access.revoked()).toEqual({
      grant: true,
      pairing: true,
      agent: true,
      key: true,
      invite: true,
    });
    expect(await providersOf(userId)).toEqual(['credential', 'github']);
    expect((await passwordSignIn('reset-confirmed@example.com')).status).toBe(401);
    expect((await passwordSignIn('reset-confirmed@example.com', NEW_PASSWORD)).status).toBe(200);
    expect(await audit(memberId, 'member.password_reset')).toEqual([['password']]);
    // T3: the same link twice.
    const again = await reset(token);
    expect(again.status).toBe(410);
    expect(await codeOf(again)).toBe('LINK_EXPIRED');
  });

  it('ends a squatter on a never-confirmed account: session, password, GitHub, grant, agent (T1)', async () => {
    // Purpose: the pre-account squat. Fails if anything a stranger set up on an account made with
    // the victim's address survives the victim's first reset link.
    const { userId, memberId } = await account('t1-reset@example.com');
    await pool.query(
      `INSERT INTO account(id,"accountId","providerId","userId") VALUES($1,'gh-sq','github',$2)`,
      [randomUUID(), userId]
    );
    const squatter = cookieOf(await passwordSignIn('t1-reset@example.com'));
    const access = await derivedAccess(userId, memberId);
    const token = await resetToken('t1-reset@example.com');
    const peek = await (await call(on, '/api/v1/email-links/peek', 'POST', { token })).json();
    expect(peek.clears).toEqual([
      'sessions',
      'connections',
      'agent_credentials',
      'pairings',
      'invites',
      'host_api_keys',
      'password',
      'sign_in_links',
    ]);
    const used = await reset(token);
    expect(used.status).toBe(200);
    expect(await used.json()).toEqual({ cleared: 'everything' });
    expect(await whoIs(squatter)).toBeNull();
    expect((await passwordSignIn('t1-reset@example.com')).status).toBe(401);
    expect(await providersOf(userId)).toEqual(['credential']);
    expect(await access.revoked()).toMatchObject({ grant: true, agent: true });
    expect(await verified(userId)).toBe(true);
    expect(await audit(memberId, 'member.email_confirmed')).toEqual([['reset']]);
    expect(await audit(memberId, 'member.password_reset')).toEqual([['password', 'cleared']]);
  });

  it('lets exactly one of two concurrent uses through (T3)', async () => {
    // Purpose: fails if two tabs using one link at once can both reset and sign in.
    const { userId } = await account('t3@example.com', { confirmed: true });
    const token = await resetToken('t3@example.com');
    const [a, b] = await Promise.all([reset(token), reset(token, '', 'another-password-12')]);
    expect([a.status, b.status].sort()).toEqual([200, 410]);
    expect(await sessionCount(userId)).toBe(1);
  });

  it('dies when the password, the address, the account or a newer link changes first (T9)', async () => {
    // Purpose: fails if a link minted before any of these changes still works after it.
    await account('t9@example.com', { confirmed: true });
    const userId = (
      await pool.query<{ id: string }>(`SELECT id FROM "user" WHERE email='t9@example.com'`)
    ).rows[0].id;
    // A password changed since.
    let token = await resetToken('t9@example.com');
    await pool.query(
      `UPDATE account SET password=$1 WHERE "userId"=$2 AND "providerId"='credential'`,
      [await hashPassword('changed-password-12'), userId]
    );
    expect((await reset(token)).status).toBe(410);
    expect(
      (
        await pool.query('SELECT superseded_at FROM email_link_tokens WHERE token_hash=$1', [
          hashSecret(token),
        ])
      ).rows[0].superseded_at
    ).not.toBeNull();
    // Offline recovery since.
    token = await resetToken('t9@example.com');
    await recoverPassword(pool, 't9@example.com', 'recovered-password-1');
    expect((await reset(token)).status).toBe(410);
    // A newer link: the older one is dead, the newer one works.
    const older = await resetToken('t9@example.com');
    const newer = await resetToken('t9@example.com');
    expect((await reset(older)).status).toBe(410);
    // The address changed since (Spaces offers no way to, but a host could by hand).
    await pool.query(`UPDATE "user" SET email='t9-moved@example.com' WHERE id=$1`, [userId]);
    expect((await reset(newer)).status).toBe(410);
    await pool.query(`UPDATE "user" SET email='t9@example.com' WHERE id=$1`, [userId]);
    // A trusted takeover since.
    token = await resetToken('t9@example.com');
    await pool.query(`UPDATE "user" SET "emailVerified"=false WHERE id=$1`, [userId]);
    identity('t9@example.com', 't9-at-issuer');
    expect((await providerSignIn(trusted, 'oidc')).location.pathname).toBe('/signed-in');
    expect((await reset(token)).status).toBe(410);
    // An expired one.
    token = await resetToken('t9@example.com');
    await pool.query(
      `UPDATE email_link_tokens SET expires_at=now()-interval '1 second' WHERE token_hash=$1`,
      [hashSecret(token)]
    );
    expect((await reset(token)).status).toBe(410);
  });

  it('refuses a squatter sign-in that began before the reset committed (T10)', async () => {
    // Purpose: fails if a password sign-in that checked the old password before the reset's
    // clean-out committed, and made its session after, keeps that session.
    const { userId } = await account('t10@example.com');
    const token = await resetToken('t10@example.com');
    const { reached, release } = holdNextSession(userId);
    const squatter = passwordSignIn('t10@example.com');
    await reached;
    const victim = await reset(token);
    expect(victim.status).toBe(200);
    release();
    const refused = await squatter;
    expect(refused.status).toBe(403);
    expect(await whoIs(cookieOf(refused))).toBeNull();
    expect(await whoIs(cookieOf(victim))).toBe('t10@example.com');
    expect(await sessionCount(userId)).toBe(1);
  });

  it('loses its own exemption once a later clean-out commits (T22)', async () => {
    // Purpose: fails if the request that cleared an account stays exempt by account id: a second
    // reset committing while the first is still making its session must refuse that session.
    const { userId } = await account('t22@example.com', { confirmed: true });
    const first = await resetToken('t22@example.com');
    const { reached, release } = holdNextSession(userId);
    const firstUse = reset(first);
    await reached;
    // The first reset committed (new password, clean-out); its session waits. A second reset:
    const second = await resetToken('t22@example.com');
    const secondUse = await reset(second, '', 'second-password-123');
    expect(secondUse.status).toBe(200);
    release();
    const firstAnswer = await firstUse;
    expect(firstAnswer.status).toBe(403);
    expect(await codeOf(firstAnswer)).toBe('SIGN_IN_REFUSED');
    expect(await whoIs(cookieOf(firstAnswer))).toBeNull();
    expect(await whoIs(cookieOf(secondUse))).toBe('t22@example.com');
    expect(await sessionCount(userId)).toBe(1);
  });

  it('refuses while the account is being erased, and clears nothing (T14)', async () => {
    // Purpose: fails if a refused account gets a mail, or a link that reached it before the
    // erasure began still clears or signs in.
    const { userId, memberId } = await account('t14@example.com');
    const token = await resetToken('t14@example.com');
    const squatter = cookieOf(await passwordSignIn('t14@example.com'));
    const access = await derivedAccess(userId, memberId);
    await pool.query(
      `INSERT INTO erasure_requests(kind,user_id,state,execute_after,started_at,next_attempt_at)
       VALUES('account',$1,'running',now(),now(),now()+interval '1 hour')`,
      [userId]
    );
    const used = await reset(token);
    expect(used.status).toBe(403);
    expect(await codeOf(used)).toBe('SIGN_IN_REFUSED');
    expect(await sessionCount(userId)).toBe(1);
    expect(await access.revoked()).toMatchObject({ grant: false, agent: false });
    expect(await verified(userId)).toBe(false);
    expect(await liveTokens(userId)).toBe(1);
    expect(squatter).not.toBe('');
    // A new request for the refused account is dropped.
    await call(on, '/api/v1/account/password-reset', 'POST', { email: 't14@example.com' });
    await deliverAll();
    const states = await pool.query<{ state: string }>(
      `SELECT state FROM email_link_requests WHERE email_hash=$1 ORDER BY created_at DESC LIMIT 1`,
      [hmacSecret('t14@example.com', SECRET)]
    );
    expect(states.rows[0].state).toBe('dropped');
  });
});

describe('a sign-in link', () => {
  it('signs in and links the held sign-in in the browser that asked', async () => {
    // Purpose: fails if the held sign-in is not linked and audited as proven by email, or the
    // browser is not signed in, on a confirmed account.
    const { userId, memberId } = await account('signin@example.com', { confirmed: true });
    const { cookie, token } = await signInToken('signin@example.com');
    const mail = lastMailTo('signin@example.com')!;
    expect(mail.subject).toBe('Your sign-in link for localhost:6481');
    const peek = await call(on, '/api/v1/email-links/peek', 'POST', { token }, cookie);
    expect(await peek.json()).toMatchObject({ kind: 'sign_in', clears: [] });
    const used = await emailSignIn(token, cookie);
    expect(used.status).toBe(200);
    expect(await used.json()).toEqual({ cleared: false, linked: 'DorkOS' });
    expect(await whoIs(cookieOf(used))).toBe('signin@example.com');
    expect(await providersOf(userId)).toEqual(['credential', 'oidc']);
    expect(await audit(memberId, 'member.sign_in_linked')).toEqual([['oidc', 'email']]);
    expect((await emailSignIn(token, cookie)).status).toBe(410);
  });

  it('on a never-confirmed account clears everything first, then confirms and links (T1)', async () => {
    // Purpose: fails if a squatter's password, provider link, session or derived credential
    // survives the victim's sign-in link.
    const { userId, memberId } = await account('t1-signin@example.com');
    await pool.query(
      `INSERT INTO account(id,"accountId","providerId","userId") VALUES($1,'gh-sq2','github',$2)`,
      [randomUUID(), userId]
    );
    const squatter = cookieOf(await passwordSignIn('t1-signin@example.com'));
    const access = await derivedAccess(userId, memberId);
    const { cookie, token } = await signInToken('t1-signin@example.com');
    const used = await emailSignIn(token, cookie);
    expect(used.status).toBe(200);
    expect(await used.json()).toEqual({ cleared: true, linked: 'DorkOS' });
    expect(await whoIs(squatter)).toBeNull();
    expect((await passwordSignIn('t1-signin@example.com')).status).toBe(401);
    expect(await providersOf(userId)).toEqual(['oidc']);
    expect(await access.revoked()).toMatchObject({ grant: true, agent: true });
    expect(await verified(userId)).toBe(true);
    expect(await audit(memberId, 'member.sign_in_linked')).toEqual([['oidc', 'email', 'cleared']]);
    expect(await audit(memberId, 'member.email_confirmed')).toEqual([['sign_in']]);
  });

  it('does nothing in another browser, or one holding another sign-in (T12)', async () => {
    // Purpose: fails if a mail scanner or a stray click (no hold, or someone else's) can use the
    // link: it must stay live, clear nothing, link nothing and sign no one in.
    const { userId } = await account('t12@example.com');
    const squatter = cookieOf(await passwordSignIn('t12@example.com'));
    const { token } = await signInToken('t12@example.com');
    await account('t12-other@example.com');
    const other = await hold('t12-other@example.com');
    for (const cookie of ['', other]) {
      const used = await emailSignIn(token, cookie);
      expect(used.status).toBe(410);
      expect(used.headers.getSetCookie().join(';')).not.toContain('session_token=');
    }
    expect(await liveTokens(userId)).toBe(1);
    expect(await whoIs(squatter)).toBe('t12@example.com');
    expect(await providersOf(userId)).toEqual(['credential']);
    expect(await verified(userId)).toBe(false);
  });

  it('refuses, changing nothing, when another account linked the held sign-in meanwhile', async () => {
    // Purpose: fails if a never-confirmed account is cleared first and only then finds its held
    // sign-in taken, which would leave it with no password, no sign-ins and no way back in.
    const { userId, memberId } = await account('taken-hold@example.com');
    const { cookie, token } = await signInToken('taken-hold@example.com', 'taken-hold-sub');
    const other = await account('taken-hold-other@example.com', { confirmed: true });
    await pool.query(
      `INSERT INTO account(id,"accountId","providerId","userId")
       VALUES($1,'taken-hold-sub','oidc',$2)`,
      [randomUUID(), other.userId]
    );
    const used = await emailSignIn(token, cookie);
    expect(used.status).toBe(409);
    expect(await codeOf(used)).toBe('ALREADY_LINKED');
    expect(used.headers.getSetCookie().join(';')).not.toContain('session_token=');
    expect(await providersOf(userId)).toEqual(['credential']);
    expect((await passwordSignIn('taken-hold@example.com')).status).toBe(200);
    expect(await verified(userId)).toBe(false);
    expect(await audit(memberId, 'member.email_confirmed')).toEqual([]);
  });

  it('cannot be asked for without a held sign-in, and never makes an account (T13)', async () => {
    // Purpose: fails if a sign-in link can be requested for an address with no account, or any
    // use creates a user.
    const before = (await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM "user"'))
      .rows[0].n;
    const asked = await call(on, '/api/v1/sign-in-link/email', 'POST', undefined, '');
    expect(asked.status).toBe(410);
    await call(on, '/api/v1/account/password-reset', 'POST', { email: 'ghost@example.com' });
    await deliverAll();
    expect(lastMailTo('ghost@example.com')).toBeNull();
    const after = (await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM "user"')).rows[0]
      .n;
    expect(after).toBe(before);
  });

  it('keeps the hold alive for the mail, but never past 25 minutes', async () => {
    // Purpose: fails if the held sign-in dies before its mail arrives, or repeated asks keep it
    // alive indefinitely; the browser's cookie must match the hold's life.
    const { userId } = await account('hold-life@example.com', { confirmed: true });
    const cookie = await hold('hold-life@example.com');
    await pool.query(
      `UPDATE pending_sign_in_links SET created_at=now()-interval '20 minutes',
         expires_at=now()+interval '1 minute' WHERE user_id=$1`,
      [userId]
    );
    const asked = await call(on, '/api/v1/sign-in-link/email', 'POST', undefined, cookie);
    expect(asked.status).toBe(202);
    const row = await pool.query<{ left: number }>(
      `SELECT extract(epoch FROM expires_at - now())::int AS left FROM pending_sign_in_links
       WHERE user_id=$1`,
      [userId]
    );
    expect(row.rows[0].left).toBeGreaterThan(4 * 60 - 5);
    expect(row.rows[0].left).toBeLessThanOrEqual(5 * 60);
    const maxAge = Number(/Max-Age=(\d+)/u.exec(asked.headers.getSetCookie().join(';'))?.[1]);
    expect(Math.abs(maxAge - row.rows[0].left)).toBeLessThanOrEqual(2);
  });

  it('races a reset on the same never-confirmed account: one wins, the other is 410 (T11)', async () => {
    // Purpose: fails if two mailbox proofs at once could both apply, each against a state the
    // other already changed.
    const { userId } = await account('t11@example.com');
    const { cookie, token: signIn } = await signInToken('t11@example.com');
    const resetLink = await resetToken('t11@example.com');
    const [a, b] = await Promise.all([reset(resetLink), emailSignIn(signIn, cookie)]);
    expect([a.status, b.status].sort()).toEqual([200, 410]);
    expect(await sessionCount(userId)).toBe(1);
    expect(await verified(userId)).toBe(true);
  });
});

describe('a confirmation link', () => {
  it('needs a session of the same account: the mailbox alone cannot confirm a squat (T2)', async () => {
    // Purpose: fails if the victim clicking the confirmation mailed for a squatter's account
    // marks it confirmed, which would stop a later trusted sign-in from clearing the squatter.
    const { userId } = await account('t2@example.com');
    const { token } = await confirmationToken('t2@example.com');
    const noSession = await confirm(token, '');
    expect(noSession.status).toBe(401);
    expect(await verified(userId)).toBe(false);
    expect(await liveTokens(userId)).toBe(1);
    // Someone else's session is refused too, and the link stays.
    const other = cookieOf(
      await call(on, '/api/auth/sign-in/email', 'POST', {
        email: 'owner@example.com',
        password: 'owner-password-1234',
      })
    );
    const wrong = await confirm(token, other);
    expect(wrong.status).toBe(403);
    expect(await liveTokens(userId)).toBe(1);
    // The trusted issuer still sees a never-confirmed account, and clears it.
    identity('t2@example.com', 't2-at-issuer');
    expect((await providerSignIn(trusted, 'oidc')).location.pathname).toBe('/signed-in');
    expect(await providersOf(userId)).toEqual(['oidc']);
  });

  it('ends the squatter who handed over the password, and asks for a new one (T2b)', async () => {
    // Purpose: fails if confirming a never-confirmed account leaves the squatter's session,
    // password, connection or agent key working, or confirms without replacing a password the
    // squatter knows.
    const { userId, memberId } = await account('t2b@example.com');
    const squatter = cookieOf(await passwordSignIn('t2b@example.com'));
    const access = await derivedAccess(userId, memberId);
    const { session, token } = await confirmationToken('t2b@example.com');
    const peek = await (
      await call(on, '/api/v1/email-links/peek', 'POST', { token }, session)
    ).json();
    expect(peek).toMatchObject({
      kind: 'email_confirmation',
      needsPassword: true,
      signedInAs: { email: 't2b@example.com', method: null },
      clears: [
        'sessions',
        'connections',
        'agent_credentials',
        'pairings',
        'invites',
        'host_api_keys',
      ],
    });
    const missing = await confirm(token, session);
    expect(missing.status).toBe(400);
    expect(await codeOf(missing)).toBe('PASSWORD_REQUIRED');
    expect(await liveTokens(userId)).toBe(1);
    const confirmed = await confirm(token, session, NEW_PASSWORD);
    expect(confirmed.status).toBe(200);
    expect(await confirmed.json()).toEqual({ confirmed: true, cleared: 'others' });
    expect(await whoIs(squatter)).toBeNull();
    expect(await whoIs(session)).toBe('t2b@example.com');
    expect((await passwordSignIn('t2b@example.com')).status).toBe(401);
    expect((await passwordSignIn('t2b@example.com', NEW_PASSWORD)).status).toBe(200);
    expect(await access.revoked()).toMatchObject({ grant: true, agent: true });
    expect(await verified(userId)).toBe(true);
    expect(await audit(memberId, 'member.email_confirmed')).toEqual([['link']]);
    expect(await audit(memberId, 'member.password_reset')).toEqual([['password', 'confirm']]);
  });

  it('on an already confirmed account confirms nothing new and clears nothing', async () => {
    // Purpose: fails if a confirmed account's other devices are signed out by a stale link.
    const { userId } = await account('confirmed-late@example.com');
    const other = cookieOf(await passwordSignIn('confirmed-late@example.com'));
    const { session, token } = await confirmationToken('confirmed-late@example.com');
    await pool.query(`UPDATE "user" SET "emailVerified"=true WHERE id=$1`, [userId]);
    const used = await confirm(token, session);
    expect(await used.json()).toEqual({ confirmed: true, cleared: 'none' });
    expect(await whoIs(other)).toBe('confirmed-late@example.com');
  });
});

describe('Better Auth', () => {
  it('cannot confirm an email on a provider sign-in (T21)', async () => {
    // Purpose: fails if Better Auth's own "verified provider email" update confirms a squatted
    // account with no clean-out, so the next reset would keep the squatter's provider link.
    const { userId } = await account('t21@example.com');
    github = { id: 2121, email: 't21@example.com', verified: true };
    await pool.query(
      `INSERT INTO account(id,"accountId","providerId","userId") VALUES($1,'2121','github',$2)`,
      [randomUUID(), userId]
    );
    const signedIn = await providerSignIn(on, 'github');
    expect(signedIn.location.pathname).toBe('/signed-in');
    expect(await verified(userId)).toBe(false);
    const token = await resetToken('t21@example.com');
    expect(await (await reset(token)).json()).toEqual({ cleared: 'everything' });
    expect(await providersOf(userId)).toEqual(['credential']);
  });

  it('leaves the links live when their pages are fetched, and its own reset path is gone (T8)', async () => {
    // Purpose: fails if a scanner's GET of a mailed link (with or without the fragment) uses it,
    // or if Better Auth's own token reset page is reachable.
    const { userId } = await account('t8@example.com', { confirmed: true });
    const token = await resetToken('t8@example.com');
    for (const page of ['/reset-password', '/email-sign-in', '/confirm-email'])
      for (const suffix of ['', `#${token}`, `?token=${token}`])
        await fetch(`${on}${page}${suffix}`, { redirect: 'manual' });
    const own = await fetch(`${on}/api/auth/reset-password/${token}?callbackURL=/`, {
      redirect: 'manual',
    });
    expect(own.status).toBe(404);
    expect(await liveTokens(userId)).toBe(1);
    expect((await reset(token)).status).toBe(200);
  });

  it('answers 404 on every switched-off path (T17), and refuses a cross-site use (T18)', async () => {
    // Purpose: fails if any of Better Auth's own reset, verify, change-email or verify-password
    // paths is reachable over HTTP, or a link can be used from another site.
    for (const path of [
      '/api/auth/request-password-reset',
      '/api/auth/reset-password',
      '/api/auth/reset-password/x',
      '/api/auth/send-verification-email',
      '/api/auth/verify-email',
      '/api/auth/change-email',
      '/api/auth/verify-password',
    ]) {
      const posted = await call(on, path, 'POST', { email: 'owner@example.com', password: 'x' });
      expect(posted.status, path).toBe(404);
    }
    expect(
      (await fetch(`${on}/api/auth/verify-email?token=x`, { redirect: 'manual' })).status
    ).toBe(404);
    const { userId } = await account('t18@example.com', { confirmed: true });
    const token = await resetToken('t18@example.com');
    const crossSite = await call(
      on,
      '/api/auth/email-link/reset-password',
      'POST',
      {
        token,
        newPassword: NEW_PASSWORD,
      },
      '',
      { origin: 'https://evil.example' }
    );
    expect(crossSite.status).toBe(403);
    expect(await liveTokens(userId)).toBe(1);
  });
});

describe('the held sign-in cookie on HTTPS (T25)', () => {
  it('is __Host- prefixed, host-only and Secure, and the old name is never read', async () => {
    // Purpose: fails if a sibling subdomain could plant the held-sign-in cookie (cookie tossing)
    // and have a victim's sign-in link complete the attacker's held identity.
    const { userId } = await account('t25@example.com', { confirmed: true });
    const raw = 'h'.repeat(43);
    await pool.query(
      `INSERT INTO pending_sign_in_links(token_hash,user_id,provider_id,account_id,expires_at)
       VALUES($1,$2,'github','gh-t25',now()+interval '5 minutes')`,
      [hashSecret(raw), userId]
    );
    const signed = signValue(raw, SECRET);
    const plain = `community_pending_link=${signed}`;
    const hosted = `__Host-community_pending_link=${signed}`;
    expect(
      (await call(secure, '/api/v1/sign-in-link/email', 'POST', undefined, plain)).status
    ).toBe(410);
    const asked = await call(secure, '/api/v1/sign-in-link/email', 'POST', undefined, hosted);
    expect(asked.status).toBe(202);
    const set = asked.headers
      .getSetCookie()
      .find((c) => c.startsWith('__Host-community_pending_link='))!;
    expect(set).toMatch(/; Path=\//u);
    expect(set).toMatch(/; Secure/u);
    expect(set).not.toMatch(/Domain=/iu);
    await deliverAll();
    const token = lastMailTo('t25@example.com')!.token!;
    const used = await call(secure, '/api/auth/email-link/sign-in', 'POST', { token }, plain);
    expect(used.status).toBe(410);
    expect(await liveTokens(userId)).toBe(1);
  });
});

describe('the offline commands', () => {
  it('recovery deletes outstanding links, and still runs before migration 0032', async () => {
    // Purpose: fails if a link minted before offline recovery still works after it, or if
    // recovery from a new image breaks on a database that has not applied 0032 yet.
    const { userId } = await account('offline@example.com', { confirmed: true });
    await resetToken('offline@example.com');
    expect(await liveTokens(userId)).toBe(1);
    await recoverPassword(pool, 'offline@example.com', 'recovered-password-1');
    expect(
      (await pool.query('SELECT 1 FROM email_link_tokens WHERE user_id=$1', [userId])).rowCount
    ).toBe(0);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('ALTER TABLE email_link_tokens RENAME TO email_link_tokens_away');
      await client.query('COMMIT');
      await recoverPassword(pool, 'offline@example.com', 'recovered-password-2');
    } finally {
      await client.query('ALTER TABLE email_link_tokens_away RENAME TO email_link_tokens');
      client.release();
    }
  });

  it('release-unverified-account deletes an account that has request and link rows', async () => {
    // Purpose: fails if the new tables' foreign keys block releasing a squatted address.
    const userId = randomUUID();
    await pool.query('INSERT INTO "user"(id,name,email,"emailVerified") VALUES($1,$2,$3,false)', [
      userId,
      'Loose',
      'loose@example.com',
    ]);
    await pool.query(
      `INSERT INTO email_link_requests(kind,email_hash,user_id,state)
       VALUES('email_confirmation',$1,$2,'pending')`,
      [hmacSecret('loose@example.com', SECRET), userId]
    );
    await pool.query(
      `INSERT INTO email_link_tokens(token_hash,kind,user_id,request_id,outbox_id,email_hash,expires_at)
       VALUES($1,'email_confirmation',$2,gen_random_uuid(),gen_random_uuid(),$3,now()+interval '1 day')`,
      ['4'.repeat(64), userId, hmacSecret('loose@example.com', SECRET)]
    );
    await releaseUnverifiedAccount(pool, 'loose@example.com');
    expect((await pool.query('SELECT 1 FROM "user" WHERE id=$1', [userId])).rowCount).toBe(0);
  });
});
