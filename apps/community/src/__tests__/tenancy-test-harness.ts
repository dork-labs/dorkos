import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serve } from '@hono/node-server';
import { Pool } from 'pg';
import { createCommunityApp } from '../app.js';
import { parseConfig, type CommunityConfig } from '../config.js';
import { migrate } from '../migrate.js';
import { FileSystemBlobStore, type BlobStore } from '../storage/index.js';
import { bootstrapFirstHost, responseCookies } from './bootstrap-test-helper.js';

/** The password every account in a tenancy fixture signs up with. */
export const TENANCY_PASSWORD = 'password1234';

/** Upper bound for one HTTP call, so a lock cycle fails the test instead of hanging it. */
const REQUEST_TIMEOUT_MS = 20_000;

/** One real Community server on its own database, storage folder, and pool. */
export interface TenancyHarness {
  config: CommunityConfig;
  pool: Pool;
  blobStore: BlobStore;
  baseUrl: string;
  /** Issue one HTTP request against the running server. */
  call(
    path: string,
    init?: {
      method?: string;
      body?: unknown;
      cookie?: string;
      bearer?: string;
      headers?: Record<string, string>;
      raw?: BodyInit;
    }
  ): Promise<Response>;
  /** Stop the server, close the pool, and drop the database and storage folder. */
  close(): Promise<void>;
}

/** A host account's cookie and its membership in one community. */
export interface TenancyMember {
  cookie: string;
  memberId: string;
}

/**
 * Start a Community server on a fresh database, the way `main.ts` assembles it,
 * with rate limits raised so concurrency, not a limiter, decides every outcome.
 */
