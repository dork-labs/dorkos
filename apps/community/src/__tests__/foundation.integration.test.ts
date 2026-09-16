import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { serve } from '@hono/node-server';
import { migrate } from '../migrate.js';
import { createCommunityApp } from '../app.js';
import { parseConfig } from '../config.js';
import { encodeCursor } from '../cursor.js';
import { CommunityWireCommunitySchema } from '@dorkos/shared/community-wire';

const adminUrl = process.env.COMMUNITY_TEST_DATABASE_URL;
if (!adminUrl)
  throw new Error('COMMUNITY_TEST_DATABASE_URL is required for real Postgres HTTP tests');
const admin = new Pool({ connectionString: adminUrl });
const dbName = `community_foundation_${randomUUID().replaceAll('-', '')}`;
const dbUrl = new URL(adminUrl);
dbUrl.pathname = `/${dbName}`;
const config = parseConfig({
  COMMUNITY_DATABASE_URL: dbUrl.toString(),
  COMMUNITY_AUTH_SECRET: 'a'.repeat(32),
  COMMUNITY_INVITE_SECRET: 'b'.repeat(32),
  COMMUNITY_BOOTSTRAP_SECRET: 'c'.repeat(32),
  COMMUNITY_PUBLIC_URL: 'http://localhost:6481',
  COMMUNITY_STORAGE_PATH: '/tmp/community-test-blobs',
});
let server: ReturnType<typeof serve>;
let baseUrl = '';
let pool: Pool;
let ownerCookie = '';
let bobCookie = '';
let channelId = '';
let ownerMemberId = '';
let firstCursor = '';
let bobMemberId = '';
const hooks: {
  afterSnapshotWatermark?: () => Promise<void>;
  afterEntryAttachmentLookup?: () => Promise<void>;
} = {};
const sseBuffers = new WeakMap<ReadableStreamDefaultReader<Uint8Array>, string>();

async function nextSse(
  reader: ReadableStreamDefaultReader<Uint8Array>
): Promise<{ event: string; data: any; id: string }> {
  let buffer = sseBuffers.get(reader) ?? '';
  while (true) {
    const boundary = buffer.indexOf('\n\n');
    if (boundary >= 0) {
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      sseBuffers.set(reader, buffer);
      const fields = Object.fromEntries(
        frame.split('\n').map((line) => line.split(/: (.*)/s).slice(0, 2))
      );
      if (fields.data) return { event: fields.event, data: JSON.parse(fields.data), id: fields.id };
      continue;
    }
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const result = await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error('SSE event timed out')), 5_000);
      }),
    ]).finally(() => {
      if (timeout) clearTimeout(timeout);
    });
    if (result.done) throw new Error('SSE stream closed before an event');
    buffer += new TextDecoder().decode(result.value);
  }
}

async function request(path: string, options: RequestInit = {}) {
  return fetch(`${baseUrl}${path}`, options);
}
async function post(path: string, body: unknown, cookie?: string) {
  return request(path, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: config.publicUrl,
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify(body),
  });
}
function cookieOf(response: Response) {
  return response.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .join('; ');
}

beforeAll(async () => {
  await admin.query(`CREATE DATABASE ${dbName}`);
  await migrate(dbUrl.toString());
  pool = new Pool({ connectionString: dbUrl.toString() });
  const app = createCommunityApp({ config, pool, hooks });
  server = serve({ fetch: app.fetch, port: 0 });
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing HTTP address');
  baseUrl = `http://localhost:${address.port}`;
});
afterAll(async () => {
  await new Promise<void>((resolve) => server?.close(() => resolve()));
  await pool?.end();
  await admin.query(`DROP DATABASE IF EXISTS ${dbName}`);
  await admin.end();
});

