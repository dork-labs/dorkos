import { createHash, randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { serve } from '@hono/node-server';
import { hashPassword } from 'better-auth/crypto';
import { migrate } from '../migrate.js';
import { createCommunityApp } from '../app.js';
import { parseConfig } from '../config.js';
import { signInLinkComposers } from '../sign-in/linked.js';
import { hashSecret, signValue } from '../security.js';
import { bootstrapFirstHost } from './bootstrap-test-helper.js';
import { startFakeIssuer, type FakeIssuer } from './fake-oidc-issuer.js';

// specs/community-sign-in-linking (DOR-2709): a provider sign-in whose email matches an existing
// account links to it, but only through one gate. The host's trusted OIDC issuer links at once
// (clearing a never-confirmed account first); every other provider, Google and GitHub always,
// waits for the account's own password. Real Postgres, a fake OIDC issuer over real HTTP, and a
// stand-in for GitHub's two endpoints; no test reaches a real provider.
const adminUrl = process.env.COMMUNITY_TEST_DATABASE_URL;
if (!adminUrl) throw new Error('COMMUNITY_TEST_DATABASE_URL is required for sign-in link tests');
const admin = new Pool({ connectionString: adminUrl });
const dbName = `community_link_${randomUUID().replaceAll('-', '')}`;
const dbUrl = new URL(adminUrl);
dbUrl.pathname = `/${dbName}`;
const PUBLIC_URL = 'http://localhost:6481';
const PASSWORD = 'old-password-1234';
const baseEnv = {
  COMMUNITY_DATABASE_URL: dbUrl.toString(),
  COMMUNITY_AUTH_SECRET: 'a'.repeat(32),
  COMMUNITY_INVITE_SECRET: 'b'.repeat(32),
  COMMUNITY_BOOTSTRAP_SECRET: 'c'.repeat(32),
  COMMUNITY_PUBLIC_URL: PUBLIC_URL,
  COMMUNITY_STORAGE_PATH: '/tmp/community-link-test-blobs',
  COMMUNITY_INVITE_PREVIEW_ATTEMPTS_PER_MINUTE: 100,
  COMMUNITY_SIGNUP_ATTEMPTS_PER_MINUTE: 100,
  COMMUNITY_REAUTH_ATTEMPTS_PER_MINUTE: 3,
  COMMUNITY_GITHUB_CLIENT_ID: 'github-client',
  COMMUNITY_GITHUB_CLIENT_SECRET: 'github-secret',
  COMMUNITY_OIDC_LABEL: 'DorkOS',
  COMMUNITY_OIDC_MARK: 'dorkos',
};

let issuer: FakeIssuer;
let pool: Pool;
let communityId: string;
let ownerCookie: string;
const servers: { close: () => Promise<void> }[] = [];
/** The host trusts its issuer, and has mail set up. */
let trusted: string;
/** The same host without the trust setting. */
let untrusted: string;
const raceHooks: {
  afterSignInLinkPasswordCheck?: () => Promise<void>;
  afterSignInLinked?: () => Promise<void>;
} = {};

/** Who GitHub's stand-in vouches for on the next sign-in. */
let github = { id: 4242, email: 'person@example.com', verified: true };

async function serveApp(env: Record<string, unknown>): Promise<string> {
  const config = parseConfig({ ...baseEnv, ...env });
  const app = createCommunityApp({
    config,
    pool,
    noticeComposers: signInLinkComposers(config),
    hooks: {
      afterSignInLinkPasswordCheck: () =>
        raceHooks.afterSignInLinkPasswordCheck?.() ?? Promise.resolve(),
      afterSignInLinked: () => raceHooks.afterSignInLinked?.() ?? Promise.resolve(),
    },
  });
  const server = serve({ fetch: app.fetch, port: 0 });
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing HTTP address');
  servers.push({ close: () => new Promise<void>((resolve) => server.close(() => resolve())) });
  return `http://localhost:${address.port}`;
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
    // GitHub sends the browser back with a code and the state it was given.
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
async function whoIs(url: string, cookie: string): Promise<string | null> {
  const session = await call(url, '/api/auth/get-session', 'GET', undefined, cookie);
  const body = (await session.json()) as { user?: { email: string } } | null;
  return body?.user?.email ?? null;
}

async function passwordSignIn(email: string, password = PASSWORD) {
  return call(trusted, '/api/auth/sign-in/email', 'POST', { email, password });
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
  const handle = `m${userId.slice(0, 8)}`;
  const member = await pool.query<{ id: string }>(
    `INSERT INTO members(community_id,user_id,display_name,handle,role)
     VALUES($1,$2,$3,$3,'member') RETURNING id`,
    [communityId, userId, handle]
  );
  return { userId, memberId: member.rows[0].id };
}

async function providersOf(userId: string) {
  const { rows } = await pool.query<{ providerId: string }>(
    'SELECT "providerId" FROM account WHERE "userId"=$1 ORDER BY "providerId"',
    [userId]
  );
  return rows.map((row) => row.providerId);
}

async function pendingRows(userId: string) {
  const { rows } = await pool.query<{ provider_id: string; consumed_at: Date | null }>(
    'SELECT provider_id,consumed_at FROM pending_sign_in_links WHERE user_id=$1',
    [userId]
  );
  return rows;
}

async function audit(memberId: string, action: string) {
  const { rows } = await pool.query<{ changed_fields: string[] }>(
    'SELECT changed_fields FROM audit_events WHERE subject_id=$1 AND action=$2 ORDER BY created_at',
    [memberId, action]
  );
  return rows.map((row) => row.changed_fields);
}

const identity = (email: string, sub = `sub-${email}`, verified = true) => {
  issuer.identity = { sub, email, email_verified: verified, name: email.split('@')[0] };
};

/** Answer GitHub's token and profile endpoints; everything else goes to the network as usual. */
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

beforeAll(async () => {
  issuer = await startFakeIssuer();
  await admin.query(`CREATE DATABASE ${dbName}`);
  await migrate(dbUrl.toString());
  pool = new Pool({ connectionString: dbUrl.toString() });
  const oidc = {
    COMMUNITY_OIDC_ISSUER_URL: issuer.issuer,
    COMMUNITY_OIDC_CLIENT_ID: issuer.clientId,
    COMMUNITY_OIDC_CLIENT_SECRET: issuer.clientSecret,
  };
  trusted = await serveApp({
    ...oidc,
    COMMUNITY_OIDC_LINK_VERIFIED_EMAIL: '1',
    COMMUNITY_SMTP_URL: 'smtps://smtp.example.com',
    COMMUNITY_MAIL_FROM: 'space@example.com',
  });
  untrusted = await serveApp(oidc);
  const setup = await bootstrapFirstHost(
    (path, body, cookie) => call(trusted, path, 'POST', body, cookie),
    {
      secret: baseEnv.COMMUNITY_BOOTSTRAP_SECRET,
      accountName: 'Owner',
      email: 'owner@example.com',
      password: 'owner-password-1234',
      communityName: 'Link test',
      channelName: 'General',
    }
  );
  ownerCookie = setup.cookie;
  communityId = setup.communityId;
  stubGitHub();
});

afterEach(() => {
  delete raceHooks.afterSignInLinkPasswordCheck;
  delete raceHooks.afterSignInLinked;
});

afterAll(async () => {
  vi.unstubAllGlobals();
  for (const server of servers) await server.close();
  await issuer?.close();
  await pool?.end();
  await admin.query(`DROP DATABASE IF EXISTS ${dbName}`);
  await admin.end();
});

describe('a trusted issuer with a verified email', () => {
  it('links to an account whose email was confirmed, keeps its password, and signs in', async () => {
    // Purpose: fails if the trusted path still refuses (the old `account_not_linked` dead end),
    // links without signing in, or clears an account whose owner had proven the email.
    const { userId, memberId } = await account('confirmed@example.com', { confirmed: true });
    identity('confirmed@example.com');
    const result = await providerSignIn(trusted, 'oidc');
    expect(result.location.pathname).toBe('/signed-in');
    expect(await whoIs(trusted, result.cookie)).toBe('confirmed@example.com');
    expect(await providersOf(userId)).toEqual(['credential', 'oidc']);
    expect((await passwordSignIn('confirmed@example.com')).status).toBe(200);
    expect(await audit(memberId, 'member.sign_in_linked')).toEqual([['oidc']]);
    // The page is told once what happened, by name.
    const notice = await call(
      trusted,
      '/api/v1/sign-in-link/notice',
      'GET',
      undefined,
      result.cookie
    );
    expect(await notice.json()).toEqual({ state: 'linked', provider: 'DorkOS' });
    const again = await call(
      trusted,
      '/api/v1/sign-in-link/notice',
      'GET',
      undefined,
      cookies(result.cookie, cookieOf(notice))
    );
    expect(await again.json()).toEqual({ state: 'none', provider: null });
  });

  it('clears every old way into a never-confirmed account first, then links, confirms and signs in', async () => {
    // Purpose: fails if anything from before the link (password, sessions, other sign-in links,
    // connection grants, pairings, agent credentials, server keys, invitation links, waiting
    // links) still works after a trusted sign-in takes over an account nobody proved, or if the
    // change is not audited and mailed.
    const { userId, memberId } = await account('unconfirmed@example.com');
    const old = cookieOf(await passwordSignIn('unconfirmed@example.com'));
    expect(await whoIs(trusted, old)).toBe('unconfirmed@example.com');
    await pool.query(
      `INSERT INTO account(id,"accountId","providerId","userId") VALUES($1,'gh-old','github',$2),
         ($3,'google-old','google',$2)`,
      [randomUUID(), userId, randomUUID()]
    );
    await pool.query(
      `INSERT INTO connection_grants(community_id,member_id,token_hash,scopes)
       VALUES($1,$2,$3,'{read,post}')`,
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
       VALUES('Squatter key','dkh_squat1',$1,'{communities:read}','browser',$2) RETURNING id`,
      [createHash('sha256').update(userId).digest('hex'), userId]
    );
    const invite = await pool.query<{ id: string }>(
      `INSERT INTO invites(community_id,issuer_member_id,token_hash,seat_limit,expires_at)
       VALUES($1,$2,$3,1,now()+interval '1 day') RETURNING id`,
      [communityId, memberId, `invite-${userId}`]
    );
    await pool.query(
      `INSERT INTO pending_sign_in_links(token_hash,user_id,provider_id,account_id,expires_at)
       VALUES($1,$2,'google','google-x',now()+interval '5 minutes')`,
      [hashSecret(`pending-${userId}`), userId]
    );

    identity('unconfirmed@example.com');
    const result = await providerSignIn(trusted, 'oidc');
    expect(result.location.pathname).toBe('/signed-in');
    expect(await whoIs(trusted, result.cookie)).toBe('unconfirmed@example.com');
    expect(await providersOf(userId)).toEqual(['oidc']);
    expect(await whoIs(trusted, old)).toBeNull();
    expect((await passwordSignIn('unconfirmed@example.com')).status).toBe(401);
    const revoked = async (sql: string, id: string) =>
      (await pool.query<{ at: Date | null }>(sql, [id])).rows[0].at;
    expect(
      await revoked('SELECT revoked_at AS at FROM connection_grants WHERE member_id=$1', memberId)
    ).not.toBeNull();
    expect(
      await revoked(
        'SELECT cancelled_at AS at FROM connection_pairings WHERE member_id=$1',
        memberId
      )
    ).not.toBeNull();
    expect(
      await revoked(
        'SELECT revoked_at AS at FROM agent_credentials WHERE agent_id=$1',
        agent.rows[0].id
      )
    ).not.toBeNull();
    expect(
      await revoked('SELECT revoked_at AS at FROM host_api_keys WHERE id=$1', key.rows[0].id)
    ).not.toBeNull();
    expect(
      await revoked('SELECT revoked_at AS at FROM invites WHERE id=$1', invite.rows[0].id)
    ).not.toBeNull();
    expect(await pendingRows(userId)).toEqual([]);
    expect(
      (await pool.query('SELECT "emailVerified" FROM "user" WHERE id=$1', [userId])).rows[0]
    ).toEqual({ emailVerified: true });
    expect(await audit(memberId, 'member.sign_in_links_removed')).toEqual([['github', 'google']]);
    expect(await audit(memberId, 'member.sign_in_linked')).toEqual([['oidc', 'cleared']]);
    // One notice, about that audit event, to this account.
    const queued = await pool.query(
      `SELECT o.kind,o.recipient_user_id FROM notice_outbox o
       JOIN audit_events e ON e.id=o.subject_id WHERE e.subject_id=$1`,
      [memberId]
    );
    expect(queued.rows).toEqual([{ kind: 'account.sign_in_linked', recipient_user_id: userId }]);
    const notice = await call(
      trusted,
      '/api/v1/sign-in-link/notice',
      'GET',
      undefined,
      result.cookie
    );
    expect(await notice.json()).toEqual({ state: 'linkedCleared', provider: 'DorkOS' });
  });

  it('ends a squatter who made an account with someone else’s email first', async () => {
    // Purpose: fails if a stranger who signed up with the victim's email (never confirmed) keeps
    // a working session or password once the victim signs in through the trusted issuer.
    const issued = await call(trusted, '/api/v1/invites', 'POST', { seats: 1 }, ownerCookie);
    const { token } = (await issued.json()) as { token: string };
    const preflight = await call(trusted, '/api/v1/invites/preflight', 'POST', { token });
    const signUp = await call(
      trusted,
      '/api/auth/sign-up/email',
      'POST',
      { name: 'Stranger', email: 'victim@example.com', password: 'stranger-password-1' },
      cookieOf(preflight)
    );
    expect(signUp.status).toBe(200);
    const stranger = cookies(cookieOf(preflight), cookieOf(signUp));
    expect(await whoIs(trusted, stranger)).toBe('victim@example.com');

    identity('victim@example.com', 'victim-at-issuer');
    const victim = await providerSignIn(trusted, 'oidc');
    expect(victim.location.pathname).toBe('/signed-in');
    expect(await whoIs(trusted, victim.cookie)).toBe('victim@example.com');
    expect(await whoIs(trusted, stranger)).toBeNull();
    expect((await passwordSignIn('victim@example.com', 'stranger-password-1')).status).toBe(401);
  });

  it('still admits an invited person signing up through the issuer, with no waiting link', async () => {
    // Purpose: fails if the gate treats a sign-up's own account row as a link (review finding
    // 1): an invited provider sign-up must keep working, and leave nothing waiting.
    const issued = await call(trusted, '/api/v1/invites', 'POST', { seats: 1 }, ownerCookie);
    const { token } = (await issued.json()) as { token: string };
    const preflight = await call(trusted, '/api/v1/invites/preflight', 'POST', { token });
    identity('newcomer@example.com');
    const result = await providerSignIn(trusted, 'oidc', cookieOf(preflight));
    expect(result.location.pathname).toBe('/signed-in');
    const userId = (
      await pool.query<{ id: string }>(`SELECT id FROM "user" WHERE email='newcomer@example.com'`)
    ).rows[0].id;
    expect(await providersOf(userId)).toEqual(['oidc']);
    expect(await pendingRows(userId)).toEqual([]);
    // Without an invitation a new person is still refused.
    identity('stranger@example.com');
    expect((await providerSignIn(trusted, 'oidc')).error).toBe('invitation_required');
  });

  it('refuses before clearing or linking anything while the account is being erased or closed', async () => {
    // Purpose: fails if a refused account is cleared or linked first, or if the refusal shows
    // as a JSON body instead of landing on the sign-in page (review finding 5), on either path.
    for (const [url, refuse, message] of [
      [trusted, 'erasure', 'This account is being deleted.'],
      [untrusted, 'closure', 'This account has been closed.'],
    ] as const) {
      const email = `refused-${refuse}@example.com`;
      const { userId } = await account(email);
      if (refuse === 'erasure')
        await pool.query(
          `INSERT INTO erasure_requests(kind,user_id,state,execute_after,started_at,next_attempt_at)
           VALUES('account',$1,'running',now(),now(),now()+interval '1 hour')`,
          [userId]
        );
      else
        await pool.query(
          `INSERT INTO account_closures(user_id,reason,reference,person_requested,
             requested_by_host_actor,idempotency_key,payload_hash)
           VALUES($1,'other','ref-1',false,'person:host',$2,$3)`,
          [userId, randomUUID(), 'f'.repeat(64)]
        );
      identity(email);
      const result = await providerSignIn(url, 'oidc');
      expect(result.location.pathname, refuse).toBe('/sign-in-failed');
      expect(result.error, refuse).toBe('sign_in_refused');
      expect(result.location.searchParams.get('error_description'), refuse).toBe(message);
      expect(await providersOf(userId), refuse).toEqual(['credential']);
      expect(await pendingRows(userId), refuse).toEqual([]);
    }
  });
});

describe('any other sign-in waits for the account password', () => {
  it('holds an untrusted issuer: no link, no session, one waiting link', async () => {
    // Purpose: the takeover test. Fails if whoever controls an account at an issuer the host did
    // not trust, with a matching verified email, gets the Community account or a session.
    const { userId } = await account('takeover@example.com', { confirmed: true });
    identity('takeover@example.com', 'attacker-at-issuer');
    const result = await providerSignIn(untrusted, 'oidc');
    expect(result.location.pathname).toBe('/sign-in-failed');
    expect(result.error).toBe('link_needs_password');
    expect(await whoIs(untrusted, result.cookie)).toBeNull();
    expect(await providersOf(userId)).toEqual(['credential']);
    expect(await pendingRows(userId)).toEqual([{ provider_id: 'oidc', consumed_at: null }]);
    const notice = await call(
      untrusted,
      '/api/v1/sign-in-link/notice',
      'GET',
      undefined,
      result.cookie
    );
    expect(await notice.json()).toEqual({ state: 'pending', provider: 'DorkOS' });
  });

  it('never clears a never-confirmed account for an untrusted issuer', async () => {
    // Purpose: fails if the clean-out runs on the password path, which would let any issuer the
    // host did not trust wipe an account's password and sessions.
    const { userId } = await account('unconfirmed-untrusted@example.com');
    const old = cookieOf(await passwordSignIn('unconfirmed-untrusted@example.com'));
    identity('unconfirmed-untrusted@example.com');
    const result = await providerSignIn(untrusted, 'oidc');
    expect(result.error).toBe('link_needs_password');
    expect(await providersOf(userId)).toEqual(['credential']);
    expect(await whoIs(trusted, old)).toBe('unconfirmed-untrusted@example.com');
    expect(
      (await pool.query('SELECT "emailVerified" FROM "user" WHERE id=$1', [userId])).rows[0]
    ).toEqual({ emailVerified: false });
  });

  it('never auto-links GitHub, even where the host trusts its issuer', async () => {
    // Purpose: fails if trust for the host's own issuer leaks to Google or GitHub, or if a
    // GitHub sign-in can take an account without its password.
    const { userId } = await account('github-person@example.com');
    github = { id: 9001, email: 'github-person@example.com', verified: true };
    const result = await providerSignIn(trusted, 'github');
    expect(result.error).toBe('link_needs_password');
    expect(await whoIs(trusted, result.cookie)).toBeNull();
    expect(await providersOf(userId)).toEqual(['credential']);
    // The account's own password links it, and signs in.
    const linked = await call(
      trusted,
      '/api/v1/sign-in-link',
      'POST',
      { password: PASSWORD },
      result.cookie
    );
    expect(linked.status).toBe(200);
    expect(await linked.json()).toEqual({ linked: true });
    expect(await providersOf(userId)).toEqual(['credential', 'github']);
    expect(await whoIs(trusted, cookies(result.cookie, cookieOf(linked)))).toBe(
      'github-person@example.com'
    );
    // Next time the same GitHub account simply signs in.
    expect((await providerSignIn(trusted, 'github')).location.pathname).toBe('/signed-in');
  });

  it('never links an identity whose email the provider did not verify, and holds nothing', async () => {
    // Purpose: fails if an unverified email can link or start a waiting link, on either host,
    // through the issuer or through GitHub (Better Auth's own `account_not_linked` refusal).
    const { userId } = await account('unverified@example.com');
    for (const url of [trusted, untrusted]) {
      identity('unverified@example.com', 'unverified-sub', false);
      expect((await providerSignIn(url, 'oidc')).error).toBe('unable_to_get_user_info');
      github = { id: 777, email: 'unverified@example.com', verified: false };
      expect((await providerSignIn(url, 'github')).error).toBe('account_not_linked');
    }
    expect(await providersOf(userId)).toEqual(['credential']);
    expect(await pendingRows(userId)).toEqual([]);
  });

  it('treats a sign-in in a browser already signed in as that account as an implicit link', async () => {
    // Purpose: fails if a session cookie alone counts as the Settings link (review finding 2):
    // only a link started from Settings carries the account in Better Auth's OAuth state.
    const { userId } = await account('signed-in@example.com', { confirmed: true });
    const session = cookieOf(await passwordSignIn('signed-in@example.com'));
    identity('signed-in@example.com');
    const result = await providerSignIn(untrusted, 'oidc', session);
    expect(result.error).toBe('link_needs_password');
    expect(await providersOf(userId)).toEqual(['credential']);
    // Linking from Settings, as that account, still works.
    const start = await call(
      untrusted,
      '/api/auth/link-social',
      'POST',
      { provider: 'oidc', callbackURL: '/linked', errorCallbackURL: '/link-failed' },
      session
    );
    const { url } = (await start.json()) as { url: string };
    const back = new URL((await fetch(url, { redirect: 'manual' })).headers.get('location')!);
    const callback = await call(
      untrusted,
      `${back.pathname}${back.search}`,
      'GET',
      undefined,
      cookies(session, cookieOf(start))
    );
    expect(new URL(callback.headers.get('location')!, PUBLIC_URL).pathname).toBe('/linked');
    expect(await providersOf(userId)).toEqual(['credential', 'oidc']);
  });
});

describe('linking with the account password', () => {
  /** Hold one untrusted sign-in for a fresh account and return the browser's cookie. */
  async function held(email: string, options: { password?: string | null } = {}) {
    const made = await account(email, options);
    identity(email);
    const result = await providerSignIn(untrusted, 'oidc');
    expect(result.error).toBe('link_needs_password');
    return { ...made, cookie: result.cookie };
  }
  const link = (cookie: string, password = PASSWORD) =>
    call(untrusted, '/api/v1/sign-in-link', 'POST', { password }, cookie);

  it('links and signs in with the right password, once', async () => {
    // Purpose: fails if the right password does not link and sign in, if the waiting link can be
    // replayed, or if the link is not audited.
    const { userId, memberId, cookie } = await held('right@example.com');
    const linked = await link(cookie);
    expect(linked.status).toBe(200);
    expect(await whoIs(untrusted, cookies(cookie, cookieOf(linked)))).toBe('right@example.com');
    expect(await providersOf(userId)).toEqual(['credential', 'oidc']);
    expect(await audit(memberId, 'member.sign_in_linked')).toEqual([['oidc', 'password']]);
    const replay = await link(cookie);
    expect(replay.status).toBe(410);
    expect(((await replay.json()) as { code: string }).code).toBe('LINK_EXPIRED');
  });

  it('refuses a wrong password, then stops at the shared guess budget and ends the waiting link', async () => {
    // Purpose: fails if a wrong password links, if guesses here do not share the account's one
    // budget (`reauth-account:<id>`), or if a spent budget leaves the waiting link usable.
    const { userId, cookie } = await held('wrong@example.com');
    for (let attempt = 0; attempt < 3; attempt++) {
      const wrong = await link(cookie, 'not-the-password');
      expect(wrong.status).toBe(403);
      expect(await wrong.json()).toEqual({
        code: 'REAUTH_FAILED',
        message: 'That password is not right.',
      });
    }
    const limited = await link(cookie);
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toMatch(/^\d+$/u);
    expect(await providersOf(userId)).toEqual(['credential']);
    expect((await pendingRows(userId))[0].consumed_at).not.toBeNull();
    // The same budget guards every other password check for this account.
    const session = cookieOf(await passwordSignIn('wrong@example.com'));
    const leave = await call(
      untrusted,
      '/api/v1/me/leave',
      'POST',
      { password: PASSWORD, communityName: 'Link test' },
      session
    );
    expect(leave.status).toBe(429);
  });

  it('refuses a forged, missing or expired waiting link', async () => {
    // Purpose: fails if a cookie the server did not sign, or a link past its 10 minutes, links.
    const { userId, cookie } = await held('expired@example.com');
    const forged = `community_pending_link=${signValue('made-up', 'x'.repeat(32))}`;
    for (const bad of ['', forged, 'community_pending_link=unsigned']) {
      const refused = await link(bad);
      expect(refused.status).toBe(410);
    }
    await pool.query(
      `UPDATE pending_sign_in_links SET expires_at=now()-interval '1 second' WHERE user_id=$1`,
      [userId]
    );
    const late = await link(cookie);
    expect(late.status).toBe(410);
    expect(await providersOf(userId)).toEqual(['credential']);
  });

  it('tells an account with no password how to get help, and spends nothing', async () => {
    // Purpose: fails if a password-less account is told its password is wrong, or if asking
    // spends the account's guess budget.
    const { cookie } = await held('no-password@example.com', { password: null });
    for (let attempt = 0; attempt < 5; attempt++) {
      const refused = await link(cookie);
      expect(refused.status).toBe(403);
      expect(((await refused.json()) as { code: string }).code).toBe('PASSWORD_REQUIRED');
    }
  });

  it('lets exactly one of two accounts link the same identity', async () => {
    // Purpose: fails if one outside identity can be linked to two accounts: the unique key on
    // (providerId, accountId) decides, and the loser hears it is already linked.
    const first = await held('first@example.com');
    const second = await held('second@example.com');
    await pool.query(
      `UPDATE pending_sign_in_links SET account_id='shared-identity' WHERE user_id=ANY($1::text[])`,
      [[first.userId, second.userId]]
    );
    const [one, two] = await Promise.all([link(first.cookie), link(second.cookie)]);
    expect([one.status, two.status].sort()).toEqual([200, 409]);
    const loser = one.status === 409 ? one : two;
    expect(((await loser.json()) as { code: string }).code).toBe('ALREADY_LINKED');
    expect(
      (
        await pool.query(
          `SELECT count(*)::int AS n FROM account WHERE "accountId"='shared-identity'`
        )
      ).rows[0].n
    ).toBe(1);
  });

  it('refuses when the password changes between the check and the link', async () => {
    // Purpose: fails if a password checked a moment ago links after it was changed.
    const { userId, cookie } = await held('changed@example.com');
    raceHooks.afterSignInLinkPasswordCheck = async () => {
      await pool.query(
        `UPDATE account SET password=$1 WHERE "userId"=$2 AND "providerId"='credential'`,
        [await hashPassword('a-new-password-12'), userId]
      );
    };
    const refused = await link(cookie);
    expect(refused.status).toBe(410);
    expect(await providersOf(userId)).toEqual(['credential']);
  });

  it('keeps the link but says so when the account is closed before its session is made', async () => {
    // Purpose: fails if a session is made for an account refused after the link committed, or
    // if the person is not told what happened.
    const { userId, cookie } = await held('closed-late@example.com');
    raceHooks.afterSignInLinked = async () => {
      await pool.query(
        `INSERT INTO account_closures(user_id,reason,reference,person_requested,
           requested_by_host_actor,idempotency_key,payload_hash)
         VALUES($1,'other','ref-2',false,'person:host',$2,$3)`,
        [userId, randomUUID(), 'e'.repeat(64)]
      );
    };
    const refused = await link(cookie);
    expect(refused.status).toBe(403);
    expect(((await refused.json()) as { message: string }).message).toBe(
      'The sign-in is linked, but you could not be signed in. Sign in again.'
    );
    expect(refused.headers.getSetCookie().some((value) => value.includes('session_token'))).toBe(
      false
    );
    expect(await providersOf(userId)).toEqual(['credential', 'oidc']);
  });

  it('cancels a waiting link', async () => {
    // Purpose: fails if "Not you? Cancel" leaves the waiting link usable.
    const { userId, cookie } = await held('cancel@example.com');
    const cancelled = await call(untrusted, '/api/v1/sign-in-link', 'DELETE', undefined, cookie);
    expect(cancelled.status).toBe(204);
    expect((await link(cookie)).status).toBe(410);
    expect(await providersOf(userId)).toEqual(['credential']);
  });
});