export async function startTenancyHarness(label: string): Promise<TenancyHarness> {
  const adminUrl = process.env.COMMUNITY_TEST_DATABASE_URL;
  if (!adminUrl) throw new Error('COMMUNITY_TEST_DATABASE_URL is required for tenancy tests');
  const admin = new Pool({ connectionString: adminUrl });
  const dbName = `community_${label}_${randomUUID().replaceAll('-', '')}`;
  const dbUrl = new URL(adminUrl);
  dbUrl.pathname = `/${dbName}`;
  const storagePath = await mkdtemp(join(tmpdir(), `community-${label}-`));
  await admin.query(`CREATE DATABASE ${dbName}`);
  await migrate(dbUrl.toString());
  // Several pool clients, so concurrent requests really run in parallel transactions.
  const pool = new Pool({ connectionString: dbUrl.toString(), max: 10 });
  const config = parseConfig({
    COMMUNITY_DATABASE_URL: dbUrl.toString(),
    COMMUNITY_AUTH_SECRET: 'a'.repeat(32),
    COMMUNITY_INVITE_SECRET: 'b'.repeat(32),
    COMMUNITY_BOOTSTRAP_SECRET: 'c'.repeat(32),
    COMMUNITY_PUBLIC_URL: 'http://localhost:6481',
    COMMUNITY_STORAGE_PATH: storagePath,
    COMMUNITY_POSTS_PER_TEN_MINUTES: 1000,
    COMMUNITY_SIGNUP_ATTEMPTS_PER_MINUTE: 100,
    COMMUNITY_BOOTSTRAP_ATTEMPTS_PER_MINUTE: 100,
    COMMUNITY_INVITE_PREVIEW_ATTEMPTS_PER_MINUTE: 100,
    COMMUNITY_PAIRING_ATTEMPTS_PER_MINUTE: 100,
  });
  const blobStore = new FileSystemBlobStore(storagePath);
  const app = createCommunityApp({ config, pool, blobStore });
  const server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' });
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing HTTP address');
  const baseUrl = `http://127.0.0.1:${address.port}`;

  return {
    config,
    pool,
    blobStore,
    baseUrl,
    call(path, init = {}) {
      const headers: Record<string, string> = { ...init.headers };
      if (init.cookie) headers.cookie = init.cookie;
      if (init.bearer) headers.authorization = `Bearer ${init.bearer}`;
      // Browser calls carry the public origin; bearer (local install) calls carry none.
      // An explicit empty origin models a local install's server-side call.
      if (!init.bearer && !('origin' in headers)) headers.origin = config.publicUrl;
      if (headers.origin === '') delete headers.origin;
      let body: BodyInit | undefined = init.raw;
      if (init.body !== undefined) {
        headers['content-type'] = 'application/json';
        body = JSON.stringify(init.body);
      }
      return fetch(`${baseUrl}${path}`, {
        method: init.method ?? (body === undefined ? 'GET' : 'POST'),
        headers,
        body,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    },
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await pool.end();
      await admin.query(`DROP DATABASE IF EXISTS ${dbName}`);
      await admin.end();
      await rm(storagePath, { recursive: true, force: true });
    },
  };
}

/** Throw with the response body when a fixture step does not return the expected status. */
export async function expectStatus(response: Response, status: number, step: string) {
  if (response.status !== status) {
    throw new Error(`${step}: expected ${status}, got ${response.status} ${await response.text()}`);
  }
  return response;
}

/** Complete first-install bootstrap; the first account becomes host operator and owner. */
export async function bootstrapHost(h: TenancyHarness, name: string, email: string) {
  return bootstrapFirstHost(
    (path, body, cookie) => h.call(path, { body, cookie: cookie || undefined }),
    {
      secret: h.config.bootstrapSecret,
      accountName: name,
      email,
      password: TENANCY_PASSWORD,
      communityName: `${name} Community`,
    }
  );
}

async function signUp(h: TenancyHarness, name: string, email: string, grant: string) {
  const response = await expectStatus(
    await h.call('/api/auth/sign-up/email', {
      body: { name, email, password: TENANCY_PASSWORD },
      cookie: grant,
    }),
    200,
    `sign up ${email}`
  );
  return `${grant}; ${responseCookies(response)}`;
}

/** Create a pending-owner community through the host API and return its private claim. */
export async function createPendingCommunity(
  h: TenancyHarness,
  operatorCookie: string,
  name: string
): Promise<{ communityId: string; token: string }> {
  const response = await expectStatus(
    await h.call('/api/v1/host/communities', {
      cookie: operatorCookie,
      body: {
        idempotencyKey: `create-${name}`,
        name,
        description: null,
        admissionPolicy: 'invite_only',
      },
    }),
    201,
    `create ${name}`
  );
  const body = await response.json();
  return { communityId: body.community.id, token: body.ownerClaimToken };
}

/** Start an owner claim: returns the bootstrap cookie a claimant must present. */
export async function preflightOwnerClaim(h: TenancyHarness, token: string): Promise<string> {
  const response = await expectStatus(
    await h.call('/api/v1/owner-claims/preflight', { body: { token } }),
    200,
    'owner-claim preflight'
  );
  return responseCookies(response);
}

/** Claim a pending community as a brand-new account. */
export async function claimAsNewAccount(
  h: TenancyHarness,
  token: string,
  name: string,
  email: string
): Promise<TenancyMember> {
  const cookie = await signUp(h, name, email, await preflightOwnerClaim(h, token));
  const claimed = await expectStatus(
    await h.call('/api/v1/owner-claims/claim', { cookie, body: {} }),
    200,
    `claim by ${email}`
  );
  return { cookie, memberId: (await claimed.json()).memberId };
}

/**
 * Admit an account into one community through a real invitation. A brand-new
 * account signs up with the admission cookie; an existing host account binds
 * its current session, which is how one account comes to belong to several.
 */
export async function admit(
  h: TenancyHarness,
  communityId: string,
  inviterCookie: string,
  account: { cookie: string } | { name: string; email: string }
): Promise<TenancyMember> {
  const base = `/api/v1/communities/${communityId}`;
  const issued = await expectStatus(
    await h.call(`${base}/invites`, { cookie: inviterCookie, body: { seats: 1 } }),
    201,
    'issue invite'
  );
  const { token } = await issued.json();
  const preflight = await expectStatus(
    await h.call(`${base}/invites/preflight`, { body: { token } }),
    200,
    'invite preflight'
  );
  const admission = responseCookies(preflight);
  const cookie =
    'cookie' in account
      ? `${account.cookie
          .split('; ')
          .filter((part) => !part.startsWith('community_admission='))
          .join('; ')}; ${admission}`
      : await signUp(h, account.name, account.email, admission);
  await expectStatus(await h.call(`${base}/invites/bind`, { cookie, body: {} }), 200, 'bind');
  const redeemed = await expectStatus(
    await h.call(`${base}/invites/redeem`, { cookie, body: {} }),
    200,
    'redeem'
  );
  return { cookie, memberId: (await redeemed.json()).memberId };
}

/** Create a public channel and join each listed member to it. */
export async function createChannel(
  h: TenancyHarness,
  communityId: string,
  ownerCookie: string,
  name: string,
  joiners: string[] = []
): Promise<string> {
  const base = `/api/v1/communities/${communityId}`;
  const created = await expectStatus(
    await h.call(`${base}/channels`, { cookie: ownerCookie, body: { name, visibility: 'public' } }),
    201,
    `create channel ${name}`
  );
  const channelId = (await created.json()).channel.id as string;
  for (const cookie of joiners) {
    await expectStatus(
      await h.call(`${base}/channels/${channelId}/join`, { cookie, body: {} }),
      200,
      `join ${name}`
    );
  }
  return channelId;
}

/**
 * Pair a local install with one community through the browser-approval flow and
 * return its personal connection bearer. `approverCookie` approves as that
 * account's membership in the same community.
 */
export async function pairInstall(
  h: TenancyHarness,
  communityId: string,
  approverCookie: string,
  scopes: string[] = ['read', 'post', 'enroll-agent']
): Promise<string> {
  const base = `/api/v1/communities/${communityId}`;
  const local = { origin: '' };
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const started = await expectStatus(
    await h.call(`${base}/pairings/start`, {
      headers: local,
      body: { installName: `Install ${communityId.slice(0, 8)}`, challenge, scopes },
    }),
    201,
    'pairing start'
  );
  const { pairingId } = await started.json();
  await expectStatus(
    await h.call(`${base}/pairings/approve`, { cookie: approverCookie, body: { pairingId } }),
    200,
    'pairing approve'
  );
  const polled = await expectStatus(
    await h.call(`${base}/pairings/poll`, { headers: local, body: { pairingId, verifier } }),
    200,
    'pairing poll'
  );
  const { code } = await polled.json();
  const exchanged = await expectStatus(
    await h.call(`${base}/pairings/exchange`, {
      headers: local,
      body: { pairingId, code, verifier },
    }),
    200,
    'pairing exchange'
  );
  return (await exchanged.json()).token as string;
}