describe('owner foundation over real HTTP and Postgres', () => {
  it('rejects sessionless access and permits exactly one owner claim', async () => {
    expect((await request('/api/v1/channels')).status).toBe(401);
    expect((await request('/api/v1/community')).status).toBe(404);
    const oversized = await post('/api/v1/bootstrap/preflight', { secret: 'x'.repeat(100_000) });
    expect(oversized.status).toBe(413);
    const chunkedBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"secret":"'));
        controller.enqueue(new TextEncoder().encode('x'.repeat(100_000)));
        controller.enqueue(new TextEncoder().encode('"}'));
        controller.close();
      },
    });
    const chunked = await request('/api/v1/bootstrap/preflight', {
      method: 'POST',
      headers: { origin: config.publicUrl, 'content-type': 'application/json' },
      body: chunkedBody,
      duplex: 'half',
    } as RequestInit & { duplex: 'half' });
    expect(chunked.status).toBe(413);
    const preflight = await post('/api/v1/bootstrap/preflight', { secret: config.bootstrapSecret });
    expect(preflight.status).toBe(200);
    const grant = cookieOf(preflight);
    expect(grant).toContain('community_bootstrap=');

    const signup = await post(
      '/api/auth/sign-up/email',
      { name: 'Owner', email: 'owner@example.test', password: 'password1234' },
      grant
    );
    expect(signup.status).toBe(200);
    ownerCookie = `${grant}; ${cookieOf(signup)}`;
    const bobSignup = await post(
      '/api/auth/sign-up/email',
      { name: 'Bob', email: 'bob@example.test', password: 'password1234' },
      grant
    );
    expect(bobSignup.status).toBe(200);
    bobCookie = `${grant}; ${cookieOf(bobSignup)}`;
    expect((await request('/api/v1/channels', { headers: { cookie: ownerCookie } })).status).toBe(
      403
    );

    const [one, two] = await Promise.all([
      post(
        '/api/v1/bootstrap/claim',
        { secret: config.bootstrapSecret, name: 'Test community' },
        ownerCookie
      ),
      post(
        '/api/v1/bootstrap/claim',
        { secret: config.bootstrapSecret, name: 'Test community' },
        ownerCookie
      ),
    ]);
    expect([one.status, two.status].sort()).toEqual([200, 403]);
    expect(
      (await pool.query("SELECT count(*)::int AS count FROM members WHERE role='owner' AND active"))
        .rows[0].count
    ).toBe(1);
    expect(
      (await post('/api/v1/bootstrap/preflight', { secret: config.bootstrapSecret })).status
    ).toBe(409);
    expect(
      (
        await post(
          '/api/auth/sign-up/email',
          { name: 'Late', email: 'late@example.test', password: 'password1234' },
          grant
        )
      ).status
    ).toBe(403);
    expect((await request('/api/v1/channels', { headers: { cookie: bobCookie } })).status).toBe(
      403
    );
    ownerMemberId = (await pool.query("SELECT id FROM members WHERE role='owner'")).rows[0].id;
    const publicCommunity = await request('/api/v1/community');
    expect(publicCommunity.status).toBe(200);
    const publicBody = await publicCommunity.json();
    expect(CommunityWireCommunitySchema.parse(publicBody)).toEqual(publicBody);
    expect(Object.keys(publicBody).sort()).toEqual(['createdAt', 'description', 'id', 'name']);

    const foreignOrigin = await request('/api/v1/channels', {
      method: 'POST',
      headers: {
        cookie: ownerCookie,
        origin: 'https://untrusted.example',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ name: 'Rejected' }),
    });
    expect(foreignOrigin.status).toBe(403);

    const created = await post('/api/v1/channels', { name: 'General' }, ownerCookie);
    expect(created.status).toBe(201);
    const channel = (await created.json()).channel;
    channelId = channel.id;
    const first = await post(
      `/api/v1/channels/${channel.id}/entries`,
      { text: 'hello', idempotencyKey: 'one' },
      ownerCookie
    );
    expect(first.status).toBe(201);
    const receipt = await first.json();
    firstCursor = receipt.cursor;
    expect(receipt.entry.seq).toBe(1);
    const repeat = await post(
      `/api/v1/channels/${channel.id}/entries`,
      { text: 'hello', idempotencyKey: 'one' },
      ownerCookie
    );
    expect(repeat.status).toBe(200);
    expect((await repeat.json()).entry.id).toBe(receipt.entry.id);
    const conflict = await post(
      `/api/v1/channels/${channel.id}/entries`,
      { text: 'changed', idempotencyKey: 'one' },
      ownerCookie
    );
    expect(conflict.status).toBe(409);
    expect((await pool.query('SELECT count(*)::int AS count FROM entries')).rows[0].count).toBe(1);
  });

  it('commits parallel posts in one gap-free channel sequence', async () => {
    const responses = await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        post(
          `/api/v1/channels/${channelId}/entries`,
          { text: `parallel ${index}`, idempotencyKey: `parallel-${index}` },
          ownerCookie
        )
      )
    );
    expect(responses.every((response) => response.status === 201)).toBe(true);
    const rows = await pool.query<{ seq: string; text: string }>(
      'SELECT seq,text FROM entries WHERE channel_id=$1 ORDER BY seq',
      [channelId]
    );
    expect(rows.rows.map((row) => Number(row.seq))).toEqual(
      Array.from({ length: 13 }, (_, index) => index + 1)
    );
    expect(new Set(rows.rows.map((row) => row.text)).size).toBe(13);
  });

  it('rejects nested and foreign parents, and binds page cursors to channel and thread', async () => {
    const root = await post(
      `/api/v1/channels/${channelId}/entries`,
      { text: 'root', idempotencyKey: 'thread-root' },
      ownerCookie
    );
    expect(root.status).toBe(201);
    const rootId = (await root.json()).entry.id;
    const reply = await post(
      `/api/v1/channels/${channelId}/entries`,
      { text: 'reply', parentEntryId: rootId, idempotencyKey: 'thread-reply' },
      ownerCookie
    );
    expect(reply.status).toBe(201);
    const replyEntry = (await reply.json()).entry;
    const replyId = replyEntry.id;
    const nested = await post(
      `/api/v1/channels/${channelId}/entries`,
      { text: 'nested', parentEntryId: replyId, idempotencyKey: 'thread-nested' },
      ownerCookie
    );
    expect(nested.status).toBe(409);
    expect((await nested.json()).code).toBe('NESTED_THREAD');
    const second = await post('/api/v1/channels', { name: 'Second' }, ownerCookie);
    const otherId = (await second.json()).channel.id;
    expect(
      (
        await post(
          `/api/v1/channels/${otherId}/entries`,
          { text: 'foreign', parentEntryId: rootId, idempotencyKey: 'foreign' },
          ownerCookie
        )
      ).status
    ).toBe(404);

    const page = await request(`/api/v1/channels/${channelId}/entries?limit=2`, {
      headers: { cookie: ownerCookie },
    });
    expect(page.status).toBe(200);
    const body = await page.json();
    expect(body.entries).toHaveLength(2);
    expect(body.nextCursor).toBeTruthy();
    const foreignCursor = await request(
      `/api/v1/channels/${otherId}/entries?cursor=${encodeURIComponent(body.nextCursor)}`,
      { headers: { cookie: ownerCookie } }
    );
    expect(foreignCursor.status).toBe(410);
    const thread = await request(`/api/v1/channels/${channelId}/entries?thread=${rootId}`, {
      headers: { cookie: ownerCookie },
    });
    const threadPage = await thread.json();
    expect(threadPage.entries.map((entry: { id: string }) => entry.id)).toEqual([rootId, replyId]);
    expect(threadPage.nextCursor).toBeNull();
    expect(threadPage.entries[1].cursor).toBe(replyEntry.cursor);
    const resumed = await request(`/api/v1/channels/${channelId}/events`, {
      headers: { cookie: ownerCookie, 'last-event-id': replyEntry.cursor },
    });
    expect(resumed.status).toBe(200);
    const resumeReader = resumed.body!.getReader();
    expect((await nextSse(resumeReader)).event).toBe('snapshot');
    await resumeReader.cancel();
    expect(
      (
        await request(
          `/api/v1/channels/${channelId}/entries?thread=${rootId}&cursor=${encodeURIComponent(body.nextCursor)}`,
          { headers: { cookie: ownerCookie } }
        )
      ).status
    ).toBe(410);
  });

  it('keeps read cursors monotonic and rejects over-advance', async () => {
    const first = await request(`/api/v1/channels/${channelId}/read-cursor`, {
      headers: { cookie: ownerCookie },
    });
    expect(first.status).toBe(200);
    const advance = await request(`/api/v1/channels/${channelId}/read-cursor`, {
      method: 'PUT',
      headers: { cookie: ownerCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ cursor: firstCursor }),
    });
    expect(advance.status).toBe(200);
    const current = await advance.json();
    expect(current.unreadCount).toBeGreaterThan(0);
    const again = await request(`/api/v1/channels/${channelId}/read-cursor`, {
      method: 'PUT',
      headers: { cookie: ownerCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ cursor: firstCursor }),
    });
    expect((await again.json()).cursor).toBe(current.cursor);
    const communityId = (await pool.query<{ id: string }>('SELECT id FROM communities')).rows[0]!
      .id;
    const future = encodeCursor(
      { version: 1, communityId, channelId, thread: null, epoch: 1, seq: 999_999 },
      config
    );
    const tooFar = await request(`/api/v1/channels/${channelId}/read-cursor`, {
      method: 'PUT',
      headers: { cookie: ownerCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ cursor: future }),
    });
    expect(tooFar.status).toBe(409);
  });

  it('enforces discover, join, moderator and archive rights on live rows', async () => {
    const communityId = (await pool.query('SELECT id FROM communities')).rows[0].id;
    const bobUserId = (await pool.query('SELECT id FROM "user" WHERE email=\'bob@example.test\''))
      .rows[0].id;
    const admitted = await pool.query<{ id: string }>(
      "INSERT INTO members(community_id,user_id,display_name,handle,role) VALUES($1,$2,'Bob','bob','member') RETURNING id",
      [communityId, bobUserId]
    );
    bobMemberId = admitted.rows[0].id;
    await pool.query(
      'INSERT INTO community_handles(community_id,handle,member_id) VALUES($1,$2,$3)',
      [communityId, 'bob', bobMemberId]
    );
    const listed = await request('/api/v1/channels', { headers: { cookie: bobCookie } });
    expect(listed.status).toBe(200);
    expect(
      (await listed.json()).channels.find((channel: { id: string }) => channel.id === channelId)
        .joined
    ).toBe(false);
    expect(
      (await request(`/api/v1/channels/${channelId}/entries`, { headers: { cookie: bobCookie } }))
        .status
    ).toBe(403);
    expect(
      (
        await post(
          `/api/v1/channels/${channelId}/entries`,
          { text: 'no', idempotencyKey: 'bob-no' },
          bobCookie
        )
      ).status
    ).toBe(403);
    expect((await post('/api/v1/channels', { name: 'Denied' }, bobCookie)).status).toBe(403);
    expect(
      (
        await request(`/api/v1/channels/${channelId}/join`, {
          method: 'POST',
          headers: { cookie: bobCookie },
        })
      ).status
    ).toBe(200);
    expect(
      (await request(`/api/v1/channels/${channelId}/entries`, { headers: { cookie: bobCookie } }))
        .status
    ).toBe(200);
    const mention = await post(
      `/api/v1/channels/${channelId}/entries`,
      { text: 'hi @bob and @unknown', idempotencyKey: 'mention-bob' },
      ownerCookie
    );
    expect(mention.status).toBe(201);
    expect((await mention.json()).entry.mentions).toEqual([bobMemberId]);
    await pool.query("UPDATE members SET display_name='Robert' WHERE id=$1", [bobMemberId]);
    const stable = await post(
      `/api/v1/channels/${channelId}/entries`,
      { text: 'again @bob', idempotencyKey: 'mention-stable' },
      ownerCookie
    );
    const stableBody = await stable.json();
    expect(stableBody.entry.mentions).toEqual([bobMemberId]);
    expect(
      (await pool.query('SELECT mentions FROM entries WHERE id=$1', [stableBody.entry.id])).rows[0]
        .mentions
    ).toEqual([bobMemberId]);
    const roster = await request(`/api/v1/channels/${channelId}/members`, {
      headers: { cookie: ownerCookie },
    });
    expect(
      (await roster.json()).members.find(
        (member: { memberId: string }) => member.memberId === bobMemberId
      ).handle
    ).toBe('bob');
    const promote = await request(`/api/v1/members/${bobMemberId}/role`, {
      method: 'PATCH',
      headers: {
        cookie: ownerCookie,
        origin: config.publicUrl,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ role: 'admin' }),
    });
    expect(promote.status).toBe(200);
    expect((await promote.json()).member.role).toBe('admin');
    expect((await post('/api/v1/channels', { name: 'Admin channel' }, bobCookie)).status).toBe(201);
    const forbiddenPromotion = await request(`/api/v1/members/${ownerMemberId}/role`, {
      method: 'PATCH',
      headers: { cookie: bobCookie, origin: config.publicUrl, 'content-type': 'application/json' },
      body: JSON.stringify({ role: 'member' }),
    });
    expect(forbiddenPromotion.status).toBe(403);
    const demote = await request(`/api/v1/members/${bobMemberId}/role`, {
      method: 'PATCH',
      headers: {
        cookie: ownerCookie,
        origin: config.publicUrl,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ role: 'member' }),
    });
    expect(demote.status).toBe(200);
    expect((await demote.json()).member.role).toBe('member');

    const privateRoom = await post(
      '/api/v1/channels',
      { name: 'Private', visibility: 'private' },
      ownerCookie
    );
    const privateId = (await privateRoom.json()).channel.id;
    expect(
      (await request(`/api/v1/channels/${privateId}`, { headers: { cookie: bobCookie } })).status
    ).toBe(404);
    expect(
      (await request(`/api/v1/channels/${privateId}/entries`, { headers: { cookie: bobCookie } }))
        .status
    ).toBe(404);
    expect(
      (
        await request(`/api/v1/members/${bobMemberId}/role`, {
          method: 'PATCH',
          headers: { cookie: ownerCookie, 'content-type': 'application/json' },
          body: JSON.stringify({ role: 'admin' }),
        })
      ).status
    ).toBe(200);
    const hiddenList = await request('/api/v1/channels', { headers: { cookie: bobCookie } });
    expect(
      (await hiddenList.json()).channels.some((channel: { id: string }) => channel.id === privateId)
    ).toBe(false);
    expect(
      (await request(`/api/v1/channels/${privateId}`, { headers: { cookie: bobCookie } })).status
    ).toBe(404);
    expect(
      (await post(`/api/v1/channels/${privateId}/members`, { memberId: bobMemberId }, ownerCookie))
        .status
    ).toBe(200);
    const visibleList = await request('/api/v1/channels', { headers: { cookie: bobCookie } });
    expect(
      (await visibleList.json()).channels.some(
        (channel: { id: string }) => channel.id === privateId
      )
    ).toBe(true);
    expect(
      (await request(`/api/v1/channels/${privateId}`, { headers: { cookie: bobCookie } })).status
    ).toBe(200);
    expect(
      (
        await request(`/api/v1/channels/${privateId}/members/${bobMemberId}`, {
          method: 'DELETE',
          headers: { cookie: ownerCookie },
        })
      ).status
    ).toBe(200);
    expect(
      (await request(`/api/v1/channels/${privateId}`, { headers: { cookie: bobCookie } })).status
    ).toBe(404);
    expect(
      (
        await request(`/api/v1/members/${bobMemberId}/role`, {
          method: 'PATCH',
          headers: { cookie: ownerCookie, 'content-type': 'application/json' },
          body: JSON.stringify({ role: 'member' }),
        })
      ).status
    ).toBe(200);
    const removed = await request(`/api/v1/channels/${channelId}/members/${bobMemberId}`, {
      method: 'DELETE',
      headers: { cookie: ownerCookie },
    });
    expect(removed.status).toBe(200);
    expect(
      (await request(`/api/v1/channels/${channelId}/entries`, { headers: { cookie: bobCookie } }))
        .status
    ).toBe(403);
    const archived = await request(`/api/v1/channels/${channelId}`, {
      method: 'PATCH',
      headers: { cookie: ownerCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ archived: true }),
    });
    expect(archived.status).toBe(200);
    expect(
      (await request(`/api/v1/channels/${channelId}/entries`, { headers: { cookie: ownerCookie } }))
        .status
    ).toBe(200);
    expect(
      (
        await post(
          `/api/v1/channels/${channelId}/entries`,
          { text: 'after archive', idempotencyKey: 'archived' },
          ownerCookie
        )
      ).status
    ).toBe(409);
  });

  it('projects an agent post key only to its authenticated owner across history and snapshots', async () => {
    const created = await post('/api/v1/channels', { name: 'Owner correlation' }, ownerCookie);
    expect(created.status).toBe(201);
    const id = (await created.json()).channel.id as string;
    expect(
      (
        await request(`/api/v1/channels/${id}/join`, {
          method: 'POST',
          headers: { cookie: bobCookie },
        })
      ).status
    ).toBe(200);
    const communityId = (await pool.query<{ id: string }>('SELECT id FROM communities')).rows[0]!
      .id;
    const agent = await pool.query<{ id: string }>(
      `INSERT INTO agents(community_id,owner_member_id,display_name,handle,local_agent_id)
       VALUES($1,$2,'Owner worker','owner-worker','owner-worker-local') RETURNING id`,
      [communityId, ownerMemberId]
    );
    await pool.query('INSERT INTO agent_channel_members(channel_id,agent_id) VALUES($1,$2)', [
      id,
      agent.rows[0]!.id,
    ]);
    const sequence = await pool.query<{ last_seq: string }>(
      'UPDATE channels SET last_seq=last_seq+1 WHERE id=$1 RETURNING last_seq',
      [id]
    );
    await pool.query(
      `INSERT INTO entries(channel_id,seq,author_member_id,author_agent_id,author_display_name,text,mentions,parent_entry_id,thread_root_entry_id,idempotency_key,payload_hash)
       VALUES($1,$2,NULL,$3,'Owner worker','private correlation',ARRAY[]::uuid[],NULL,NULL,'owner-wire-key','test-hash')`,
      [id, sequence.rows[0]!.last_seq, agent.rows[0]!.id]
    );

    const [ownerHistory, bobHistory] = await Promise.all([
      request(`/api/v1/channels/${id}/entries`, { headers: { cookie: ownerCookie } }),
      request(`/api/v1/channels/${id}/entries`, { headers: { cookie: bobCookie } }),
    ]);
    expect(ownerHistory.status).toBe(200);
    expect(bobHistory.status).toBe(200);
    expect((await ownerHistory.json()).entries[0].originIdempotencyKey).toBe('owner-wire-key');
    expect((await bobHistory.json()).entries[0].originIdempotencyKey).toBeUndefined();

    const [ownerEvents, bobEvents] = await Promise.all([
      request(`/api/v1/channels/${id}/events`, { headers: { cookie: ownerCookie } }),
      request(`/api/v1/channels/${id}/events`, { headers: { cookie: bobCookie } }),
    ]);
    const ownerReader = ownerEvents.body!.getReader();
    const bobReader = bobEvents.body!.getReader();
    expect((await nextSse(ownerReader)).data.entries[0].originIdempotencyKey).toBe(
      'owner-wire-key'
    );
    expect((await nextSse(bobReader)).data.entries[0].originIdempotencyKey).toBeUndefined();
    await ownerReader.cancel();
    await bobReader.cancel();
    await pool.query('DELETE FROM entries WHERE channel_id=$1', [id]);
    await pool.query('DELETE FROM agent_channel_members WHERE channel_id=$1 AND agent_id=$2', [
      id,
      agent.rows[0]!.id,
    ]);
    await pool.query('DELETE FROM agents WHERE id=$1', [agent.rows[0]!.id]);
  });

  it('rejects a channel create if admin authority is removed while the insert waits', async () => {
    expect(
      (
        await request(`/api/v1/members/${bobMemberId}/role`, {
          method: 'PATCH',
          headers: { cookie: ownerCookie, 'content-type': 'application/json' },
          body: JSON.stringify({ role: 'admin' }),
        })
      ).status
    ).toBe(200);
    const blocker = await pool.connect();
    try {
      await blocker.query('BEGIN');
      await blocker.query('LOCK TABLE channels IN ACCESS EXCLUSIVE MODE');
      const pending = post('/api/v1/channels', { name: 'After demotion' }, bobCookie);
      let waiting = false;
      for (let attempt = 0; attempt < 40; attempt += 1) {
        const state = await pool.query<{ waiting: boolean }>(
          `SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE query LIKE 'INSERT INTO channels%'
             AND wait_event_type='Lock') AS waiting`
        );
        waiting = state.rows[0].waiting;
        if (waiting) break;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(waiting).toBe(true);
      expect(
        (
          await request(`/api/v1/members/${bobMemberId}/role`, {
            method: 'PATCH',
            headers: { cookie: ownerCookie, 'content-type': 'application/json' },
            body: JSON.stringify({ role: 'member' }),
          })
        ).status
      ).toBe(200);
      await blocker.query('COMMIT');
      expect((await pending).status).toBe(403);
    } finally {
      await blocker.query('ROLLBACK').catch(() => undefined);
      blocker.release();
    }
    expect(
      (await pool.query("SELECT count(*)::int AS count FROM channels WHERE name='After demotion'"))
        .rows[0].count
    ).toBe(0);
  });

  it('refuses a read cursor when membership is revoked before its channel lock', async () => {
    const created = await post('/api/v1/channels', { name: 'Cursor race' }, ownerCookie);
    const id = (await created.json()).channel.id;
    expect(
      (await post(`/api/v1/channels/${id}/members`, { memberId: bobMemberId }, ownerCookie)).status
    ).toBe(200);
    const entry = await post(
      `/api/v1/channels/${id}/entries`,
      { text: 'cursor race', idempotencyKey: 'cursor-race' },
      ownerCookie
    );
    const cursor = (await entry.json()).entry.cursor;
    const setCursor = () =>
      request(`/api/v1/channels/${id}/read-cursor`, {
        method: 'PUT',
        headers: { cookie: bobCookie, 'content-type': 'application/json' },
        body: JSON.stringify({ cursor }),
      });
    expect((await setCursor()).status).toBe(200);
    const blocker = await pool.connect();
    try {
      await blocker.query('BEGIN');
      await blocker.query('SELECT id FROM channels WHERE id=$1 FOR UPDATE', [id]);
      await blocker.query('DELETE FROM channel_members WHERE channel_id=$1 AND member_id=$2', [
        id,
        bobMemberId,
      ]);
      const pending = setCursor();
      let settled = false;
      void pending.then(() => {
        settled = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(settled).toBe(false);
      await blocker.query('COMMIT');
      expect((await pending).status).toBe(403);
    } finally {
      await blocker.query('ROLLBACK').catch(() => undefined);
      blocker.release();
    }
    expect(
      (await request(`/api/v1/channels/${id}/read-cursor`, { headers: { cookie: bobCookie } }))
        .status
    ).toBe(404);
  });

  it('serializes the author quota across different channel locks', async () => {
    const one = await post('/api/v1/channels', { name: 'Quota one' }, ownerCookie);
    const two = await post('/api/v1/channels', { name: 'Quota two' }, ownerCookie);
    const firstId = (await one.json()).channel.id;
    const secondId = (await two.json()).channel.id;
    const originalLimit = config.limits.postsPerTenMinutes;
    const count = Number(
      (
        await pool.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM entries WHERE author_member_id=$1 AND created_at>now()-interval '10 minutes'`,
          [ownerMemberId]
        )
      ).rows[0].count
    );
    config.limits.postsPerTenMinutes = count + 1;
    try {
      const responses = await Promise.all([
        post(
          `/api/v1/channels/${firstId}/entries`,
          { text: 'quota one', idempotencyKey: 'quota-one' },
          ownerCookie
        ),
        post(
          `/api/v1/channels/${secondId}/entries`,
          { text: 'quota two', idempotencyKey: 'quota-two' },
          ownerCookie
        ),
      ]);
      expect(responses.map((response) => response.status).sort()).toEqual([201, 429]);
    } finally {
      config.limits.postsPerTenMinutes = originalLimit;
    }
  });

  it('replays committed entries and closes a stream after membership revocation', async () => {
    const created = await post('/api/v1/channels', { name: 'Live' }, ownerCookie);
    const id = (await created.json()).channel.id;
    await request(`/api/v1/channels/${id}/members`, {
      method: 'POST',
      headers: { cookie: ownerCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ memberId: bobMemberId }),
    });
    const controller = new AbortController();
    const response = await request(`/api/v1/channels/${id}/events`, {
      headers: { cookie: bobCookie },
      signal: controller.signal,
    });
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    try {
      const snapshot = await nextSse(reader);
      expect(snapshot.event).toBe('snapshot');
      await new Promise((resolve) => setTimeout(resolve, 650));
      const posted = await post(
        `/api/v1/channels/${id}/entries`,
        { text: 'live message', idempotencyKey: 'live-one' },
        ownerCookie
      );
      expect(posted.status).toBe(201);
      const receipt = await posted.json();
      const live = await nextSse(reader);
      expect(live.event).toBe('entry');
      expect(live.data.entry.id).toBe(receipt.entry.id);
      const replay = await request(`/api/v1/channels/${id}/events`, {
        headers: { cookie: bobCookie, 'last-event-id': snapshot.id },
        signal: controller.signal,
      });
      const replayReader = replay.body!.getReader();
      const replaySnapshot = await nextSse(replayReader);
      expect(replaySnapshot.event).toBe('snapshot');
      const replayed = replaySnapshot.data.entries.some(
        (entry: { id: string }) => entry.id === receipt.entry.id
      )
        ? receipt.entry.id
        : (await nextSse(replayReader)).data.entry.id;
      expect(replayed).toBe(receipt.entry.id);
      await replayReader.cancel();
      const removed = await request(`/api/v1/channels/${id}/members/${bobMemberId}`, {
        method: 'DELETE',
        headers: { cookie: ownerCookie },
      });
      expect(removed.status).toBe(200);
      const closed = await nextSse(reader);
      expect(closed.event).toBe('closed');
      expect(
        (
          await request(`/api/v1/channels/${id}/events`, {
            headers: { cookie: bobCookie, 'last-event-id': live.id },
          })
        ).status
      ).toBe(404);
    } finally {
      controller.abort();
      await reader.cancel().catch(() => undefined);
    }
  });

  it('does not emit an entry if access ends during attachment enrichment', async () => {
    const created = await post('/api/v1/channels', { name: 'Enrichment revocation' }, ownerCookie);
    const id = (await created.json()).channel.id;
    await pool.query('INSERT INTO channel_members(channel_id,member_id) VALUES($1,$2)', [
      id,
      bobMemberId,
    ]);
    let entered!: () => void;
    let release!: () => void;
    const atEnrichment = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    hooks.afterEntryAttachmentLookup = async () => {
      entered();
      await held;
    };
    const controller = new AbortController();
    const response = await request(`/api/v1/channels/${id}/events`, {
      headers: { cookie: bobCookie },
      signal: controller.signal,
    });
    const reader = response.body!.getReader();
    try {
      expect((await nextSse(reader)).event).toBe('snapshot');
      expect(
        (
          await post(
            `/api/v1/channels/${id}/entries`,
            {
              text: 'must stay private',
              idempotencyKey: 'enrichment-revoked',
            },
            ownerCookie
          )
        ).status
      ).toBe(201);
      await atEnrichment;
      await pool.query('DELETE FROM channel_members WHERE channel_id=$1 AND member_id=$2', [
        id,
        bobMemberId,
      ]);
      release();
      const event = await nextSse(reader);
      expect(event.event).toBe('closed');
      expect(JSON.stringify(event.data)).not.toContain('must stay private');
    } finally {
      release();
      hooks.afterEntryAttachmentLookup = undefined;
      controller.abort();
      await reader.cancel().catch(() => undefined);
    }
  });

  it('closes an active stream when its sign-in session is revoked', async () => {
    const created = await post('/api/v1/channels', { name: 'Session revocation' }, ownerCookie);
    const id = (await created.json()).channel.id;
    expect(
      (await post(`/api/v1/channels/${id}/members`, { memberId: bobMemberId }, ownerCookie)).status
    ).toBe(200);
    const controller = new AbortController();
    const response = await request(`/api/v1/channels/${id}/events`, {
      headers: { cookie: bobCookie },
      signal: controller.signal,
    });
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    try {
      expect((await nextSse(reader)).event).toBe('snapshot');
      await pool.query(
        `DELETE FROM session WHERE "userId"=(SELECT user_id FROM members WHERE id=$1)`,
        [bobMemberId]
      );
      expect(
        (await request(`/api/v1/channels/${id}/entries`, { headers: { cookie: bobCookie } })).status
      ).toBe(401);
      expect(
        (
          await post(
            `/api/v1/channels/${id}/entries`,
            { text: 'after sign-out', idempotencyKey: 'after-sign-out' },
            ownerCookie
          )
        ).status
      ).toBe(201);
      const next = await nextSse(reader);
      expect(next.event).toBe('closed');
    } finally {
      controller.abort();
      await reader.cancel().catch(() => undefined);
    }
  });

  it('does not duplicate a write committed between snapshot watermark and replay', async () => {
    const created = await post('/api/v1/channels', { name: 'Transition' }, ownerCookie);
    const id = (await created.json()).channel.id;
    let entered!: () => void;
    let release!: () => void;
    const atBarrier = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    hooks.afterSnapshotWatermark = async () => {
      entered();
      await held;
    };
    const controller = new AbortController();
    try {
      const opening = request(`/api/v1/channels/${id}/events`, {
        headers: { cookie: ownerCookie },
        signal: controller.signal,
      });
      await atBarrier;
      const posted = await post(
        `/api/v1/channels/${id}/entries`,
        { text: 'during transition', idempotencyKey: 'transition' },
        ownerCookie
      );
      expect(posted.status).toBe(201);
      const receipt = await posted.json();
      release();
      const response = await opening;
      const reader = response.body!.getReader();
      const snapshot = await nextSse(reader);
      expect(snapshot.data.entries).toEqual([]);
      const event = await nextSse(reader);
      expect(event.data.entry.id).toBe(receipt.entry.id);
      expect(event.data.entry.seq).toBe(1);
      await reader.cancel();
    } finally {
      hooks.afterSnapshotWatermark = undefined;
      release();
      controller.abort();
    }
  });

  it('replays more than 256 durable entries after a slow reader without a reconnect loop', async () => {
    const created = await post('/api/v1/channels', { name: 'Catchup' }, ownerCookie);
    const id = (await created.json()).channel.id;
    const first = await post(
      `/api/v1/channels/${id}/entries`,
      { text: 'first', idempotencyKey: 'catchup-first' },
      ownerCookie
    );
    const cursor = (await first.json()).cursor;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('UPDATE channels SET last_seq=270 WHERE id=$1', [id]);
      await client.query(
        `INSERT INTO entries(channel_id,seq,author_member_id,author_display_name,text,idempotency_key,payload_hash)
         SELECT $1,n,$2,'Owner','bulk-'||n,'bulk-'||n,'test' FROM generate_series(2,270) AS n`,
        [id, ownerMemberId]
      );
      await client.query('COMMIT');
    } finally {
      client.release();
    }
    const controller = new AbortController();
    const response = await request(`/api/v1/channels/${id}/events`, {
      headers: { cookie: ownerCookie, 'last-event-id': cursor },
      signal: controller.signal,
    });
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    try {
      const snapshot = await nextSse(reader);
      expect(snapshot.event).toBe('snapshot');
      await new Promise((resolve) => setTimeout(resolve, 700));
      const seen = snapshot.data.entries.map((entry: { seq: number }) => entry.seq);
      for (let index = seen.length; index < 269; index += 1) {
        const event = await nextSse(reader);
        expect(event.event).toBe('entry');
        seen.push(event.data.entry.seq);
      }
      expect(seen).toEqual(Array.from({ length: 269 }, (_, index) => index + 2));
    } finally {
      controller.abort();
      await reader.cancel().catch(() => undefined);
    }
    const communityId = (await pool.query<{ id: string }>('SELECT id FROM communities')).rows[0]!
      .id;
    const future = encodeCursor(
      { version: 1, communityId, channelId: id, thread: null, epoch: 1, seq: 9999 },
      config
    );
    expect(
      (
        await request(`/api/v1/channels/${id}/events`, {
          headers: { cookie: ownerCookie, 'last-event-id': future },
        })
      ).status
    ).toBe(410);
    expect(
      (
        await request(`/api/v1/channels/${id}/events`, {
          headers: { cookie: ownerCookie, 'last-event-id': firstCursor },
        })
      ).status
    ).toBe(410);
  });
});
