import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { serve } from '@hono/node-server';
import { Pool } from 'pg';
import { createCommunityApp } from '../app.js';
import { parseConfig } from '../config.js';
import { migrate } from '../migrate.js';
import { bootstrapFirstHost } from './bootstrap-test-helper.js';

const adminUrl = process.env.COMMUNITY_TEST_DATABASE_URL;
if (!adminUrl) throw new Error('COMMUNITY_TEST_DATABASE_URL is required for owner claim tests');
const admin = new Pool({ connectionString: adminUrl });
const dbName = `community_owner_claim_locks_${randomUUID().replaceAll('-', '')}`;
const dbUrl = new URL(adminUrl);
dbUrl.pathname = `/${dbName}`;
let pool: Pool;
let server: ReturnType<typeof serve>;
let baseUrl = '';
let storagePath = '';
let operatorCookie = '';
const password = 'password1234';

function cookieOf(response: Response): string {
  return response.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .join('; ');
}

async function jsonRequest(
  path: string,
  body: unknown,
  cookie = operatorCookie
): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: {
      origin: 'http://localhost:6481',
      'content-type': 'application/json',
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify(body),
  });
}

async function signup(name: string, email: string, grant = ''): Promise<string> {
  const response = await jsonRequest('/api/auth/sign-up/email', { name, email, password }, grant);
  expect(response.status).toBe(200);
  return `${grant}; ${cookieOf(response)}`;
}

async function createPendingCommunity(label: string): Promise<{
  communityId: string;
  grantId: string;
  token: string;
}> {
  const response = await jsonRequest('/api/v1/host/communities', {
    idempotencyKey: `owner-claim-lock-${label}`,
    name: `Claim lock ${label}`,
    description: null,
    admissionPolicy: 'invite_only',
  });
  expect(response.status).toBe(201);
  const body = await response.json();
  return {
    communityId: body.community.id,
    grantId: body.ownerClaimGrantId,
    token: body.ownerClaimToken,
  };
}

async function claimantCookie(token: string, label: string): Promise<string> {
  const preflight = await jsonRequest('/api/v1/owner-claims/preflight', { token }, '');
  expect(preflight.status).toBe(200);
  return signup(`Claimant ${label}`, `claimant-${label}@locks.test`, cookieOf(preflight));
}

async function waitForBlockedQuery(fragment: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const result = await pool.query<{ blocked: boolean }>(
      `SELECT EXISTS(
         SELECT 1 FROM pg_stat_activity
         WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE $1
       ) AS blocked`,
      [`%${fragment}%`]
    );
    if (result.rows[0].blocked) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Request did not block on ${fragment}`);
}

async function bounded(response: Promise<Response>): Promise<Response> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    response,
    new Promise<never>((_, reject) => {
      timeout = setTimeout(() => reject(new Error('Concurrent owner claim timed out')), 8_000);
    }),
  ]).finally(() => {
    if (timeout) clearTimeout(timeout);
  });
}

async function endPool(poolToClose: Pool): Promise<void> {
  const expectedRemovals = poolToClose.totalCount;
  if (expectedRemovals === 0) {
    await poolToClose.end();
    return;
  }
  let removed = 0;
  let resolveRemoved!: () => void;
  const allRemoved = new Promise<void>((resolve) => {
    resolveRemoved = resolve;
  });
  const onRemove = () => {
    removed += 1;
    if (removed === expectedRemovals) {
      poolToClose.off('remove', onRemove);
      resolveRemoved();
    }
  };
  poolToClose.on('remove', onRemove);
  await Promise.all([poolToClose.end(), allRemoved]);
}

beforeAll(async () => {
  storagePath = await mkdtemp(join(tmpdir(), 'community-owner-claim-locks-'));
  await admin.query(`CREATE DATABASE ${dbName}`);
  await migrate(dbUrl.toString());
  pool = new Pool({ connectionString: dbUrl.toString() });
  const config = parseConfig({
    COMMUNITY_DATABASE_URL: dbUrl.toString(),
    COMMUNITY_AUTH_SECRET: 'a'.repeat(32),
    COMMUNITY_INVITE_SECRET: 'b'.repeat(32),
    COMMUNITY_BOOTSTRAP_SECRET: 'c'.repeat(32),
    COMMUNITY_PUBLIC_URL: 'http://localhost:6481',
    COMMUNITY_STORAGE_PATH: storagePath,
    COMMUNITY_SIGNUP_ATTEMPTS_PER_MINUTE: 100,
  });
  const app = createCommunityApp({ config, pool });
  server = serve({ fetch: app.fetch, port: 0 });
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing HTTP address');
  baseUrl = `http://localhost:${address.port}`;

  const setup = await bootstrapFirstHost((path, body, cookie) => jsonRequest(path, body, cookie), {
    secret: config.bootstrapSecret,
    accountName: 'Operator',
    email: 'operator@locks.test',
    password: 'password1234',
    communityName: 'First Community',
  });
  operatorCookie = setup.cookie;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server?.close(() => resolve()));
  if (pool) await endPool(pool);
  await admin.query(`DROP DATABASE IF EXISTS ${dbName}`);
  await admin.end();
  if (storagePath) await rm(storagePath, { recursive: true, force: true });
});

