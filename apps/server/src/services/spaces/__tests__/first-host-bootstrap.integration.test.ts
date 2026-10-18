import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { afterAll, expect, it } from 'vitest';
import { serve } from '@hono/node-server';
import { Pool } from 'pg';
import { createCommunityApp } from '../app.js';
import { parseConfig } from '../config.js';
import { migrate } from '../migrate.js';

const adminUrl = process.env.COMMUNITY_TEST_DATABASE_URL;
if (!adminUrl) throw new Error('COMMUNITY_TEST_DATABASE_URL is required for bootstrap tests');
const admin = new Pool({ connectionString: adminUrl });

function cookies(response: Response): string {
  return response.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .join('; ');
}

async function withHost(
  run: (host: {
    pool: Pool;
    post: (path: string, body: unknown, cookie?: string) => Promise<Response>;
    failBeforeChannel: (value: boolean) => void;
  }) => Promise<void>
) {
  const dbName = `community_first_host_${randomUUID().replaceAll('-', '')}`;
  const dbUrl = new URL(adminUrl!);
  dbUrl.pathname = `/${dbName}`;
  const storagePath = `/tmp/${dbName}-blobs`;
  await admin.query(`CREATE DATABASE ${dbName}`);
  await migrate(dbUrl.toString());
  const pool = new Pool({ connectionString: dbUrl.toString() });
  let shouldFailBeforeChannel = false;
  const config = parseConfig({
    COMMUNITY_DATABASE_URL: dbUrl.toString(),
    COMMUNITY_AUTH_SECRET: 'a'.repeat(32),
    COMMUNITY_INVITE_SECRET: 'b'.repeat(32),
    COMMUNITY_BOOTSTRAP_SECRET: 'c'.repeat(32),
    COMMUNITY_PUBLIC_URL: 'http://localhost:6481',
    COMMUNITY_STORAGE_PATH: storagePath,
  });
  const app = createCommunityApp({
    config,
    pool,
    hooks: {
      beforeBootstrapChannelCreate: async () => {
        if (shouldFailBeforeChannel) throw new Error('injected bootstrap failure');
      },
    },
  });
  const server = serve({ fetch: app.fetch, port: 0 });
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing bootstrap server address');
  const baseUrl = `http://localhost:${address.port}`;
  const post = (path: string, body: unknown, cookie = '') =>
    fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: config.publicUrl,
        ...(cookie ? { cookie } : {}),
      },
      body: JSON.stringify(body),
    });
  try {
    await run({
      pool,
      post,
      failBeforeChannel: (value) => {
        shouldFailBeforeChannel = value;
      },
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await pool.end();
    await admin.query(`DROP DATABASE IF EXISTS ${dbName}`);
    await rm(storagePath, { recursive: true, force: true });
  }
}

afterAll(async () => {
  await admin.end();
});

const setup = {
  secret: 'c'.repeat(32),
  accountName: 'First Owner',
  email: 'owner@first-host.test',
  password: 'password1234',
  communityName: 'First Community',
  channelName: 'general',
};

it('creates the first account, authority, tenant, membership, and channel atomically', () =>
  withHost(async ({ pool, post }) => {
    const preflight = await post('/api/v1/bootstrap/preflight', { secret: setup.secret });
    expect(preflight.status).toBe(200);
    const grant = cookies(preflight);

    const legacySignup = await post(
      '/api/auth/sign-up/email',
      { name: setup.accountName, email: setup.email, password: setup.password },
      grant
    );
    expect(legacySignup.status).toBe(403);

    const completed = await post('/api/v1/bootstrap/complete', setup, grant);
    expect(completed.status).toBe(201);
    const body = await completed.json();
    const rows = await pool.query<{ users: number; accounts: number; operators: number }>(
      `SELECT
         (SELECT count(*)::int FROM "user") AS users,
         (SELECT count(*)::int FROM account) AS accounts,
         (SELECT count(*)::int FROM host_operators WHERE revoked_at IS NULL) AS operators`
    );
    expect(rows.rows[0]).toEqual({ users: 1, accounts: 1, operators: 1 });
    expect(
      await pool.query(
        `SELECT c.id,c.lifecycle,m.id AS member_id,m.role,ch.id AS channel_id,ch.name,
                count(cm.member_id)::int AS joined
         FROM communities c JOIN members m ON m.community_id=c.id
         JOIN channels ch ON ch.community_id=c.id
         LEFT JOIN channel_members cm ON cm.community_id=c.id AND cm.channel_id=ch.id
         GROUP BY c.id,m.id,ch.id`
      )
    ).toMatchObject({
      rows: [
        {
          id: body.community.id,
          lifecycle: 'active',
          member_id: body.memberId,
          role: 'owner',
          channel_id: body.channelId,
          name: 'general',
          joined: 1,
        },
      ],
    });

    const signIn = await post('/api/auth/sign-in/email', {
      email: setup.email,
      password: setup.password,
    });
    expect(signIn.status).toBe(200);
    expect(cookies(signIn)).toContain('better-auth.session_token=');
  }));

it('rolls every first-host row back and leaves the grant retryable after a late failure', () =>
  withHost(async ({ pool, post, failBeforeChannel }) => {
    const preflight = await post('/api/v1/bootstrap/preflight', { secret: setup.secret });
    const grant = cookies(preflight);
    failBeforeChannel(true);
    expect((await post('/api/v1/bootstrap/complete', setup, grant)).status).toBe(503);
    const empty = await pool.query<{ total: number; live_grants: number }>(
      `SELECT
         ((SELECT count(*) FROM "user") + (SELECT count(*) FROM account) +
          (SELECT count(*) FROM host_operators) + (SELECT count(*) FROM communities) +
          (SELECT count(*) FROM members) + (SELECT count(*) FROM channels))::int AS total,
         (SELECT count(*)::int FROM bootstrap_grants WHERE consumed_at IS NULL) AS live_grants`
    );
    expect(empty.rows[0]).toEqual({ total: 0, live_grants: 1 });

    failBeforeChannel(false);
    expect((await post('/api/v1/bootstrap/complete', setup, grant)).status).toBe(201);
  }));

it('lets one concurrent completion win without leaving a second account or tenant', () =>
  withHost(async ({ pool, post }) => {
    const preflight = await post('/api/v1/bootstrap/preflight', { secret: setup.secret });
    const grant = cookies(preflight);
    const contender = { ...setup, email: 'other@first-host.test', accountName: 'Other Owner' };
    const responses = await Promise.all([
      post('/api/v1/bootstrap/complete', setup, grant),
      post('/api/v1/bootstrap/complete', contender, grant),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([201, 403]);
    const counts = await pool.query<{ users: number; communities: number; channels: number }>(
      `SELECT
         (SELECT count(*)::int FROM "user") AS users,
         (SELECT count(*)::int FROM communities) AS communities,
         (SELECT count(*)::int FROM channels) AS channels`
    );
    expect(counts.rows[0]).toEqual({ users: 1, communities: 1, channels: 1 });
  }));
