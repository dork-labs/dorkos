import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { serve } from '@hono/node-server';
import { migrate } from '../migrate.js';
import { createCommunityApp } from '../app.js';
import { parseConfig } from '../config.js';
import { sweepExpiredAdmissions } from '../routes/invites.js';
import { bootstrapFirstHost } from './bootstrap-test-helper.js';

const adminUrl = process.env.COMMUNITY_TEST_DATABASE_URL;
if (!adminUrl) throw new Error('COMMUNITY_TEST_DATABASE_URL is required for admission HTTP tests');
const admin = new Pool({ connectionString: adminUrl });
const dbName = `community_admission_${randomUUID().replaceAll('-', '')}`;
const dbUrl = new URL(adminUrl);
dbUrl.pathname = `/${dbName}`;
const config = parseConfig({
  COMMUNITY_DATABASE_URL: dbUrl.toString(),
  COMMUNITY_AUTH_SECRET: 'a'.repeat(32),
  COMMUNITY_INVITE_SECRET: 'b'.repeat(32),
  COMMUNITY_BOOTSTRAP_SECRET: 'c'.repeat(32),
  COMMUNITY_PUBLIC_URL: 'http://localhost:6481',
  COMMUNITY_STORAGE_PATH: '/tmp/community-admission-test-blobs',
  COMMUNITY_AGENTS_PER_OWNER: 2,
  COMMUNITY_POSTS_PER_TEN_MINUTES: 3,
  COMMUNITY_SIGNUP_ATTEMPTS_PER_MINUTE: 100,
  COMMUNITY_PAIRING_ATTEMPTS_PER_MINUTE: 100,
});
let server: ReturnType<typeof serve>;
let pool: Pool;
let baseUrl: string;
let ownerCookie: string;
let ownerId: string;
let communityId: string;
let channelId: string;
let admittedCookie: string;
let admittedId: string;
let agentToken = '';
let ownerGrantToken = '';
const sseText = new WeakMap<ReadableStreamDefaultReader<Uint8Array>, string>();

async function nextSse(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<{ type: string }> {
  let buffer = sseText.get(reader) ?? '';
  for (;;) {
    const boundary = buffer.indexOf('\n\n');
    if (boundary >= 0) {
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      sseText.set(reader, buffer);
      const data = frame.split('\n').find((line) => line.startsWith('data: '));
      if (data) return JSON.parse(data.slice(6));
      continue;
    }
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const chunk = await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error('SSE timed out')), 5_000);
      }),
    ]).finally(() => {
      if (timeout) clearTimeout(timeout);
    });
    if (chunk.done) throw new Error('SSE closed before an event');
    buffer += new TextDecoder().decode(chunk.value);
  }
}

async function joinWithInvite(name: string, email: string) {
  const issued = await call('/api/v1/invites', 'POST', { seats: 1 }, ownerCookie);
  expect(issued.status).toBe(201);
  const { token } = await issued.json();
  const preflight = await call('/api/v1/invites/preflight', 'POST', { token });
  expect(preflight.status).toBe(200);
  const cookie = await signup(name, email, cookieOf(preflight));
  expect((await call('/api/v1/invites/bind', 'POST', {}, cookie)).status).toBe(200);
  const admitted = await call('/api/v1/invites/redeem', 'POST', {}, cookie);
  expect(admitted.status).toBe(200);
  return { cookie, id: (await admitted.json()).memberId };
}

function cookieOf(response: Response) {
  return response.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .join('; ');
}

function withAdmission(sessionCookie: string, response: Response) {
  return `${sessionCookie
    .split('; ')
    .filter((part) => !part.startsWith('community_admission='))
    .join('; ')}; ${cookieOf(response)}`;
}