for (const mutation of ['reissue', 'revoke'] as const) {
  it(`serializes owner claim with concurrent ${mutation} in community-before-grant order`, async () => {
    const pending = await createPendingCommunity(mutation);
    const claimant = await claimantCookie(pending.token, mutation);
    const blocker = await pool.connect();
    const probe = await pool.connect();
    try {
      await blocker.query('BEGIN');
      await blocker.query('SELECT 1 FROM communities WHERE id=$1 FOR UPDATE', [
        pending.communityId,
      ]);
      const claim = bounded(jsonRequest('/api/v1/owner-claims/claim', {}, claimant));
      await waitForBlockedQuery('FOR UPDATE OF c');

      // A claim blocked on the community must not hold the grant. The old
      // grant-first order fails this NOWAIT probe and forms G→C against the
      // host mutation's C→G order.
      await probe.query('BEGIN');
      const grantProbe = await probe.query(
        'SELECT 1 FROM bootstrap_grants WHERE id=$1 FOR UPDATE NOWAIT',
        [pending.grantId]
      );
      expect(grantProbe.rowCount).toBe(1);
      await probe.query('ROLLBACK');

      const mutationPath =
        mutation === 'reissue'
          ? `/api/v1/host/communities/${pending.communityId}/owner-claims/reissue`
          : `/api/v1/host/communities/${pending.communityId}/owner-claims/${pending.grantId}/revoke`;
      const mutate = bounded(jsonRequest(mutationPath, {}));
      await waitForBlockedQuery('SELECT lifecycle FROM communities WHERE id=$1 FOR UPDATE');
      await blocker.query('COMMIT');

      const [claimResponse, mutationResponse] = await Promise.all([claim, mutate]);
      const statuses = [claimResponse.status, mutationResponse.status];
      expect(
        mutation === 'reissue'
          ? [
              [200, 409],
              [403, 200],
            ]
          : [
              [200, 409],
              [403, 204],
            ]
      ).toContainEqual(statuses);
      const claimBody = await claimResponse.text();
      const mutationBody = await mutationResponse.text();
      expect(claimBody).not.toContain(pending.token);
      expect(mutationBody).not.toContain(pending.token);

      const state = (
        await pool.query<{ lifecycle: string; owners: number }>(
          `SELECT c.lifecycle,
             (SELECT count(*)::int FROM members m
              WHERE m.community_id=c.id AND m.role='owner' AND m.active) AS owners
           FROM communities c WHERE c.id=$1`,
          [pending.communityId]
        )
      ).rows[0];
      expect(state).toEqual(
        claimResponse.status === 200
          ? { lifecycle: 'active', owners: 1 }
          : { lifecycle: 'pending_owner', owners: 0 }
      );
    } finally {
      await blocker.query('ROLLBACK');
      blocker.release();
      await probe.query('ROLLBACK');
      probe.release();
    }
  });
}
