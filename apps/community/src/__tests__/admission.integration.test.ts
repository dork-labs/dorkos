import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { serve } from '@hono/node-server';
import { migrate } from '../migrate.js';
import { createCommunityApp } from '../app.js';
import { parseConfig } from '../config.js';

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
  COMMUNITY_PAIRING_ATTEMPTS_PER_MINUTE: 100,
});
let server: ReturnType<typeof serve>;
let pool: Pool;
let baseUrl: string;
let ownerCookie: string;
let ownerId: string;
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
  const admitted = await call('/api/v1/invites/redeem', 'POST', { token }, cookie);
  expect(admitted.status).toBe(200);
  return { cookie, id: (await admitted.json()).memberId };
}

function cookieOf(response: Response) {
  return response.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .join('; ');
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
  const preflight = await call('/api/v1/bootstrap/preflight', 'POST', {
    secret: config.bootstrapSecret,
  });
  const grant = cookieOf(preflight);
  ownerCookie = await signup('Owner', 'owner@admission.test', grant);
  expect(
    (
      await call(
        '/api/v1/bootstrap/claim',
        'POST',
        {
          secret: config.bootstrapSecret,
          name: 'Admission test',
        },
        ownerCookie
      )
    ).status
  ).toBe(200);
  ownerId = (await pool.query("SELECT id FROM members WHERE role='owner'")).rows[0].id;
  const channel = await call('/api/v1/channels', 'POST', { name: 'General' }, ownerCookie);
  expect(channel.status).toBe(201);
  channelId = (await channel.json()).channel.id;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server?.close(() => resolve()));
  await pool?.end();
  await admin.query(`DROP DATABASE IF EXISTS ${dbName}`);
  await admin.end();
});

describe('signed admission over real HTTP and Postgres', () => {
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
    const results = await Promise.all([
      call('/api/v1/invites/redeem', 'POST', { token }, aCookie),
      call('/api/v1/invites/redeem', 'POST', { token }, bCookie),
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
    expect((await call('/api/v1/invites/redeem', 'POST', { token }, admittedCookie)).status).toBe(
      200
    );
    expect(
      (await pool.query('SELECT use_count FROM invites WHERE id=$1', [invite.id])).rows[0].use_count
    ).toBe(1);
    const loserCookie = winner === 0 ? bCookie : aCookie;
    expect((await call('/api/v1/channels', 'GET', undefined, loserCookie)).status).toBe(403);
    const recovery = await call('/api/v1/invites', 'POST', {}, ownerCookie);
    const recoveryToken = (await recovery.json()).token;
    const recoveryPreflight = await call('/api/v1/invites/preflight', 'POST', {
      token: recoveryToken,
    });
    const recoveryCookie = `${loserCookie
      .split('; ')
      .filter((part) => !part.startsWith('community_admission='))
      .join('; ')}; ${cookieOf(recoveryPreflight)}`;
    expect(
      (await call('/api/v1/invites/redeem', 'POST', { token: recoveryToken }, recoveryCookie))
        .status
    ).toBe(200);
    expect((await call('/api/v1/invites/preview', 'POST', { token: `${token}x` })).status).toBe(
      403
    );
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
    expect(approvalUrl).toContain(pairingId);
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
    const listed = await call('/api/v1/me/grants', 'GET', undefined, ownerCookie);
    expect(listed.status).toBe(200);
    expect(JSON.stringify(await listed.json())).not.toContain(token);
    const stream = await bearerCall(`/api/v1/channels/${channelId}/events`, 'GET', token);
    expect(stream.status).toBe(200);
    const reader = stream.body!.getReader();
    try {
      expect((await nextSse(reader)).type).toBe('snapshot');
      expect(
        (await call(`/api/v1/me/grants/${grant.id}`, 'DELETE', undefined, ownerCookie)).status
      ).toBe(204);
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
    expect((await call('/api/v1/channels', 'GET', undefined, ordinary.cookie)).status).toBe(401);
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
      expect(
        (
          await call(
            '/api/v1/owner/transfer',
            'POST',
            {
              successorMemberId: ownerId,
              password: 'password1234',
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
    expect((await call('/api/v1/me/leave', 'POST', {}, ownerCookie)).status).toBe(403);
    const wrong = await call(
      '/api/v1/owner/transfer',
      'POST',
      {
        successorMemberId: admittedId,
        password: 'wrong-password',
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
          },
          ownerCookie
        )
      )
    );
    expect(transfers.map((response) => response.status).sort()).toEqual([200, 403]);
    const owners = await pool.query("SELECT id FROM members WHERE role='owner' AND active");
    expect(owners.rows.map((row) => row.id)).toEqual([admittedId]);
    expect((await call('/api/v1/me/leave', 'POST', {}, ownerCookie)).status).toBe(204);
    expect((await call('/api/v1/channels', 'GET', undefined, ownerCookie)).status).toBe(401);
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
    const redeemed = await call(
      '/api/v1/invites/redeem',
      'POST',
      { token: inviteToken },
      otherCookie
    );
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
});