async function call(path: string, method: string, body?: unknown, cookie?: string) {
  return fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      origin: config.publicUrl,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(cookie ? { cookie } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function localCall(path: string, body: unknown) {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function bearerCall(path: string, method: string, token: string, body?: unknown) {
  return fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function waitForBlockedQuery(fragment: string) {
  for (let attempt = 0; attempt < 100; attempt++) {
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

async function signup(name: string, email: string, grant: string) {
  const result = await call(
    '/api/auth/sign-up/email',
    'POST',
    {
      name,
      email,
      password: 'password1234',
    },
    grant
  );
  expect(result.status).toBe(200);
  return `${grant}; ${cookieOf(result)}`;
}

beforeAll(async () => {
  await admin.query(`CREATE DATABASE ${dbName}`);
  await migrate(dbUrl.toString());
  pool = new Pool({ connectionString: dbUrl.toString() });
  const app = createCommunityApp({ config, pool });
  server = serve({ fetch: app.fetch, port: 0 });
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing HTTP address');
  baseUrl = `http://localhost:${address.port}`;
  const setup = await bootstrapFirstHost((path, body, cookie) => call(path, 'POST', body, cookie), {
    secret: config.bootstrapSecret,
    accountName: 'Owner',
    email: 'owner@admission.test',
    password: 'password1234',
    communityName: 'Admission test',
    channelName: 'General',
  });
  ownerCookie = setup.cookie;
  communityId = setup.communityId;
  ownerId = setup.memberId;
  channelId = setup.channelId;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server?.close(() => resolve()));
  await pool?.end();
  await admin.query(`DROP DATABASE IF EXISTS ${dbName}`);
  await admin.end();
});

describe('signed admission over real HTTP and Postgres', () => {
  it('limits invite discovery by both socket peer and invite identity', async () => {
    const limitedConfig = {
      ...config,
      limits: { ...config.limits, invitePreviewAttemptsPerMinute: 1 },
    };
    const limitedApp = createCommunityApp({
      config: limitedConfig,
      pool,
      hooks: { invitePreviewPeer: (c) => c.req.header('x-test-peer') ?? 'unknown' },
    });
    const limitedServer = serve({ fetch: limitedApp.fetch, port: 0 });
    await new Promise<void>((resolve) => limitedServer.once('listening', resolve));
    const address = limitedServer.address();
    if (!address || typeof address === 'string') throw new Error('Missing limited HTTP address');
    const limitedUrl = `http://localhost:${address.port}`;
    const preview = (peer: string, token: string) =>
      fetch(`${limitedUrl}/api/v1/invites/preview`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: config.publicUrl,
          'x-test-peer': peer,
        },
        body: JSON.stringify({ token }),
      });
    try {
      expect((await preview('peer-a', 'unknown-token')).status).toBe(403);
      expect((await preview('peer-b', 'unknown-token')).status).toBe(429);
      expect((await preview('peer-c', 'another-token')).status).toBe(403);
      expect((await preview('peer-c', 'third-token')).status).toBe(429);
    } finally {
      await new Promise<void>((resolve) => limitedServer.close(() => resolve()));
    }
  });

  it('admits exactly one contender for the final seat and leaves the other unadmitted', async () => {
    expect(
      (
        await call('/api/auth/sign-up/email', 'POST', {
          name: 'No Invite',
          email: 'none@admission.test',
          password: 'password1234',
        })
      ).status
    ).toBe(403);
    const issued = await call('/api/v1/invites', 'POST', { channelId, seats: 1 }, ownerCookie);
    expect(issued.status).toBe(201);
    const { token, invite } = await issued.json();
    expect((await call('/api/v1/invites/preview', 'POST', { token })).status).toBe(200);
    const a = await call('/api/v1/invites/preflight', 'POST', { token });
    const b = await call('/api/v1/invites/preflight', 'POST', { token });
    expect([a.status, b.status]).toEqual([200, 200]);
    const aCookie = await signup('Alice', 'alice@admission.test', cookieOf(a));
    const bCookie = await signup('Bob', 'bob@admission.test', cookieOf(b));
    expect((await call('/api/v1/invites/bind', 'POST', {}, aCookie)).status).toBe(200);
    expect((await call('/api/v1/invites/bind', 'POST', {}, bCookie)).status).toBe(200);
    const results = await Promise.all([
      call('/api/v1/invites/redeem', 'POST', {}, aCookie),
      call('/api/v1/invites/redeem', 'POST', {}, bCookie),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual([200, 409]);
    const winner = results.findIndex((result) => result.status === 200);
    admittedCookie = winner === 0 ? aCookie : bCookie;
    admittedId = (await results[winner].json()).memberId;
    const useCount = await pool.query('SELECT use_count FROM invites WHERE id=$1', [invite.id]);
    expect(useCount.rows[0].use_count).toBe(1);
    expect(
      (
        await pool.query('SELECT count(*)::int AS n FROM invite_uses WHERE invite_id=$1', [
          invite.id,
        ])
      ).rows[0].n
    ).toBe(1);
    expect(
      (
        await pool.query('SELECT count(*)::int AS n FROM members WHERE id<>$1 AND active', [
          ownerId,
        ])
      ).rows[0].n
    ).toBe(1);
    expect((await call('/api/v1/invites/redeem', 'POST', {}, admittedCookie)).status).toBe(200);
    expect(
      (await pool.query('SELECT use_count FROM invites WHERE id=$1', [invite.id])).rows[0].use_count
    ).toBe(1);
    const loserCookie = winner === 0 ? bCookie : aCookie;
    expect((await call('/api/v1/channels', 'GET', undefined, loserCookie)).status).toBe(403);
    expect((await call('/api/v1/me', 'GET', undefined, loserCookie)).status).toBe(403);
    const recovery = await call('/api/v1/invites', 'POST', {}, ownerCookie);
    const recoveryToken = (await recovery.json()).token;
    const recoveryPreflight = await call('/api/v1/invites/preflight', 'POST', {
      token: recoveryToken,
    });
    const recoveryCookie = `${loserCookie
      .split('; ')
      .filter((part) => !part.startsWith('community_admission='))
      .join('; ')}; ${cookieOf(recoveryPreflight)}`;
    expect((await call('/api/v1/invites/bind', 'POST', {}, recoveryCookie)).status).toBe(200);
    expect((await call('/api/v1/invites/redeem', 'POST', {}, recoveryCookie)).status).toBe(200);
    expect((await call('/api/v1/invites/preview', 'POST', { token: `${token}x` })).status).toBe(
      403
    );
  });

  it('settles a repeated same-account invitation transaction without consuming another seat', async () => {
    const issued = await call('/api/v1/invites', 'POST', { seats: 2 }, ownerCookie);
    expect(issued.status).toBe(201);
    const { token, invite } = await issued.json();

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const preflight = await call('/api/v1/invites/preflight', 'POST', { token });
      expect(preflight.status).toBe(200);
      const admissionCookie = withAdmission(admittedCookie, preflight);
      expect((await call('/api/v1/invites/bind', 'POST', {}, admissionCookie)).status).toBe(200);
      const redeemed = await call('/api/v1/invites/redeem', 'POST', {}, admissionCookie);
      expect(redeemed.status).toBe(200);
      expect(await redeemed.json()).toEqual({ memberId: admittedId });
    }

    expect(
      (
        await pool.query(
          `SELECT i.use_count,
                  count(DISTINCT p.id)::int AS admissions,
                  count(DISTINCT r.admission_id)::int AS receipts,
                  bool_and(p.consumed_at IS NOT NULL) AS consumed
           FROM invites i
           JOIN pending_admissions p ON p.invite_id=i.id AND p.community_id=i.community_id
           LEFT JOIN admission_receipts r
             ON r.admission_id=p.id AND r.community_id=p.community_id
           WHERE i.id=$1 GROUP BY i.use_count`,
          [invite.id]
        )
      ).rows[0]
    ).toEqual({ use_count: 1, admissions: 2, receipts: 2, consumed: true });
  });

  it('binds one browser transaction to one account and adds a channel for an active member', async () => {
    const channelResponse = await call(
      '/api/v1/channels',
      'POST',
      { name: `Invite channel ${randomUUID().slice(0, 8)}`, visibility: 'private' },
      ownerCookie
    );
    expect(channelResponse.status).toBe(201);
    const invitedChannelId = (await channelResponse.json()).channel.id;
    const issued = await call(
      '/api/v1/invites',
      'POST',
      { channelId: invitedChannelId, seats: 1 },
      ownerCookie
    );
    const { token, invite } = await issued.json();
    const preflight = await call('/api/v1/invites/preflight', 'POST', { token });
    expect(preflight.status).toBe(200);
    expect(await preflight.clone().json()).toMatchObject({
      granted: true,
      communityName: 'Admission test',
      channelName: expect.stringContaining('Invite channel'),
    });
    const memberAdmission = withAdmission(admittedCookie, preflight);
    expect((await call('/api/v1/invites/bind', 'POST', {}, memberAdmission)).status).toBe(200);
    const switchedAccount = withAdmission(ownerCookie, preflight);
    expect((await call('/api/v1/invites/bind', 'POST', {}, switchedAccount)).status).toBe(403);
    const redeemed = await call('/api/v1/invites/redeem', 'POST', {}, memberAdmission);
    expect(redeemed.status).toBe(200);
    expect((await redeemed.json()).memberId).toBe(admittedId);
    expect((await call('/api/v1/invites/redeem', 'POST', {}, memberAdmission)).status).toBe(200);
    expect(
      (
        await pool.query(
          'SELECT count(*)::int AS n FROM channel_members WHERE community_id=(SELECT community_id FROM members WHERE id=$1) AND member_id=$1 AND channel_id=$2',
          [admittedId, invitedChannelId]
        )
      ).rows[0].n
    ).toBe(1);
    expect(
      (await pool.query('SELECT use_count FROM invites WHERE id=$1', [invite.id])).rows[0]
    ).toEqual({ use_count: 1 });
  });

  it('invalidates old receipts on removal and reactivates only through a new scoped invite', async () => {
    const issued = await call('/api/v1/invites', 'POST', { seats: 1 }, ownerCookie);
    const { token, invite } = await issued.json();
    const preflight = await call('/api/v1/invites/preflight', 'POST', { token });
    const cookie = await signup(
      'Receipt member',
      'receipt-member@admission.test',
      cookieOf(preflight)
    );
    expect((await call('/api/v1/invites/bind', 'POST', {}, cookie)).status).toBe(200);
    const redeemed = await call('/api/v1/invites/redeem', 'POST', {}, cookie);
    const memberId = (await redeemed.json()).memberId;
    const communityId = (
      await pool.query<{ community_id: string }>('SELECT community_id FROM members WHERE id=$1', [
        memberId,
      ])
    ).rows[0].community_id;
    await pool.query(
      `INSERT INTO channel_members(community_id,channel_id,member_id) VALUES($1,$2,$3)
       ON CONFLICT DO NOTHING`,
      [communityId, channelId, memberId]
    );
    await pool.query(
      `INSERT INTO read_cursors(community_id,member_id,channel_id,seq)
       VALUES($1,$2,$3,0)`,
      [communityId, memberId, channelId]
    );
    await pool.query(
      `INSERT INTO connection_pairings(community_id,verifier_hash,install_name,scopes,member_id,expires_at,approved_at)
       VALUES($1,$2,'Receipt install','{read}',$3,now()+interval '10 minutes',now())`,
      [communityId, randomBytes(32).toString('hex'), memberId]
    );
    await pool.query(
      `INSERT INTO connection_grants(community_id,member_id,token_hash,scopes,install_name)
       VALUES($1,$2,$3,'{read}','Receipt install')`,
      [communityId, memberId, createHash('sha256').update(randomBytes(32)).digest('hex')]
    );
    expect(
      (await call(`/api/v1/members/${memberId}`, 'DELETE', undefined, ownerCookie)).status
    ).toBe(204);
    expect((await call('/api/v1/invites/redeem', 'POST', {}, cookie)).status).toBe(403);
    expect(
      (await pool.query('SELECT active FROM members WHERE id=$1', [memberId])).rows[0]
    ).toEqual({
      active: false,
    });
    expect(
      (await pool.query('SELECT use_count FROM invites WHERE id=$1', [invite.id])).rows[0]
    ).toEqual({ use_count: 1 });
    const reactivationInvite = await call(
      '/api/v1/invites',
      'POST',
      { seats: 1, channelId },
      ownerCookie
    );
    const reactivationToken = (await reactivationInvite.json()).token;
    const reactivationPreflight = await call('/api/v1/invites/preflight', 'POST', {
      token: reactivationToken,
    });
    const reactivationCookie = withAdmission(cookie, reactivationPreflight);
    expect((await call('/api/v1/invites/bind', 'POST', {}, reactivationCookie)).status).toBe(200);
    const reactivated = await call('/api/v1/invites/redeem', 'POST', {}, reactivationCookie);
    expect(await reactivated.json()).toEqual({ memberId });
    expect((await call('/api/v1/invites/redeem', 'POST', {}, cookie)).status).toBe(403);
    expect(
      (
        await pool.query(
          'SELECT array_agg(channel_id ORDER BY channel_id) AS channels FROM channel_members WHERE community_id=$1 AND member_id=$2',
          [communityId, memberId]
        )
      ).rows[0].channels
    ).toEqual([channelId]);
    expect(
      (
        await pool.query(
          'SELECT count(*)::int AS n FROM read_cursors WHERE community_id=$1 AND member_id=$2',
          [communityId, memberId]
        )
      ).rows[0].n
    ).toBe(0);
    expect(
      (
        await pool.query(
          'SELECT count(*)::int AS n FROM connection_pairings WHERE community_id=$1 AND member_id=$2 AND cancelled_at IS NULL',
          [communityId, memberId]
        )
      ).rows[0].n
    ).toBe(0);
    expect(
      (
        await pool.query(
          'SELECT count(*)::int AS n FROM connection_grants WHERE community_id=$1 AND member_id=$2 AND revoked_at IS NULL',
          [communityId, memberId]
        )
      ).rows[0].n
    ).toBe(0);
    await pool.query('DELETE FROM connection_pairings WHERE community_id=$1 AND member_id=$2', [
      communityId,
      memberId,
    ]);
    await pool.query('DELETE FROM connection_grants WHERE community_id=$1 AND member_id=$2', [
      communityId,
      memberId,
    ]);
  });

  it('exposes only the current member and a bounded moderator directory', async () => {
    const options = await call('/api/v1/auth-options', 'GET');
    expect(options.status).toBe(200);
    expect(await options.json()).toEqual({ google: false, github: false });
    expect((await call('/api/v1/me', 'GET')).status).toBe(401);
    const self = await call('/api/v1/me', 'GET', undefined, ownerCookie);
    expect(self.status).toBe(200);
    const selfBody = await self.json();
    expect(selfBody.member.memberId).toBe(ownerId);
    expect(selfBody.member.role).toBe('owner');
    expect(Object.keys(selfBody.member).sort()).toEqual([
      'displayName',
      'handle',
      'joinedAt',
      'kind',
      'memberId',
      'ownerMemberId',
      'role',
    ]);
    expect((await call('/api/v1/members', 'GET', undefined, admittedCookie)).status).toBe(403);
    const first = await call('/api/v1/members?limit=1', 'GET', undefined, ownerCookie);
    expect(first.status).toBe(200);
    const page = await first.json();
    expect(page.members).toHaveLength(1);
    expect(page.nextCursor).toBe(page.members[0].memberId);
    expect(JSON.stringify(page)).not.toContain('email');
    const second = await call(
      `/api/v1/members?limit=1&cursor=${page.nextCursor}`,
      'GET',
      undefined,
      ownerCookie
    );
    expect(second.status).toBe(200);
    expect((await second.json()).members[0].memberId).not.toBe(page.members[0].memberId);
    expect((await call('/api/v1/members?limit=101', 'GET', undefined, ownerCookie)).status).toBe(
      400
    );
    expect(
      (await call(`/api/v1/members/${admittedId}/role`, 'PATCH', { role: 'admin' }, ownerCookie))
        .status
    ).toBe(200);
    expect((await call('/api/v1/members', 'GET', undefined, admittedCookie)).status).toBe(200);
    expect(
      (await call(`/api/v1/members/${admittedId}/role`, 'PATCH', { role: 'member' }, ownerCookie))
        .status
    ).toBe(200);
  });

  it('pairs a local install once through browser approval and revokes its scoped bearer', async () => {
    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const start = await localCall('/api/v1/pairings/start', {
      installName: 'Laptop',
      challenge,
      scopes: ['read', 'post', 'enroll-agent'],
    });
    expect(start.status).toBe(201);
    const { pairingId, approvalUrl } = await start.json();
    expect(approvalUrl).toBe(`${config.publicUrl}/pairing?pairingId=${pairingId}`);
    expect(
      (await call(`/api/v1/pairings/${pairingId}`, 'GET', undefined, ownerCookie)).status
    ).toBe(200);
    expect(
      (await call('/api/v1/pairings/approve', 'POST', { pairingId }, ownerCookie)).status
    ).toBe(200);
    expect(
      (await localCall('/api/v1/pairings/poll', { pairingId, verifier: 'wrong' })).status
    ).toBe(403);
    const polls = await Promise.all([
      localCall('/api/v1/pairings/poll', { pairingId, verifier }),
      localCall('/api/v1/pairings/poll', { pairingId, verifier }),
    ]);
    expect(polls.map((response) => response.status)).toEqual([200, 200]);
    const pollBodies = await Promise.all(polls.map((response) => response.json()));
    const codes = pollBodies.flatMap((body) => (body.code ? [body.code] : []));
    expect(codes).toHaveLength(1);
    const wrong = await localCall('/api/v1/pairings/exchange', {
      pairingId,
      code: codes[0],
      verifier: 'wrong',
    });
    expect(wrong.status).toBe(403);
    const exchange = await localCall('/api/v1/pairings/exchange', {
      pairingId,
      code: codes[0],
      verifier,
    });
    expect(exchange.status).toBe(200);
    expect(exchange.headers.get('cache-control')).toBe('no-store');
    const { token, grant } = await exchange.json();
    expect(token).toHaveLength(43);
    expect(
      (await localCall('/api/v1/pairings/exchange', { pairingId, code: codes[0], verifier })).status
    ).toBe(409);
    const persisted = await pool.query('SELECT token_hash FROM connection_grants WHERE id=$1', [
      grant.id,
    ]);
    expect(persisted.rows[0].token_hash).not.toContain(token);
    const access = await bearerCall('/api/v1/me/connection-access', 'GET', token);
    expect(access.status).toBe(200);
    expect(await access.json()).toMatchObject({
      access: {
        state: 'verified',
        effective: { read: true, post: true, enrollAgent: true, stream: true },
        lastKnown: {
          lifecycle: 'active',
          capabilities: { read: true, post: true, enrollAgent: true, stream: true },
        },
      },
    });
    const listed = await call('/api/v1/me/grants', 'GET', undefined, ownerCookie);
    expect(listed.status).toBe(200);
    expect(JSON.stringify(await listed.json())).not.toContain(token);
    const stream = await bearerCall(`/api/v1/channels/${channelId}/events`, 'GET', token);
    expect(stream.status).toBe(200);
    const reader = stream.body!.getReader();
    try {
      expect((await nextSse(reader)).type).toBe('snapshot');
      expect((await nextSse(reader)).type).toBe('replay_complete');
      expect(
        (await call(`/api/v1/me/grants/${grant.id}`, 'DELETE', undefined, ownerCookie)).status
      ).toBe(204);
      expect(
        (await call(`/api/v1/me/grants/${grant.id}`, 'DELETE', undefined, ownerCookie)).status
      ).toBe(204);
      expect((await bearerCall('/api/v1/me/connection-access', 'GET', token)).status).toBe(401);
      // Another admitted person commits after revocation. The old connection
      // must close rather than deliver even this otherwise-visible entry.
      expect(
        (
          await call(
            `/api/v1/channels/${channelId}/entries`,
            'POST',
            {
              text: 'Never deliver this to the revoked installation',
              idempotencyKey: 'after-personal-grant-revocation',
            },
            admittedCookie
          )
        ).status
      ).toBe(201);
      expect((await nextSse(reader)).type).toBe('closed');
      expect((await reader.read()).done).toBe(true);
    } finally {
      await reader.cancel().catch(() => undefined);
    }
    expect(
      (await pool.query('SELECT revoked_at FROM connection_grants WHERE id=$1', [grant.id])).rows[0]
        .revoked_at
    ).not.toBeNull();
  });

  it('never issues a pairing credential after cancellation or expiry', async () => {
    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const first = await (
      await localCall('/api/v1/pairings/start', {
        installName: 'Cancelled',
        challenge,
        scopes: ['read'],
      })
    ).json();
    expect(
      (await localCall('/api/v1/pairings/cancel', { pairingId: first.pairingId, verifier })).status
    ).toBe(204);
    expect(
      (await call('/api/v1/pairings/approve', 'POST', { pairingId: first.pairingId }, ownerCookie))
        .status
    ).toBe(409);
    expect(
      (
        await (
          await localCall('/api/v1/pairings/poll', { pairingId: first.pairingId, verifier })
        ).json()
      ).status
    ).toBe('cancelled');
    const second = await (
      await localCall('/api/v1/pairings/start', {
        installName: 'Expired',
        challenge,
        scopes: ['read'],
      })
    ).json();
    await pool.query(
      "UPDATE connection_pairings SET expires_at=now()-interval '1 second' WHERE id=$1",
      [second.pairingId]
    );
    expect(
      (
        await (
          await localCall('/api/v1/pairings/poll', { pairingId: second.pairingId, verifier })
        ).json()
      ).status
    ).toBe('expired');
    expect((await pool.query('SELECT count(*)::int AS n FROM connection_grants')).rows[0].n).toBe(
      1
    );
    const third = await (
      await localCall('/api/v1/pairings/start', {
        installName: 'Declined in browser',
        challenge,
        scopes: ['read'],
      })
    ).json();
    expect(
      (await call('/api/v1/pairings/approve', 'POST', { pairingId: third.pairingId }, ownerCookie))
        .status
    ).toBe(200);
    expect(
      (await call('/api/v1/pairings/decline', 'POST', { pairingId: third.pairingId }, ownerCookie))
        .status
    ).toBe(200);
    expect(
      (
        await (
          await localCall('/api/v1/pairings/poll', { pairingId: third.pairingId, verifier })
        ).json()
      ).status
    ).toBe('cancelled');
  });

  it('disconnects all selected-member installations idempotently after reauthentication', async () => {
    const communityId = (
      await pool.query<{ community_id: string }>('SELECT community_id FROM members WHERE id=$1', [
        ownerId,
      ])
    ).rows[0].community_id;
    const ownerGrants = await pool.query<{ id: string }>(
      `INSERT INTO connection_grants(community_id,member_id,token_hash,scopes,install_name)
       VALUES($1,$2,$3,'{read}','Owner laptop'),($1,$2,$4,'{read,post}','Owner desktop')
       RETURNING id`,
      [
        communityId,
        ownerId,
        createHash('sha256').update(randomBytes(32)).digest('hex'),
        createHash('sha256').update(randomBytes(32)).digest('hex'),
      ]
    );
    const otherGrant = await pool.query<{ id: string }>(
      `INSERT INTO connection_grants(community_id,member_id,token_hash,scopes,install_name)
       VALUES($1,$2,$3,'{read}','Other laptop') RETURNING id`,
      [communityId, admittedId, createHash('sha256').update(randomBytes(32)).digest('hex')]
    );
    expect(
      (await call('/api/v1/me/grants', 'DELETE', { password: 'wrong-password' }, ownerCookie))
        .status
    ).toBe(403);
    await pool.query(
      "UPDATE communities SET lifecycle='archived',archived_at=now(),lifecycle_version=lifecycle_version+1 WHERE id=$1",
      [communityId]
    );
    try {
      expect(
        (await call('/api/v1/me/grants', 'DELETE', { password: 'password1234' }, ownerCookie))
          .status
      ).toBe(204);
      expect(
        (await call('/api/v1/me/grants', 'DELETE', { password: 'password1234' }, ownerCookie))
          .status
      ).toBe(204);
    } finally {
      await pool.query(
        "UPDATE communities SET lifecycle='active',archived_at=NULL,lifecycle_version=lifecycle_version+1 WHERE id=$1",
        [communityId]
      );
    }
    expect(
      (
        await pool.query<{ revoked: boolean }>(
          'SELECT bool_and(revoked_at IS NOT NULL) AS revoked FROM connection_grants WHERE id=ANY($1::uuid[])',
          [ownerGrants.rows.map((row) => row.id)]
        )
      ).rows[0].revoked
    ).toBe(true);
    expect(
      (
        await pool.query('SELECT revoked_at FROM connection_grants WHERE id=$1', [
          otherGrant.rows[0].id,
        ])
      ).rows[0].revoked_at
    ).toBeNull();
    await pool.query('DELETE FROM connection_grants WHERE id=ANY($1::uuid[])', [
      [...ownerGrants.rows, ...otherGrant.rows].map((row) => row.id),
    ]);
  });

  it('sweeps expired admission transactions without racing a locked transaction', async () => {
    const inviteId = randomUUID();
    const admissionId = randomUUID();
    const accountId = (
      await pool.query<{ user_id: string }>('SELECT user_id FROM members WHERE id=$1', [ownerId])
    ).rows[0].user_id;
    await pool.query(
      `INSERT INTO invites(
         id,community_id,issuer_member_id,token_hash,seat_limit,expires_at
       ) VALUES($1,$2,$3,$4,1,now()+interval '1 hour')`,
      [inviteId, communityId, ownerId, createHash('sha256').update(randomBytes(32)).digest('hex')]
    );
    await pool.query(
      `INSERT INTO pending_admissions(
         id,community_id,invite_id,token_hash,account_id,bound_at,consumed_at,expires_at
       ) VALUES($1,$2,$3,$4,$5,now(),now(),now()-interval '1 second')`,
      [
        admissionId,
        communityId,
        inviteId,
        createHash('sha256').update(randomBytes(32)).digest('hex'),
        accountId,
      ]
    );
    await pool.query(
      `INSERT INTO admission_receipts(
         admission_id,community_id,invite_id,account_id,member_id,expires_at
       ) VALUES($1,$2,$3,$4,$5,now()-interval '1 second')`,
      [admissionId, communityId, inviteId, accountId, ownerId]
    );
    const blocker = await pool.connect();
    await blocker.query('BEGIN');
    try {
      await blocker.query('SELECT 1 FROM pending_admissions WHERE id=$1 FOR UPDATE', [admissionId]);
      expect(await sweepExpiredAdmissions(pool)).toBe(0);
      expect(
        (await pool.query('SELECT 1 FROM admission_receipts WHERE admission_id=$1', [admissionId]))
          .rowCount
      ).toBe(1);
    } finally {
      await blocker.query('ROLLBACK');
      blocker.release();
    }
    expect(await sweepExpiredAdmissions(pool)).toBe(1);
    expect(
      (await pool.query('SELECT 1 FROM pending_admissions WHERE id=$1', [admissionId])).rowCount
    ).toBe(0);
    expect(
      (await pool.query('SELECT 1 FROM admission_receipts WHERE admission_id=$1', [admissionId]))
        .rowCount
    ).toBe(0);
  });

  it('does not admit through revoked or expired invites and never consumes seats on preview', async () => {
    const issued = await call('/api/v1/invites', 'POST', { seats: 2 }, ownerCookie);
    const { token, invite } = await issued.json();
    const preview = await call('/api/v1/invites/preview', 'POST', { token });
    expect(preview.status).toBe(200);
    expect(Object.keys(await preview.json()).sort()).toEqual([
      'channelName',
      'communityName',
      'inviterName',
    ]);
    expect(
      (await pool.query('SELECT use_count FROM invites WHERE id=$1', [invite.id])).rows[0].use_count
    ).toBe(0);
    expect(
      (await call(`/api/v1/invites/${invite.id}`, 'DELETE', undefined, ownerCookie)).status
    ).toBe(204);
    expect((await call('/api/v1/invites/preflight', 'POST', { token })).status).toBe(403);
    const second = await call('/api/v1/invites', 'POST', {}, ownerCookie);
    const other = await second.json();
    await pool.query("UPDATE invites SET expires_at=now()-interval '1 second' WHERE id=$1", [
      other.invite.id,
    ]);
    expect((await call('/api/v1/invites/preview', 'POST', { token: other.token })).status).toBe(
      403
    );
  });

  it('enrolls only through a personal grant and isolates agent credentials and owner quota', async () => {
    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const start = await localCall('/api/v1/pairings/start', {
      installName: 'Agent host',
      challenge,
      scopes: ['read', 'post', 'enroll-agent'],
    });
    const { pairingId } = await start.json();
    expect(
      (await call('/api/v1/pairings/approve', 'POST', { pairingId }, ownerCookie)).status
    ).toBe(200);
    const { code } = await (
      await localCall('/api/v1/pairings/poll', { pairingId, verifier })
    ).json();
    const grant = await (
      await localCall('/api/v1/pairings/exchange', { pairingId, code, verifier })
    ).json();
    const humanToken = grant.token;
    ownerGrantToken = humanToken;
    expect(
      (await call('/api/v1/agents', 'POST', { localAgentId: 'x', displayName: 'X' }, ownerCookie))
        .status
    ).toBe(401);
    const enrolls = await Promise.all(
      ['a', 'b', 'c'].map((id) =>
        bearerCall('/api/v1/agents', 'POST', humanToken, {
          localAgentId: id,
          displayName: `Agent ${id}`,
        })
      )
    );
    expect(enrolls.map((response) => response.status).sort()).toEqual([201, 201, 429]);
    const enrolled = await Promise.all(
      enrolls.filter((response) => response.status === 201).map((response) => response.json())
    );
    agentToken = enrolled[0].token;
    const secondToken = enrolled[1].token;
    const agentId = enrolled[0].agent.memberId;
    const secondId = enrolled[1].agent.memberId;
    const publicAgents = await call('/api/v1/agents', 'GET', undefined, ownerCookie);
    expect(publicAgents.status).toBe(200);
    expect(JSON.stringify(await publicAgents.json())).not.toContain(agentToken);
    expect(
      (
        await pool.query(
          'SELECT token_hash FROM agent_credentials WHERE agent_id=$1 AND revoked_at IS NULL',
          [agentId]
        )
      ).rows[0].token_hash
    ).not.toContain(agentToken);
    expect(
      (
        await pool.query(
          'SELECT count(*)::int AS n FROM agents WHERE owner_member_id=$1 AND active',
          [ownerId]
        )
      ).rows[0].n
    ).toBe(2);
    expect((await bearerCall(`/api/v1/channels/${channelId}`, 'GET', agentToken)).status).toBe(404);
    expect((await bearerCall('/api/v1/invites', 'POST', agentToken, { seats: 1 })).status).toBe(
      401
    );
    expect(
      (await call(`/api/v1/channels/${channelId}/agents`, 'POST', { agentId }, ownerCookie)).status
    ).toBe(200);
    expect(
      (
        await call(
          `/api/v1/channels/${channelId}/agents`,
          'POST',
          { agentId: secondId },
          ownerCookie
        )
      ).status
    ).toBe(200);
    const posts = await Promise.all([
      bearerCall(`/api/v1/channels/${channelId}/entries`, 'POST', agentToken, {
        text: 'one',
        idempotencyKey: 'agent-a-1',
      }),
      bearerCall(`/api/v1/channels/${channelId}/entries`, 'POST', secondToken, {
        text: 'two',
        idempotencyKey: 'agent-b-1',
      }),
      call(
        `/api/v1/channels/${channelId}/entries`,
        'POST',
        { text: 'human', idempotencyKey: 'human-1' },
        ownerCookie
      ),
    ]);
    expect(posts.map((response) => response.status)).toEqual([201, 201, 201]);
    expect(
      (
        await bearerCall(`/api/v1/channels/${channelId}/entries`, 'POST', secondToken, {
          text: 'over',
          idempotencyKey: 'agent-b-2',
        })
      ).status
    ).toBe(429);
    expect(
      (await bearerCall(`/api/v1/channels/${channelId}/entries`, 'GET', agentToken)).status
    ).toBe(200);
    const stream = await bearerCall(`/api/v1/channels/${channelId}/events`, 'GET', agentToken);
    expect(stream.status).toBe(200);
    const reader = stream.body!.getReader();
    expect((await nextSse(reader)).type).toBe('snapshot');
    expect((await nextSse(reader)).type).toBe('replay_complete');
    const rotate = await bearerCall(`/api/v1/agents/${agentId}/rotate`, 'POST', humanToken, {});
    expect(rotate.status).toBe(200);
    expect(rotate.headers.get('cache-control')).toBe('no-store');
    const newToken = (await rotate.json()).token;
    expect(
      (await bearerCall(`/api/v1/channels/${channelId}/entries`, 'GET', agentToken)).status
    ).toBe(401);
    expect((await nextSse(reader)).type).toBe('closed');
    await reader.cancel();
    expect(
      (await bearerCall(`/api/v1/channels/${channelId}/entries`, 'GET', newToken)).status
    ).toBe(200);
    expect((await bearerCall('/api/v1/channels', 'GET', newToken)).status).toBe(200);
    agentToken = newToken;
  });

  it('names an agent owner in a joined roster without exposing a global member directory', async () => {
    const created = await call('/api/v1/channels', 'POST', { name: 'Owner away' }, ownerCookie);
    expect(created.status).toBe(201);
    const channel = (await created.json()).channel.id as string;
    const agentId = (
      await pool.query<{ agent_id: string }>(
        'SELECT agent_id FROM agent_credentials WHERE token_hash=$1 AND revoked_at IS NULL',
        [createHash('sha256').update(agentToken).digest('hex')]
      )
    ).rows[0].agent_id;
    expect(
      (
        await call(
          `/api/v1/channels/${channel}/members`,
          'POST',
          { memberId: admittedId },
          ownerCookie
        )
      ).status
    ).toBe(200);
    expect(
      (await call(`/api/v1/channels/${channel}/agents`, 'POST', { agentId }, ownerCookie)).status
    ).toBe(200);
    expect((await call(`/api/v1/channels/${channel}/leave`, 'POST', {}, ownerCookie)).status).toBe(
      200
    );
    expect((await call('/api/v1/members', 'GET', undefined, admittedCookie)).status).toBe(403);
    const roster = await call(
      `/api/v1/channels/${channel}/members`,
      'GET',
      undefined,
      admittedCookie
    );
    expect(roster.status).toBe(200);
    const body = await roster.json();
    expect(body.members.some((member: { memberId: string }) => member.memberId === ownerId)).toBe(
      false
    );
    const agent = body.members.find((member: { memberId: string }) => member.memberId === agentId);
    expect(agent.ownerMemberId).toBe(ownerId);
    expect(agent.ownerDisplayName).toBe('Owner');
    expect(JSON.stringify(body)).not.toContain('email');
  });

  it('denies delayed history after agent rotation, grant revocation, and session deletion', async () => {
    const path = `/api/v1/channels/${channelId}/entries`;
    const agentId = (
      await pool.query<{ agent_id: string }>(
        'SELECT agent_id FROM agent_credentials WHERE token_hash=$1 AND revoked_at IS NULL',
        [createHash('sha256').update(agentToken).digest('hex')]
      )
    ).rows[0].agent_id;
    const blocker = await pool.connect();
    try {
      await blocker.query('BEGIN');
      await blocker.query('SELECT 1 FROM channels WHERE id=$1 FOR UPDATE', [channelId]);
      const delayed = bearerCall(path, 'GET', agentToken);
      await waitForBlockedQuery('SELECT c.* FROM channels');
      const rotated = await bearerCall(
        `/api/v1/agents/${agentId}/rotate`,
        'POST',
        ownerGrantToken,
        {}
      );
      expect(rotated.status).toBe(200);
      const replacement = (await rotated.json()).token;
      await blocker.query('COMMIT');
      expect((await delayed).status).toBe(401);
      agentToken = replacement;

      await blocker.query('BEGIN');
      await blocker.query('SELECT 1 FROM channels WHERE id=$1 FOR UPDATE', [channelId]);
      const delayedGrant = bearerCall(path, 'GET', ownerGrantToken);
      await waitForBlockedQuery('SELECT c.* FROM channels');
      const grantId = (
        await pool.query<{ id: string }>(
          'SELECT id FROM connection_grants WHERE token_hash=$1 AND revoked_at IS NULL',
          [createHash('sha256').update(ownerGrantToken).digest('hex')]
        )
      ).rows[0].id;
      expect(
        (await call(`/api/v1/me/grants/${grantId}`, 'DELETE', undefined, ownerCookie)).status
      ).toBe(204);
      await blocker.query('COMMIT');
      expect((await delayedGrant).status).toBe(401);

      const eve = await joinWithInvite('Eve', 'eve@admission.test');
      expect(
        (
          await call(
            `/api/v1/channels/${channelId}/members`,
            'POST',
            { memberId: eve.id },
            ownerCookie
          )
        ).status
      ).toBe(200);
      await blocker.query('BEGIN');
      await blocker.query('SELECT 1 FROM channels WHERE id=$1 FOR UPDATE', [channelId]);
      const delayedSession = call(path, 'GET', undefined, eve.cookie);
      await waitForBlockedQuery('SELECT c.* FROM channels');
      await pool.query(
        'DELETE FROM session WHERE "userId"=(SELECT user_id FROM members WHERE id=$1)',
        [eve.id]
      );
      await blocker.query('COMMIT');
      expect((await delayedSession).status).toBe(401);
    } finally {
      await blocker.query('ROLLBACK');
      blocker.release();
    }
  });

  it('reads history with one pool connection for both cookie and bearer credentials', async () => {
    const singlePool = new Pool({ connectionString: dbUrl.toString(), max: 1 });
    const isolated = serve({
      fetch: createCommunityApp({ config, pool: singlePool }).fetch,
      port: 0,
    });
    await new Promise<void>((resolve) => isolated.once('listening', resolve));
    try {
      const address = isolated.address();
      if (!address || typeof address === 'string') throw new Error('Missing isolated HTTP address');
      const path = `http://localhost:${address.port}/api/v1/channels/${channelId}/entries`;
      const credentials: Record<string, string>[] = [
        { cookie: ownerCookie },
        { authorization: `Bearer ${agentToken}` },
      ];
      let cursor = '';
      for (const headers of credentials) {
        const response = await fetch(path, { headers, signal: AbortSignal.timeout(5_000) });
        expect(response.status).toBe(200);
        const page = await response.json();
        expect(page.entries).toBeInstanceOf(Array);
        cursor ||= page.entries[0]?.cursor ?? '';
      }
      expect(cursor).not.toBe('');
      const read = await fetch(
        `http://localhost:${address.port}/api/v1/channels/${channelId}/read-cursor`,
        {
          method: 'PUT',
          headers: {
            cookie: ownerCookie,
            origin: config.publicUrl,
            'content-type': 'application/json',
          },
          body: JSON.stringify({ cursor }),
          signal: AbortSignal.timeout(5_000),
        }
      );
      expect(read.status).toBe(200);
    } finally {
      await new Promise<void>((resolve) => isolated.close(() => resolve()));
      await singlePool.end();
    }
  });

  it('locks member before session when a cursor update races session removal', async () => {
    const reader = await joinWithInvite('Session reader', 'session-reader@admission.test');
    expect(
      (
        await call(
          `/api/v1/channels/${channelId}/members`,
          'POST',
          { memberId: reader.id },
          ownerCookie
        )
      ).status
    ).toBe(200);
    const page = await call(
      `/api/v1/channels/${channelId}/entries`,
      'GET',
      undefined,
      reader.cookie
    );
    expect(page.status).toBe(200);
    const cursor = (await page.json()).entries[0].cursor;
    const blocker = await pool.connect();
    try {
      await blocker.query('BEGIN');
      await blocker.query("SET LOCAL lock_timeout='2s'");
      await blocker.query('SELECT 1 FROM members WHERE id=$1 FOR UPDATE', [reader.id]);
      const delayed = call(
        `/api/v1/channels/${channelId}/read-cursor`,
        'PUT',
        { cursor },
        reader.cookie
      );
      await waitForBlockedQuery('SELECT user_id FROM members');
      // Member removal takes M then S. A joined recheck that grabbed S before
      // waiting on M would deadlock this delete instead of allowing it to finish.
      const deleted = await blocker.query(
        'DELETE FROM session WHERE "userId"=(SELECT user_id FROM members WHERE id=$1)',
        [reader.id]
      );
      expect(deleted.rowCount).toBe(1);
      await blocker.query('COMMIT');
      expect((await delayed).status).toBe(401);
    } finally {
      await blocker.query('ROLLBACK');
      blocker.release();
    }
  });

  it('checks an agent owner’s promoted role after a contended ejection', async () => {
    const moderator = await joinWithInvite('Moderator', 'moderator@admission.test');
    expect(
      (await call(`/api/v1/members/${moderator.id}/role`, 'PATCH', { role: 'admin' }, ownerCookie))
        .status
    ).toBe(200);
    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const started = await (
      await localCall('/api/v1/pairings/start', {
        installName: 'Admitted agent host',
        challenge,
        scopes: ['enroll-agent'],
      })
    ).json();
    expect(
      (
        await call(
          '/api/v1/pairings/approve',
          'POST',
          { pairingId: started.pairingId },
          admittedCookie
        )
      ).status
    ).toBe(200);
    const { code } = await (
      await localCall('/api/v1/pairings/poll', { pairingId: started.pairingId, verifier })
    ).json();
    const { token } = await (
      await localCall('/api/v1/pairings/exchange', { pairingId: started.pairingId, verifier, code })
    ).json();
    const enrolled = await bearerCall('/api/v1/agents', 'POST', token, {
      localAgentId: 'role-race-agent',
      displayName: 'Role race agent',
    });
    expect(enrolled.status).toBe(201);
    const agentId = (await enrolled.json()).agent.memberId;
    const blocker = await pool.connect();
    try {
      await blocker.query('BEGIN');
      await blocker.query('SELECT 1 FROM members WHERE id=$1 FOR UPDATE', [admittedId]);
      const promotion = call(
        `/api/v1/members/${admittedId}/role`,
        'PATCH',
        { role: 'admin' },
        ownerCookie
      );
      await waitForBlockedQuery('UPDATE members SET role');
      const ejection = call(`/api/v1/agents/${agentId}`, 'DELETE', undefined, moderator.cookie);
      await waitForBlockedQuery('SELECT role FROM members');
      await blocker.query('COMMIT');
      expect((await promotion).status).toBe(200);
      expect((await ejection).status).toBe(403);
      expect(
        (await call(`/api/v1/members/${admittedId}/role`, 'PATCH', { role: 'member' }, ownerCookie))
          .status
      ).toBe(200);
      expect(
        (await call(`/api/v1/agents/${agentId}`, 'DELETE', undefined, moderator.cookie)).status
      ).toBe(204);
    } finally {
      await blocker.query('ROLLBACK');
      blocker.release();
    }
  });

  it('enforces the member role matrix and immediately removes an ordinary member', async () => {
    const ordinary = await joinWithInvite('Carol', 'carol@admission.test');
    const priorRoleEvents = (
      await pool.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM audit_events WHERE action='member.role' AND subject_id=$1",
        [admittedId]
      )
    ).rows[0].n;
    expect(
      (await call(`/api/v1/members/${admittedId}/role`, 'PATCH', { role: 'admin' }, ownerCookie))
        .status
    ).toBe(200);
    expect(
      (
        await pool.query(
          "SELECT count(*)::int AS n FROM audit_events WHERE action='member.role' AND subject_id=$1",
          [admittedId]
        )
      ).rows[0].n
    ).toBe(priorRoleEvents + 1);
    expect(
      (await call(`/api/v1/members/${ownerId}`, 'DELETE', undefined, admittedCookie)).status
    ).toBe(403);
    expect(
      (await call(`/api/v1/members/${ordinary.id}`, 'DELETE', undefined, admittedCookie)).status
    ).toBe(204);
    expect((await call('/api/v1/channels', 'GET', undefined, ordinary.cookie)).status).toBe(403);
    expect(
      (await call(`/api/v1/members/${admittedId}/role`, 'PATCH', { role: 'member' }, ownerCookie))
        .status
    ).toBe(200);
    expect(
      (await call(`/api/v1/members/${ownerId}`, 'DELETE', undefined, admittedCookie)).status
    ).toBe(403);
  });

  it('does not deadlock owner transfer against a successor ejecting the owner’s agent', async () => {
    expect(
      (await call(`/api/v1/members/${admittedId}/role`, 'PATCH', { role: 'admin' }, ownerCookie))
        .status
    ).toBe(200);
    const agentId = (
      await pool.query<{ agent_id: string }>(
        'SELECT agent_id FROM agent_credentials WHERE token_hash=$1 AND revoked_at IS NULL',
        [createHash('sha256').update(agentToken).digest('hex')]
      )
    ).rows[0].agent_id;
    const initialLifecycleVersion = Number(
      (await pool.query('SELECT lifecycle_version FROM communities WHERE id=$1', [communityId]))
        .rows[0].lifecycle_version
    );
    const blocker = await pool.connect();
    try {
      await blocker.query('BEGIN');
      await blocker.query('SELECT 1 FROM members WHERE id=$1 FOR KEY SHARE', [admittedId]);
      const transfer = call(
        '/api/v1/owner/transfer',
        'POST',
        {
          successorMemberId: admittedId,
          password: 'password1234',
          lifecycleVersion: initialLifecycleVersion,
        },
        ownerCookie
      );
      await waitForBlockedQuery('SELECT id,user_id,display_name,role,community_id FROM members');
      const ejection = call(`/api/v1/agents/${agentId}`, 'DELETE', undefined, admittedCookie);
      const ejectionResult = await Promise.race([
        ejection,
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 1_000)),
      ]);
      expect(ejectionResult?.status).toBe(403);
      await blocker.query('COMMIT');
      expect((await transfer).status).toBe(200);
      expect((await ejection).status).toBe(403);
      const returnLifecycleVersion = Number(
        (await pool.query('SELECT lifecycle_version FROM communities WHERE id=$1', [communityId]))
          .rows[0].lifecycle_version
      );
      expect(
        (
          await call(
            '/api/v1/owner/transfer',
            'POST',
            {
              successorMemberId: ownerId,
              password: 'password1234',
              lifecycleVersion: returnLifecycleVersion,
            },
            admittedCookie
          )
        ).status
      ).toBe(200);
      expect(
        (await call(`/api/v1/members/${admittedId}/role`, 'PATCH', { role: 'member' }, ownerCookie))
          .status
      ).toBe(200);
    } finally {
      await blocker.query('ROLLBACK');
      blocker.release();
    }
  });

  it('removal wins a blocked post and closes the member stream without erasing history', async () => {
    const dave = await joinWithInvite('Dave', 'dave@admission.test');
    expect(
      (
        await call(
          `/api/v1/channels/${channelId}/members`,
          'POST',
          { memberId: dave.id },
          ownerCookie
        )
      ).status
    ).toBe(200);
    const prior = await call(
      `/api/v1/channels/${channelId}/entries`,
      'POST',
      { text: 'before leaving', idempotencyKey: 'dave-history' },
      dave.cookie
    );
    expect(prior.status).toBe(201);
    const priorId = (await prior.json()).entry.id;
    const stream = await call(
      `/api/v1/channels/${channelId}/events`,
      'GET',
      undefined,
      dave.cookie
    );
    const reader = stream.body!.getReader();
    expect((await nextSse(reader)).type).toBe('snapshot');
    expect((await nextSse(reader)).type).toBe('replay_complete');
    const blocker = await pool.connect();
    await blocker.query('BEGIN');
    await blocker.query('SELECT 1 FROM channels WHERE id=$1 FOR UPDATE', [channelId]);
    try {
      const blockedPost = call(
        `/api/v1/channels/${channelId}/entries`,
        'POST',
        { text: 'after removal', idempotencyKey: 'dave-blocked' },
        dave.cookie
      );
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(
        (await call(`/api/v1/members/${dave.id}`, 'DELETE', undefined, ownerCookie)).status
      ).toBe(204);
      await blocker.query('COMMIT');
      expect((await blockedPost).status).toBe(403);
      expect((await nextSse(reader)).type).toBe('closed');
      const rows = await pool.query('SELECT id,author_display_name FROM entries WHERE id=$1', [
        priorId,
      ]);
      expect(rows.rows).toEqual([{ id: priorId, author_display_name: 'Dave' }]);
    } finally {
      await blocker.query('ROLLBACK');
      blocker.release();
      await reader.cancel();
    }
  });

  it('requires owner reauthentication for transfer and preserves one active owner', async () => {
    const currentLifecycleVersion = Number(
      (await pool.query('SELECT lifecycle_version FROM communities WHERE id=$1', [communityId]))
        .rows[0].lifecycle_version
    );
    expect(
      (
        await call(
          '/api/v1/me/leave',
          'POST',
          { password: 'password1234', communityName: 'Admission test' },
          ownerCookie
        )
      ).status
    ).toBe(403);
    const wrong = await call(
      '/api/v1/owner/transfer',
      'POST',
      {
        successorMemberId: admittedId,
        password: 'wrong-password',
        lifecycleVersion: currentLifecycleVersion,
      },
      ownerCookie
    );
    expect(wrong.status).toBe(403);
    expect(
      (
        await call(
          '/api/v1/owner/transfer',
          'POST',
          {
            successorMemberId: admittedId,
            password: 'password1234',
            lifecycleVersion: currentLifecycleVersion,
          },
          admittedCookie
        )
      ).status
    ).toBe(403);
    const transfers = await Promise.all(
      [0, 1].map(() =>
        call(
          '/api/v1/owner/transfer',
          'POST',
          {
            successorMemberId: admittedId,
            password: 'password1234',
            lifecycleVersion: currentLifecycleVersion,
          },
          ownerCookie
        )
      )
    );
    expect(transfers.map((response) => response.status).sort()).toEqual([200, 409]);
    const owners = await pool.query("SELECT id FROM members WHERE role='owner' AND active");
    expect(owners.rows.map((row) => row.id)).toEqual([admittedId]);
    expect(
      (
        await call(
          '/api/v1/me/leave',
          'POST',
          { password: 'password1234', communityName: 'Admission test' },
          ownerCookie
        )
      ).status
    ).toBe(204);
    expect((await call('/api/v1/channels', 'GET', undefined, ownerCookie)).status).toBe(403);
    expect(
      (await bearerCall(`/api/v1/channels/${channelId}/entries`, 'GET', agentToken)).status
    ).toBe(401);
    expect((await bearerCall('/api/v1/channels', 'GET', ownerGrantToken)).status).toBe(401);
    const history = await call(
      `/api/v1/channels/${channelId}/entries`,
      'GET',
      undefined,
      admittedCookie
    );
    expect(history.status).toBe(200);
  });

  it('limits native personal grants to their scopes, ownership, and live revocation', async () => {
    const issueGrant = async (cookie: string, scopes: Array<'read' | 'post' | 'enroll-agent'>) => {
      const verifier = randomBytes(32).toString('base64url');
      const challenge = createHash('sha256').update(verifier).digest('base64url');
      const started = await (
        await localCall('/api/v1/pairings/start', {
          installName: `Native grant ${randomUUID()}`,
          challenge,
          scopes,
        })
      ).json();
      expect(
        (await call('/api/v1/pairings/approve', 'POST', { pairingId: started.pairingId }, cookie))
          .status
      ).toBe(200);
      const polled = await localCall('/api/v1/pairings/poll', {
        pairingId: started.pairingId,
        verifier,
      });
      const { code } = await polled.json();
      return (
        await localCall('/api/v1/pairings/exchange', {
          pairingId: started.pairingId,
          verifier,
          code,
        })
      ).json() as Promise<{ token: string }>;
    };

    const readOnly = (await issueGrant(admittedCookie, ['read'])).token;
    expect((await bearerCall(`/api/v1/channels/${channelId}/join`, 'POST', readOnly)).status).toBe(
      403
    );
    expect((await bearerCall('/api/v1/agents', 'POST', readOnly, {})).status).toBe(401);

    const full = (await issueGrant(admittedCookie, ['read', 'post', 'enroll-agent'])).token;
    const enrolled = await bearerCall('/api/v1/agents', 'POST', full, {
      localAgentId: `native-${randomUUID()}`,
      displayName: 'Native grant agent',
    });
    expect(enrolled.status).toBe(201);
    const agentId = (await enrolled.json()).agent.memberId;
    expect(
      (await bearerCall(`/api/v1/channels/${channelId}/agents`, 'POST', full, { agentId })).status
    ).toBe(200);

    const issued = await call('/api/v1/invites', 'POST', { seats: 1 }, admittedCookie);
    expect(issued.status).toBe(201);
    const inviteToken = (await issued.json()).token;
    const preflight = await call('/api/v1/invites/preflight', 'POST', { token: inviteToken });
    const otherCookie = await signup(
      'Native other',
      'native-other@admission.test',
      cookieOf(preflight)
    );
    expect((await call('/api/v1/invites/bind', 'POST', {}, otherCookie)).status).toBe(200);
    const redeemed = await call('/api/v1/invites/redeem', 'POST', {}, otherCookie);
    expect(redeemed.status).toBe(200);
    const other = { cookie: otherCookie, id: (await redeemed.json()).memberId };
    const otherGrant = (await issueGrant(other.cookie, ['read', 'post', 'enroll-agent'])).token;
    expect((await bearerCall(`/api/v1/agents/${agentId}`, 'DELETE', otherGrant)).status).toBe(403);

    const grantId = (
      await pool.query<{ id: string }>(
        'SELECT id FROM connection_grants WHERE token_hash=$1 AND revoked_at IS NULL',
        [createHash('sha256').update(full).digest('hex')]
      )
    ).rows[0].id;
    expect(
      (await call(`/api/v1/me/grants/${grantId}`, 'DELETE', undefined, admittedCookie)).status
    ).toBe(204);
    expect(
      (await bearerCall(`/api/v1/channels/${channelId}/agents/${agentId}`, 'DELETE', full)).status
    ).toBe(401);
  });

  it('separates host operations from a pending community owner claim', async () => {
    const before = await call('/api/v1/host/communities', 'GET', undefined, ownerCookie);
    expect(before.status).toBe(200);
    expect((await before.json()).communities).toHaveLength(1);

    const created = await call(
      '/api/v1/host/communities',
      'POST',
      { idempotencyKey: 'admission-second-community', name: 'Second community' },
      ownerCookie
    );
    expect(created.status).toBe(201);
    const body = await created.json();
    const secondId = body.community.id as string;
    let resumeLifecycleVersion: number;
    const claimToken = body.ownerClaimToken as string;
    expect(body.community.lifecycle).toBe('pending_owner');

    expect((await call('/api/v1/community', 'GET', undefined, admittedCookie)).status).toBe(409);
    expect(
      (await call(`/api/v1/communities/${secondId}/channels`, 'GET', undefined, admittedCookie))
        .status
    ).toBe(409);
    expect(
      (await call(`/api/v1/communities/${secondId}/channels`, 'GET', undefined, ownerCookie)).status
    ).toBe(409);

    const preflight = await call('/api/v1/owner-claims/preflight', 'POST', {
      token: claimToken,
    });
    expect(preflight.status).toBe(200);
    expect((await preflight.clone().json()).communityId).toBe(secondId);
    const claimantCookie = await signup(
      'Second owner',
      'second-owner@admission.test',
      cookieOf(preflight)
    );
    const claimed = await call('/api/v1/owner-claims/claim', 'POST', {}, claimantCookie);
    expect(claimed.status).toBe(200);
    expect((await claimed.json()).community.id).toBe(secondId);
    const secondLifecycleVersion = Number(
      (await pool.query('SELECT lifecycle_version FROM communities WHERE id=$1', [secondId]))
        .rows[0].lifecycle_version
    );
    const firstId = (
      await pool.query<{ community_id: string }>('SELECT community_id FROM members WHERE id=$1', [
        admittedId,
      ])
    ).rows[0].community_id;
    const forbiddenClaim = randomBytes(32).toString('base64url');
    await pool.query(
      `INSERT INTO bootstrap_grants(token_hash,purpose,community_id,expires_at)
       VALUES($1,'owner_claim',$2,now()+interval '10 minutes')`,
      [createHash('sha256').update(forbiddenClaim).digest('hex'), secondId]
    );

    expect(
      (await call(`/api/v1/communities/${secondId}/channels`, 'GET', undefined, ownerCookie)).status
    ).toBe(403);
    expect(
      (await call(`/api/v1/communities/${secondId}/channels`, 'GET', undefined, claimantCookie))
        .status
    ).toBe(200);
    expect(
      (
        await call(
          `/api/v1/communities/${secondId}/channels/${channelId}`,
          'GET',
          undefined,
          claimantCookie
        )
      ).status
    ).toBe(404);

    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const pairing = await (
      await localCall(`/api/v1/communities/${secondId}/pairings/start`, {
        installName: 'Second community install',
        challenge,
        scopes: ['read'],
      })
    ).json();
    expect(pairing.approvalUrl).toBe(
      `${config.publicUrl}/c/${secondId}/pairing?pairingId=${pairing.pairingId}`
    );
    expect(
      (
        await localCall(`/api/v1/communities/${firstId}/pairings/poll`, {
          pairingId: pairing.pairingId,
          verifier,
        })
      ).status
    ).toBe(403);
    expect(
      (
        await call(
          `/api/v1/communities/${firstId}/pairings/approve`,
          'POST',
          { pairingId: pairing.pairingId },
          ownerCookie
        )
      ).status
    ).toBe(403);
    expect(
      (
        await call(
          `/api/v1/communities/${secondId}/pairings/approve`,
          'POST',
          { pairingId: pairing.pairingId },
          claimantCookie
        )
      ).status
    ).toBe(200);
    const pairingPoll = await localCall(`/api/v1/communities/${secondId}/pairings/poll`, {
      pairingId: pairing.pairingId,
      verifier,
    });
    const pairingCode = (await pairingPoll.json()).code;
    const pairingExchange = await localCall(`/api/v1/communities/${secondId}/pairings/exchange`, {
      pairingId: pairing.pairingId,
      verifier,
      code: pairingCode,
    });
    const secondGrant = (await pairingExchange.json()).token as string;
    expect(
      (
        await bearerCall(
          `/api/v1/communities/${firstId}/channels/${channelId}/entries`,
          'GET',
          secondGrant
        )
      ).status
    ).toBe(401);

    const firstInvite = await call(
      `/api/v1/communities/${firstId}/invites`,
      'POST',
      { seats: 1 },
      admittedCookie
    );
    expect(firstInvite.status).toBe(201);
    const firstInviteToken = (await firstInvite.json()).token;
    const firstPreflight = await call(`/api/v1/communities/${firstId}/invites/preflight`, 'POST', {
      token: firstInviteToken,
    });
    expect(firstPreflight.status).toBe(200);
    const claimantFirstCookie = `${claimantCookie}; ${cookieOf(firstPreflight)}`;
    const claimantFirstBind = await call(
      `/api/v1/communities/${firstId}/invites/bind`,
      'POST',
      {},
      claimantFirstCookie
    );
    expect(claimantFirstBind.status).toBe(200);
    const joinedFirst = await call(
      `/api/v1/communities/${firstId}/invites/redeem`,
      'POST',
      {},
      claimantFirstCookie
    );
    expect(joinedFirst.status).toBe(200);
    const claimantFirstMember = (await joinedFirst.json()).memberId;
    const visibleMemberships = await call('/api/v1/memberships', 'GET', undefined, claimantCookie);
    expect(visibleMemberships.status).toBe(200);
    const visibleMembershipRows = (await visibleMemberships.json()).memberships;
    expect(visibleMembershipRows).toHaveLength(2);
    expect(visibleMembershipRows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ communityId: firstId, role: 'member', lifecycle: 'active' }),
        expect.objectContaining({ communityId: secondId, role: 'owner', lifecycle: 'active' }),
      ])
    );
    expect(
      (
        await call(
          `/api/v1/communities/${firstId}/members/${claimantFirstMember}`,
          'DELETE',
          undefined,
          admittedCookie
        )
      ).status
    ).toBe(204);
    expect(
      (await call(`/api/v1/communities/${secondId}/me`, 'GET', undefined, claimantCookie)).status
    ).toBe(200);
    expect(
      (await (await call('/api/v1/memberships', 'GET', undefined, claimantCookie)).json())
        .memberships
    ).toEqual([
      expect.objectContaining({ communityId: secondId, role: 'owner', lifecycle: 'active' }),
    ]);
    expect(
      (await call('/api/v1/owner-claims/preflight', 'POST', { token: claimToken })).status
    ).toBe(403);
    expect(
      (await call('/api/v1/owner-claims/preflight', 'POST', { token: forbiddenClaim })).status
    ).toBe(403);

    const secondChannel = await call(
      `/api/v1/communities/${secondId}/channels`,
      'POST',
      { name: 'Second general' },
      claimantCookie
    );
    const secondChannelId = (await secondChannel.json()).channel.id as string;
    const firstStream = await call(
      `/api/v1/communities/${firstId}/channels/${channelId}/events`,
      'GET',
      undefined,
      admittedCookie
    );
    const secondStream = await call(
      `/api/v1/communities/${secondId}/channels/${secondChannelId}/events`,
      'GET',
      undefined,
      claimantCookie
    );
    const firstReader = firstStream.body!.getReader();
    const secondReader = secondStream.body!.getReader();
    expect((await nextSse(firstReader)).type).toBe('snapshot');
    expect((await nextSse(firstReader)).type).toBe('replay_complete');
    expect((await nextSse(secondReader)).type).toBe('snapshot');
    expect((await nextSse(secondReader)).type).toBe('replay_complete');
    const blocker = await pool.connect();
    try {
      await blocker.query('BEGIN');
      await blocker.query('SELECT 1 FROM channels WHERE id=$1 FOR UPDATE', [secondChannelId]);
      const blockedPost = call(
        `/api/v1/communities/${secondId}/channels/${secondChannelId}/entries`,
        'POST',
        { text: 'before suspension', idempotencyKey: 'before-suspension' },
        claimantCookie
      );
      await waitForBlockedQuery('SELECT c.* FROM channels');
      const suspended = call(
        `/api/v1/host/communities/${secondId}/lifecycle`,
        'PATCH',
        { action: 'suspend', lifecycleVersion: secondLifecycleVersion },
        ownerCookie
      );
      await waitForBlockedQuery('SELECT c.id,c.name,c.description,c.lifecycle');
      await blocker.query('COMMIT');
      expect((await blockedPost).status).toBe(201);
      const suspendedResponse = await suspended;
      expect(suspendedResponse.status).toBe(200);
      resumeLifecycleVersion = (await suspendedResponse.json()).lifecycleVersion;
    } finally {
      await blocker.query('ROLLBACK');
      blocker.release();
    }
    const suspendedChannels = await call(
      `/api/v1/communities/${secondId}/channels`,
      'GET',
      undefined,
      claimantCookie
    );
    expect(suspendedChannels.status).toBe(503);
    expect(await suspendedChannels.json()).toEqual({
      code: 'COMMUNITY_SUSPENDED',
      message: 'This community is suspended.',
    });
    expect(
      (await (await call('/api/v1/memberships', 'GET', undefined, claimantCookie)).json())
        .memberships
    ).toEqual([
      expect.objectContaining({ communityId: secondId, role: 'owner', lifecycle: 'suspended' }),
    ]);
    // Commit order does not promise delivery order: the stream rechecks live
    // authority and can close before draining an already committed entry.
    expect(
      (
        await pool.query('SELECT text FROM entries WHERE channel_id=$1 AND idempotency_key=$2', [
          secondChannelId,
          'before-suspension',
        ])
      ).rows
    ).toEqual([{ text: 'before suspension' }]);
    const finalEvent = await nextSse(secondReader);
    if (finalEvent.type === 'entry') {
      expect(finalEvent).toMatchObject({ type: 'entry', entry: { text: 'before suspension' } });
      expect((await nextSse(secondReader)).type).toBe('closed');
    } else {
      expect(finalEvent.type).toBe('closed');
    }
    expect(
      (
        await call(
          `/api/v1/communities/${firstId}/channels/${channelId}/entries`,
          'POST',
          { text: 'first remains live', idempotencyKey: 'first-remains-live' },
          admittedCookie
        )
      ).status
    ).toBe(201);
    expect((await nextSse(firstReader)).type).toBe('entry');
    await firstReader.cancel();
    await secondReader.cancel().catch(() => undefined);
    expect(
      (
        await call(
          `/api/v1/host/communities/${secondId}/lifecycle`,
          'PATCH',
          { action: 'resume', lifecycleVersion: resumeLifecycleVersion },
          ownerCookie
        )
      ).status
    ).toBe(200);
    expect(
      (
        await call(
          '/api/v1/host/communities/not-a-uuid/lifecycle',
          'PATCH',
          { action: 'resume', lifecycleVersion: resumeLifecycleVersion },
          ownerCookie
        )
      ).status
    ).toBe(404);

    const third = await call(
      '/api/v1/host/communities',
      'POST',
      { idempotencyKey: 'admission-contended-community', name: 'Contended community' },
      ownerCookie
    );
    expect(third.status).toBe(201);
    const thirdBody = await third.json();
    const claimA = await call('/api/v1/owner-claims/preflight', 'POST', {
      token: thirdBody.ownerClaimToken,
    });
    const claimB = await call('/api/v1/owner-claims/preflight', 'POST', {
      token: thirdBody.ownerClaimToken,
    });
    const contenderA = await signup(
      'Claim contender A',
      'claim-a@admission.test',
      cookieOf(claimA)
    );
    const contenderB = await signup(
      'Claim contender B',
      'claim-b@admission.test',
      cookieOf(claimB)
    );
    const claims = await Promise.all([
      call('/api/v1/owner-claims/claim', 'POST', {}, contenderA),
      call('/api/v1/owner-claims/claim', 'POST', {}, contenderB),
    ]);
    expect(claims.map((response) => response.status).sort()).toEqual([200, 403]);
    expect(
      (
        await pool.query(
          "SELECT count(*)::int AS count FROM members WHERE community_id=$1 AND role='owner' AND active",
          [thirdBody.community.id]
        )
      ).rows[0].count
    ).toBe(1);
  });
});
