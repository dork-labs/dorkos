/**
 * Live channel streams wake on Postgres notices (spec official-community-space, D12 and D13).
 *
 * The main server here re-reads a quiet stream only every five minutes, so anything that reaches
 * a stream within a few seconds reached it through a notice. Each revocation source the stream's
 * access check covers gets its own test: change it through the real route, and the stream must
 * end promptly with no message posted to wake it.
 */
import { randomUUID } from 'node:crypto';
import { createServer, connect, type Server, type Socket } from 'node:net';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCommunityApp } from '../app.js';
import { LiveHub } from '../live/hub.js';
import { LIVE_LISTENER_APPLICATION_NAME } from '../live/listener.js';
import { LIVE_NOTICE_CHANNEL, parseLiveNotice, type LiveNotice } from '../live/notices.js';
import { clearAccountAccess } from '../sign-in/account-access.js';
import { eraseMembership } from '../erasure/erasure.js';
import { sweepCommunityDeletions } from '../deletion-worker.js';
import { transaction } from '../data.js';
import {
  TENANCY_PASSWORD,
  admit,
  bootstrapHost,
  claimAsNewAccount,
  createChannel,
  createPendingCommunity,
  expectStatus,
  pairInstall,
  startTenancyHarness,
  type TenancyHarness,
  type TenancyMember,
} from './tenancy-test-harness.js';

/** Far longer than any test waits: only a notice can reach a stream in time. */
const NO_FALLBACK_MS = 300_000;
/** What "promptly" means for a notice. */
const PROMPT_MS = 3_000;

let h: TenancyHarness;
let host: { cookie: string; communityId: string; memberId: string };
let spaces = 0;

/** Runs inside a stream's opening request, after its snapshot watermark; tests set it. */
let afterSnapshot: (() => Promise<void>) | undefined;

beforeAll(async () => {
  h = await startTenancyHarness('live', {
    env: { COMMUNITY_STREAM_FALLBACK_MS: NO_FALLBACK_MS },
    hooks: { afterSnapshotWatermark: async () => afterSnapshot?.() },
  });
  host = await bootstrapHost(h, 'Host', 'host@example.test');
});
afterAll(async () => {
  await h?.close();
});

interface Space {
  communityId: string;
  name: string;
  owner: TenancyMember;
  channelId: string;
  base: string;
}

/** A fresh community with its owner and one channel the owner is in. */
async function space(): Promise<Space> {
  const n = ++spaces;
  const name = `Live ${n}`;
  const { communityId, token } = await createPendingCommunity(h, host.cookie, name);
  const owner = await claimAsNewAccount(h, token, `Owner ${n}`, `owner-${n}@example.test`);
  const channelId = await createChannel(h, communityId, owner.cookie, `room-${n}`);
  return { communityId, name, owner, channelId, base: `/api/v1/communities/${communityId}` };
}

/** Admit a new person to the space and put them in its channel. */
async function member(s: Space, label: string): Promise<TenancyMember> {
  const joined = await admit(h, s.communityId, s.owner.cookie, {
    name: label,
    email: `${label.toLowerCase()}-${randomUUID().slice(0, 8)}@example.test`,
  });
  await expectStatus(
    await h.call(`${s.base}/channels/${s.channelId}/join`, { cookie: joined.cookie, body: {} }),
    200,
    `join ${label}`
  );
  return joined;
}

/** Enroll an agent through a connection of `person`, and put it in the channel. */
async function agent(s: Space, person: TenancyMember) {
  const grant = await pairInstall(h, s.communityId, person.cookie, [
    'read',
    'post',
    'enroll-agent',
  ]);
  const enrolled = await (
    await expectStatus(
      await h.call(`${s.base}/agents`, {
        bearer: grant,
        body: { localAgentId: randomUUID(), displayName: 'Helper' },
      }),
      201,
      'enroll agent'
    )
  ).json();
  const agentId = enrolled.agent.memberId as string;
  await expectStatus(
    await h.call(`${s.base}/channels/${s.channelId}/agents`, { bearer: grant, body: { agentId } }),
    200,
    'add agent to channel'
  );
  return { grant, agentId, token: enrolled.token as string };
}

/** The fields of a stream event these tests read. */
interface StreamEvent {
  event: string;
  data: { reason?: string; entry?: { id: string; text: string } };
}

interface Opened {
  next(timeoutMs?: number): Promise<StreamEvent>;
  close(): Promise<void>;
}

/** Open a live stream on one server and read it frame by frame. */
async function open(
  s: { base: string; channelId: string },
  auth: { cookie?: string; bearer?: string },
  baseUrl = h.baseUrl
): Promise<Opened> {
  const controller = new AbortController();
  const headers: Record<string, string> = {};
  if (auth.cookie) headers.cookie = auth.cookie;
  if (auth.bearer) headers.authorization = `Bearer ${auth.bearer}`;
  const response = await fetch(`${baseUrl}${s.base}/channels/${s.channelId}/events`, {
    headers,
    signal: controller.signal,
  });
  if (response.status !== 200)
    throw new Error(`stream refused: ${response.status} ${await response.text()}`);
  const reader = response.body!.getReader();
  let buffer = '';
  const next = async (timeoutMs = PROMPT_MS): Promise<StreamEvent> => {
    const deadline = Date.now() + timeoutMs;
    while (true) {
      const boundary = buffer.indexOf('\n\n');
      if (boundary >= 0) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const fields = Object.fromEntries(
          frame.split('\n').map((line) => line.split(/: (.*)/s).slice(0, 2))
        );
        if (fields.data) return { event: fields.event, data: JSON.parse(fields.data) };
        continue;
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      const result = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('No event in time')),
            Math.max(0, deadline - Date.now())
          );
        }),
      ]).finally(() => clearTimeout(timer));
      if (result.done) throw new Error('Stream ended without an event');
      buffer += new TextDecoder().decode(result.value);
    }
  };
  const opened: Opened = {
    next,
    async close() {
      controller.abort();
      await reader.cancel().catch(() => undefined);
    },
  };
  expect((await next()).event).toBe('snapshot');
  expect((await next()).event).toBe('replay_complete');
  return opened;
}

/** Expect the stream to end now, with `reason`, and nothing before it. */
async function expectClosed(stream: Opened, reason: string) {
  const started = Date.now();
  const event = await stream.next();
  expect(event.event).toBe('closed');
  expect(event.data.reason).toBe(reason);
  expect(Date.now() - started).toBeLessThan(PROMPT_MS);
}

async function post(s: Space, cookie: string, text: string) {
  return (
    await expectStatus(
      await h.call(`${s.base}/channels/${s.channelId}/entries`, {
        cookie,
        body: { text, idempotencyKey: randomUUID() },
      }),
      201,
      'post'
    )
  ).json();
}

/** Write an entry straight into the database, with no notice, as a lost notice would look. */
async function insertQuietly(s: Space, text: string) {
  const client = await h.pool.connect();
  try {
    await client.query('BEGIN');
    const seq = await client.query<{ last_seq: string }>(
      'UPDATE channels SET last_seq=last_seq+1 WHERE id=$1 RETURNING last_seq',
      [s.channelId]
    );
    await client.query(
      `INSERT INTO entries(community_id,channel_id,seq,author_member_id,author_display_name,text,idempotency_key,payload_hash)
       VALUES($1,$2,$3,$4,'Owner',$5,$6,'test')`,
      [s.communityId, s.channelId, seq.rows[0].last_seq, s.owner.memberId, text, randomUUID()]
    );
    await client.query('COMMIT');
  } finally {
    client.release();
  }
}

/** The id of the account behind a membership. */
async function userOf(memberId: string) {
  return (
    await h.pool.query<{ user_id: string }>('SELECT user_id FROM members WHERE id=$1', [memberId])
  ).rows[0].user_id;
}

/** Every live notice sent while `run` runs, read on a connection of its own. */
async function noticesDuring(run: () => Promise<void>): Promise<LiveNotice[]> {
  const listener = new Client({ connectionString: h.config.databaseUrl });
  const seen: LiveNotice[] = [];
  listener.on('notification', (message) => {
    const notice = parseLiveNotice(message.payload);
    if (notice) seen.push(notice);
  });
  await listener.connect();
  try {
    await listener.query(`LISTEN ${LIVE_NOTICE_CHANNEL}`);
    await run();
    await listener.query('SELECT 1');
    return seen;
  } finally {
    await listener.end();
  }
}

/**
 * A TCP proxy in front of Postgres that can go silent, as a connection a NAT or load balancer
 * dropped does: bytes stop flowing both ways and nothing closes.
 */
async function silentProxy() {
  const port = Number(new URL(h.config.databaseUrl).port || 5432);
  const pairs: Array<[Socket, Socket]> = [];
  let mode: 'open' | 'silent' = 'open';
  const server: Server = createServer((inbound) => {
    if (mode === 'silent') {
      // Accept and say nothing: a connect through here waits out its own timeout.
      inbound.on('error', () => undefined);
      pairs.push([inbound, inbound]);
      return;
    }
    const outbound = connect(port, '127.0.0.1');
    inbound.on('error', () => outbound.destroy());
    outbound.on('error', () => inbound.destroy());
    inbound.pipe(outbound).pipe(inbound);
    pairs.push([inbound, outbound]);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing proxy address');
  const url = new URL(h.config.databaseUrl);
  url.hostname = '127.0.0.1';
  url.port = String(address.port);
  return {
    url: url.toString(),
    /** Stop every byte on every connection, and accept new ones without answering. */
    silence() {
      mode = 'silent';
      for (const [inbound, outbound] of pairs) {
        inbound.unpipe();
        outbound.unpipe();
        inbound.pause();
        outbound.pause();
      }
    },
    /** Let new connections through again; silenced ones stay silent. */
    restore() {
      mode = 'open';
    },
    async close() {
      for (const [inbound, outbound] of pairs) {
        inbound.destroy();
        outbound.destroy();
      }
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function lifecycleVersion(communityId: string) {
  return (
    await h.pool.query<{ lifecycle_version: number }>(
      'SELECT lifecycle_version FROM communities WHERE id=$1',
      [communityId]
    )
  ).rows[0].lifecycle_version;
}

describe('fan-out', () => {
  it('wakes two streams on one channel from one notice', async () => {
    const s = await space();
    const bob = await member(s, 'Bob');
    const owners = await open(s, { cookie: s.owner.cookie });
    const bobs = await open(s, { cookie: bob.cookie });
    try {
      const posted = await post(s, s.owner.cookie, 'hello both');
      for (const stream of [owners, bobs]) {
        const event = await stream.next();
        expect(event.event).toBe('entry');
        expect(event.data.entry?.id).toBe(posted.entry.id);
      }
    } finally {
      await owners.close();
      await bobs.close();
    }
  });

  it('recovers an entry whose notice was lost at the fallback re-read', async () => {
    // Purpose: fails if a stream depends on notices alone. The same database is served by a
    // second server whose fallback is one second; the main server's stays five minutes.
    const fast = await startTenancyHarness('live-fallback', {
      sharesDatabaseOf: h,
      env: { COMMUNITY_STREAM_FALLBACK_MS: 1_000 },
    });
    const s = await space();
    const quick = await open(s, { cookie: s.owner.cookie }, fast.baseUrl);
    const slow = await open(s, { cookie: s.owner.cookie });
    try {
      await insertQuietly(s, 'no notice');
      const event = await quick.next(5_000);
      expect(event.event).toBe('entry');
      expect(event.data.entry?.text).toBe('no notice');
      await expect(slow.next(1_500)).rejects.toThrow('No event in time');
    } finally {
      await quick.close();
      await slow.close();
      await fast.close();
    }
  });

  it('re-reads every stream once when the listener reconnects', async () => {
    const s = await space();
    const stream = await open(s, { cookie: s.owner.cookie });
    try {
      await insertQuietly(s, 'missed while down');
      const cut = await h.pool.query(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
         WHERE application_name=$1 AND datname=current_database()`,
        [LIVE_LISTENER_APPLICATION_NAME]
      );
      expect(cut.rowCount).toBe(1);
      const event = await stream.next(5_000);
      expect(event.event).toBe('entry');
      expect(event.data.entry?.text).toBe('missed while down');
      // Listening again: the next notice arrives as usual.
      await post(s, s.owner.cookie, 'after reconnect');
      expect((await stream.next()).data.entry?.text).toBe('after reconnect');
    } finally {
      await stream.close();
    }
  });
});

describe('every revocation source ends a stream promptly', () => {
  it('a signed-out session', async () => {
    const s = await space();
    const bob = await member(s, 'Bob');
    const stream = await open(s, { cookie: bob.cookie });
    await expectStatus(
      await h.call('/api/auth/sign-out', { cookie: bob.cookie, body: {} }),
      200,
      'sign out'
    );
    await expectClosed(stream, 'removed');
    await stream.close();
  });

  it('a revoked connection', async () => {
    const s = await space();
    const bob = await member(s, 'Bob');
    const grant = await pairInstall(h, s.communityId, bob.cookie, ['read', 'post']);
    const stream = await open(s, { bearer: grant });
    await expectStatus(
      await h.call(`${s.base}/me/connection`, { method: 'DELETE', bearer: grant }),
      204,
      'disconnect'
    );
    await expectClosed(stream, 'removed');
    await stream.close();
  });

  it("a rotated agent credential, and the agent's removal from the channel", async () => {
    const s = await space();
    const bob = await member(s, 'Bob');
    const helper = await agent(s, bob);
    const stream = await open(s, { bearer: helper.token });
    const rotated = await (
      await expectStatus(
        await h.call(`${s.base}/agents/${helper.agentId}/rotate`, {
          method: 'POST',
          bearer: helper.grant,
        }),
        200,
        'rotate'
      )
    ).json();
    await expectClosed(stream, 'removed');
    await stream.close();

    const again = await open(s, { bearer: rotated.token });
    await expectStatus(
      await h.call(`${s.base}/channels/${s.channelId}/agents/${helper.agentId}`, {
        method: 'DELETE',
        cookie: bob.cookie,
      }),
      204,
      'remove agent from channel'
    );
    await expectClosed(again, 'removed');
    await again.close();
  });

  it('a deactivated agent', async () => {
    const s = await space();
    const bob = await member(s, 'Bob');
    const helper = await agent(s, bob);
    const stream = await open(s, { bearer: helper.token });
    await expectStatus(
      await h.call(`${s.base}/agents/${helper.agentId}`, {
        method: 'DELETE',
        bearer: helper.grant,
      }),
      204,
      'eject agent'
    );
    await expectClosed(stream, 'removed');
    await stream.close();
  });

  it("a removed (banned) member, and that member's agent", async () => {
    const s = await space();
    const bob = await member(s, 'Bob');
    const helper = await agent(s, bob);
    const person = await open(s, { cookie: bob.cookie });
    const agentStream = await open(s, { bearer: helper.token });
    await expectStatus(
      await h.call(`${s.base}/members/${bob.memberId}`, {
        method: 'DELETE',
        cookie: s.owner.cookie,
      }),
      204,
      'remove member'
    );
    await expectClosed(person, 'removed');
    await expectClosed(agentStream, 'removed');
    await person.close();
    await agentStream.close();
  });

  it('removal from the channel', async () => {
    const s = await space();
    const bob = await member(s, 'Bob');
    const stream = await open(s, { cookie: bob.cookie });
    await expectStatus(
      await h.call(`${s.base}/channels/${s.channelId}/members/${bob.memberId}`, {
        method: 'DELETE',
        cookie: s.owner.cookie,
      }),
      200,
      'remove from channel'
    );
    await expectClosed(stream, 'removed');
    await stream.close();
  });

  it('an archived channel, and a channel whose history epoch changed', async () => {
    const s = await space();
    const archived = await open(s, { cookie: s.owner.cookie });
    await expectStatus(
      await h.call(`${s.base}/channels/${s.channelId}`, {
        method: 'PATCH',
        cookie: s.owner.cookie,
        body: { archived: true },
      }),
      200,
      'archive channel'
    );
    await expectClosed(archived, 'archived');
    await archived.close();

    const t = await space();
    const renamed = await open(t, { cookie: t.owner.cookie });
    await expectStatus(
      await h.call(`${t.base}/channels/${t.channelId}`, {
        method: 'PATCH',
        cookie: t.owner.cookie,
        body: { name: 'renamed' },
      }),
      200,
      'rename channel'
    );
    await expectClosed(renamed, 'removed');
    await renamed.close();
  });

  it('a held community', async () => {
    const s = await space();
    const stream = await open(s, { cookie: s.owner.cookie });
    await expectStatus(
      await h.call(`/api/v1/host/communities/${s.communityId}/lifecycle`, {
        method: 'PATCH',
        cookie: host.cookie,
        body: {
          action: 'hold',
          lifecycleVersion: await lifecycleVersion(s.communityId),
          deletionNoticeAt: null,
        },
      }),
      200,
      'hold'
    );
    await expectClosed(stream, 'archived');
    await stream.close();
  });

  it('a suspended community', async () => {
    const s = await space();
    const stream = await open(s, { cookie: s.owner.cookie });
    await expectStatus(
      await h.call(`/api/v1/host/communities/${s.communityId}/lifecycle`, {
        method: 'PATCH',
        cookie: host.cookie,
        body: { action: 'suspend', lifecycleVersion: await lifecycleVersion(s.communityId) },
      }),
      200,
      'suspend'
    );
    await expectClosed(stream, 'removed');
    await stream.close();
  });

  it('a community taken down', async () => {
    const s = await space();
    const stream = await open(s, { cookie: s.owner.cookie });
    await expectStatus(
      await h.call(`/api/v1/host/communities/${s.communityId}/takedowns`, {
        cookie: host.cookie,
        body: {
          idempotencyKey: randomUUID(),
          target: {
            kind: 'community',
            lifecycleVersion: await lifecycleVersion(s.communityId),
            confirmIdSuffix: s.communityId.slice(-8),
          },
          category: 'illegal_content',
          reference: 'CASE-1',
          password: TENANCY_PASSWORD,
        },
      }),
      201,
      'take down'
    );
    await expectClosed(stream, 'taken_down');
    await stream.close();
  });

  it('a community its owner is deleting', async () => {
    const s = await space();
    const stream = await open(s, { cookie: s.owner.cookie });
    const deleting = await h.call(`${s.base}/owner/deletion`, {
      cookie: s.owner.cookie,
      body: {
        lifecycleVersion: await lifecycleVersion(s.communityId),
        password: TENANCY_PASSWORD,
        confirmName: s.name,
        confirmIdSuffix: s.communityId.slice(-8),
      },
    });
    expect([200, 201, 202], await deleting.clone().text()).toContain(deleting.status);
    await expectClosed(stream, 'removed');
    await stream.close();
  });
});

describe('more revocation sources end a stream promptly', () => {
  it('a host closing the account', async () => {
    const s = await space();
    const bob = await member(s, 'Bob');
    const stream = await open(s, { cookie: bob.cookie });
    const closed = await h.call(`/api/v1/host/accounts/${await userOf(bob.memberId)}/closure`, {
      cookie: host.cookie,
      body: {
        idempotencyKey: randomUUID(),
        reason: 'under_minimum_age',
        reference: null,
        password: TENANCY_PASSWORD,
      },
    });
    expect([200, 201], await closed.clone().text()).toContain(closed.status);
    await expectClosed(stream, 'removed');
    await stream.close();
  });

  it("clearing an account's access (password recovery and mailed links)", async () => {
    const s = await space();
    const bob = await member(s, 'Bob');
    const stream = await open(s, { cookie: bob.cookie });
    const userId = await userOf(bob.memberId);
    await transaction(h.pool, (client) =>
      clearAccountAccess(client, userId, [bob.memberId], { password: true, links: true }, 'system')
    );
    await expectClosed(stream, 'removed');
    await stream.close();
  });

  it("erasing a member, through their connection's stream", async () => {
    const s = await space();
    const bob = await member(s, 'Bob');
    const grant = await pairInstall(h, s.communityId, bob.cookie, ['read', 'post']);
    const stream = await open(s, { bearer: grant });
    await eraseMembership(h.pool, s.communityId, bob.memberId, { log: () => undefined });
    await expectClosed(stream, 'removed');
    await stream.close();
  });

  it('erasing a member who was already removed still announces the husk', async () => {
    // Purpose: fails if the erasure's own steps send nothing, leaning on the removal's notice.
    const s = await space();
    const bob = await member(s, 'Bob');
    await expectStatus(
      await h.call(`${s.base}/members/${bob.memberId}`, {
        method: 'DELETE',
        cookie: s.owner.cookie,
      }),
      204,
      'remove member'
    );
    const notices = await noticesDuring(async () => {
      await eraseMembership(h.pool, s.communityId, bob.memberId, { log: () => undefined });
    });
    expect(notices).toContainEqual({ k: 'member', c: s.communityId, m: bob.memberId });
  });

  it('disconnecting every connection at once', async () => {
    const s = await space();
    const bob = await member(s, 'Bob');
    const grant = await pairInstall(h, s.communityId, bob.cookie, ['read', 'post']);
    const stream = await open(s, { bearer: grant });
    await expectStatus(
      await h.call(`${s.base}/me/grants`, {
        method: 'DELETE',
        cookie: bob.cookie,
        body: { password: TENANCY_PASSWORD },
      }),
      204,
      'disconnect all'
    );
    await expectClosed(stream, 'removed');
    await stream.close();
  });

  it('the owner archiving the community', async () => {
    const s = await space();
    const stream = await open(s, { cookie: s.owner.cookie });
    await expectStatus(
      await h.call(`${s.base}/owner/lifecycle`, {
        cookie: s.owner.cookie,
        body: {
          action: 'archive',
          lifecycleVersion: await lifecycleVersion(s.communityId),
          password: TENANCY_PASSWORD,
          confirmName: s.name,
        },
      }),
      200,
      'archive'
    );
    await expectClosed(stream, 'archived');
    await stream.close();
  });

  it('signing out everywhere (Better Auth ends every session itself)', async () => {
    const s = await space();
    const bob = await member(s, 'Bob');
    const stream = await open(s, { cookie: bob.cookie });
    await expectStatus(
      await h.call('/api/auth/revoke-sessions', { cookie: bob.cookie, body: {} }),
      200,
      'revoke sessions'
    );
    await expectClosed(stream, 'removed');
    await stream.close();
  });

  it('a host deleting a held community, and the deletion finishing', async () => {
    // No stream can be open here: a hold already closed every stream and refuses new ones. So
    // this checks the notices themselves, for a stream a lost earlier notice left open.
    const s = await space();
    await expectStatus(
      await h.call(`/api/v1/host/communities/${s.communityId}/lifecycle`, {
        method: 'PATCH',
        cookie: host.cookie,
        body: {
          action: 'hold',
          lifecycleVersion: await lifecycleVersion(s.communityId),
          deletionNoticeAt: null,
        },
      }),
      200,
      'hold'
    );
    await h.pool.query(
      "UPDATE communities SET deletion_notice_at=now()-interval '1 day' WHERE id=$1",
      [s.communityId]
    );
    const requested = await noticesDuring(async () => {
      const response = await h.call(`/api/v1/host/communities/${s.communityId}/deletion`, {
        cookie: host.cookie,
        body: {
          lifecycleVersion: await lifecycleVersion(s.communityId),
          confirmIdSuffix: s.communityId.slice(-8),
        },
      });
      expect([200, 201, 202], await response.clone().text()).toContain(response.status);
    });
    expect(requested).toContainEqual({ k: 'community', c: s.communityId });

    const finished = await noticesDuring(async () => {
      await h.pool.query(
        `UPDATE communities SET delete_requested_at=now()-interval '8 days',
           delete_after=now()-interval '1 day' WHERE id=$1`,
        [s.communityId]
      );
      await h.pool.query(
        `UPDATE community_deletion_jobs SET delete_after=now()-interval '1 day',next_attempt_at=now()
         WHERE community_id=$1`,
        [s.communityId]
      );
      for (let pass = 0; pass < 20; pass++) {
        const result = await sweepCommunityDeletions(h.pool, h.blobStore, 100);
        expect(result.failed).toBe(0);
        if (result.completed) break;
        await h.pool.query('UPDATE community_deletion_jobs SET next_attempt_at=now()');
        await h.pool.query('UPDATE community_deletion_blob_progress SET next_attempt_at=now()');
      }
    });
    expect(finished).toContainEqual({ k: 'community', c: s.communityId });
  });
});

describe('stream lifetime', () => {
  it('gives back the place of a caller that left while the stream was opening', async () => {
    // Purpose: fails if a request aborted before the stream started keeps its place forever:
    // its abort event has already fired, and nothing reads the stream to cancel it.
    const s = await space();
    await expect.poll(() => h.live.snapshot().streams).toBe(0);
    const controller = new AbortController();
    afterSnapshot = async () => {
      controller.abort();
      await new Promise((resolve) => setTimeout(resolve, 100));
    };
    try {
      await expect(
        fetch(`${h.baseUrl}${s.base}/channels/${s.channelId}/events`, {
          headers: { cookie: s.owner.cookie },
          signal: controller.signal,
        })
      ).rejects.toThrow();
      await new Promise((resolve) => setTimeout(resolve, 300));
    } finally {
      afterSnapshot = undefined;
    }
    expect(h.live.snapshot().streams).toBe(0);
  });

  it('checks access once as soon as it starts', async () => {
    // Purpose: fails if a revocation that committed before the stream joined the hub (so its
    // notice reached nobody) leaves the stream open until the fallback re-read.
    const s = await space();
    const bob = await member(s, 'Bob');
    afterSnapshot = async () => {
      await h.pool.query('DELETE FROM channel_members WHERE channel_id=$1 AND member_id=$2', [
        s.channelId,
        bob.memberId,
      ]);
    };
    let stream: Opened;
    try {
      stream = await open(s, { cookie: bob.cookie });
    } finally {
      afterSnapshot = undefined;
    }
    await expectClosed(stream, 'removed');
    await stream.close();
  });

  it('keeps the closed frame for a reader that fell behind', async () => {
    // Purpose: fails if access ending while the reader is not taking events errors the stream,
    // which drops what was queued and never says why it ended.
    const s = await space();
    const bob = await member(s, 'Bob');
    // The app's own stream object, with no socket buffer in between: not reading is backpressure.
    const app = createCommunityApp({ config: h.config, pool: h.pool, live: h.live });
    const response = await app.fetch(
      new Request(`http://localhost${s.base}/channels/${s.channelId}/events`, {
        headers: { cookie: bob.cookie },
      })
    );
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    let buffer = '';
    const frame = async () => {
      while (!buffer.includes('\n\n')) {
        const { value, done } = await reader.read();
        if (done) throw new Error('ended');
        buffer += new TextDecoder().decode(value);
      }
      const at = buffer.indexOf('\n\n');
      const text = buffer.slice(0, at);
      buffer = buffer.slice(at + 2);
      return /^event: (\w+)/m.exec(text)?.[1];
    };
    try {
      expect(await frame()).toBe('snapshot');
      expect(await frame()).toBe('replay_complete');
      await post(s, s.owner.cookie, 'queued, unread');
      // Let the stream queue the entry; the reader does not take it yet.
      await new Promise((resolve) => setTimeout(resolve, 300));
      await expectStatus(
        await h.call(`${s.base}/channels/${s.channelId}/members/${bob.memberId}`, {
          method: 'DELETE',
          cookie: s.owner.cookie,
        }),
        200,
        'remove from channel'
      );
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(await frame()).toBe('entry');
      expect(await frame()).toBe('closed');
    } finally {
      await reader.cancel().catch(() => undefined);
    }
  });

  it('answers readiness while every pooled connection is busy', async () => {
    // Purpose: fails if readiness waits behind the request pool, so a storm of stream rechecks
    // would take the server out of rotation.
    const held = await Promise.all(Array.from({ length: 10 }, () => h.pool.connect()));
    try {
      const started = Date.now();
      const ready = await fetch(`${h.baseUrl}/health/ready`);
      expect(ready.status).toBe(200);
      expect(Date.now() - started).toBeLessThan(2_000);
    } finally {
      for (const client of held) client.release();
    }
  });
});

describe('limits', () => {
  it('answers 503 with Retry-After past the per-community quota and the server cap', async () => {
    const capped = await startTenancyHarness('live-caps', {
      sharesDatabaseOf: h,
      env: { COMMUNITY_STREAMS_MAX: 2, COMMUNITY_STREAMS_PER_COMMUNITY: 1 },
    });
    const a = await space();
    const b = await space();
    const c = await space();
    const url = (s: Space) => `${capped.baseUrl}${s.base}/channels/${s.channelId}/events`;
    const opened: Opened[] = [];
    try {
      opened.push(await open(a, { cookie: a.owner.cookie }, capped.baseUrl));
      const full = await fetch(url(a), { headers: { cookie: a.owner.cookie } });
      expect(full.status).toBe(503);
      expect(Number(full.headers.get('retry-after'))).toBeGreaterThan(0);
      expect((await full.json()).code).toBe('UNAVAILABLE');
      // Another community is not shut out by the first one's spike.
      opened.push(await open(b, { cookie: b.owner.cookie }, capped.baseUrl));
      const host = await fetch(url(c), { headers: { cookie: c.owner.cookie } });
      expect(host.status).toBe(503);
      expect(host.headers.get('retry-after')).not.toBeNull();
      await host.body?.cancel();
      // Closing a stream frees its place.
      await opened.shift()!.close();
      await expect
        .poll(async () => {
          const retry = await fetch(url(c), { headers: { cookie: c.owner.cookie } });
          await retry.body?.cancel();
          return retry.status;
        })
        .toBe(200);
    } finally {
      for (const stream of opened) await stream.close();
      await capped.close();
    }
  });
});

describe('per-member limit', () => {
  it('answers 503 once one person holds as many streams as one may', async () => {
    const capped = await startTenancyHarness('live-member-cap', {
      sharesDatabaseOf: h,
      env: { COMMUNITY_STREAMS_PER_MEMBER: 1 },
    });
    const s = await space();
    const second = await createChannel(h, s.communityId, s.owner.cookie, 'second');
    const first = await open(s, { cookie: s.owner.cookie }, capped.baseUrl);
    try {
      const refused = await fetch(`${capped.baseUrl}${s.base}/channels/${second}/events`, {
        headers: { cookie: s.owner.cookie },
      });
      expect(refused.status).toBe(503);
      expect(refused.headers.get('retry-after')).not.toBeNull();
      await refused.body?.cancel();
      expect(capped.live.snapshot().refused.member).toBe(1);
    } finally {
      await first.close();
      await capped.close();
    }
  });
});

describe('monitoring', () => {
  it('reports readiness with a database round trip, and keeps /health a liveness probe', async () => {
    expect(await (await fetch(`${h.baseUrl}/health`)).json()).toEqual({ status: 'ok' });
    const ready = await fetch(`${h.baseUrl}/health/ready`);
    expect(ready.status).toBe(200);
    expect(await ready.json()).toMatchObject({ status: 'ok', database: 'ok' });
  });

  it('serves Prometheus metrics only to host authority with communities:read', async () => {
    const issue = async (scopes: string[]) =>
      (
        await (
          await expectStatus(
            await h.call('/api/v1/host/api-keys', {
              cookie: host.cookie,
              body: {
                label: `Metrics ${scopes.join()}`,
                scopes,
                expiresInDays: null,
                password: TENANCY_PASSWORD,
              },
            }),
            201,
            'issue key'
          )
        ).json()
      ).secret as string;
    const reader = await issue(['communities:read']);
    const other = await issue(['communities:lifecycle']);
    expect((await fetch(`${h.baseUrl}/metrics`)).status).toBe(401);
    expect(
      (await fetch(`${h.baseUrl}/metrics`, { headers: { authorization: `Bearer ${other}` } }))
        .status
    ).toBe(403);

    const s = await space();
    const stream = await open(s, { cookie: s.owner.cookie });
    try {
      await post(s, s.owner.cookie, 'counted');
      expect((await stream.next()).event).toBe('entry');
      const response = await fetch(`${h.baseUrl}/metrics`, {
        headers: { authorization: `Bearer ${reader}` },
      });
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('text/plain');
      const text = await response.text();
      expect(text).toContain(
        `community_live_streams_by_community{community_id="${s.communityId}"} 1`
      );
      expect(text).toMatch(/^community_posts_per_minute [1-9]\d*$/m);
      expect(text).toMatch(/^community_joins_per_minute \d+$/m);
      expect(text).toMatch(/^community_db_pool_waiting \d+$/m);
      expect(text).toMatch(/^community_live_listener_up 1$/m);
      expect(text).toMatch(/^community_live_delivery_lag_seconds_count [1-9]\d*$/m);
    } finally {
      await stream.close();
    }
  });
});

describe('the listener at boot', () => {
  function hubFor(listenUrl: string, probe?: { everyMs: number; timeoutMs: number }) {
    return new LiveHub({
      listenUrl,
      maxStreams: 10,
      maxStreamsPerCommunity: 10,
      maxStreamsPerMember: 10,
      fallbackMs: NO_FALLBACK_MS,
      selfTestMs: 1_000,
      log: () => undefined,
      probe,
    });
  }

  it('reconnects a connection that went silent, and wakes every stream to re-read', async () => {
    // Purpose: fails if a half-open listen connection (no error, no close, no notices) is
    // trusted forever: streams would wait for their fallback re-read and nothing would recover.
    const proxy = await silentProxy();
    const live = hubFor(proxy.url, { everyMs: 200, timeoutMs: 200 });
    try {
      await live.start(h.pool);
      const stream = await live.open({ communityId: 'c', channelId: 'x', memberId: 'm' });
      await stream.entries.wait(0);
      proxy.silence();
      proxy.restore();
      await expect.poll(() => live.snapshot().listenerReconnects, { timeout: 5_000 }).toBe(1);
      expect(stream.entries.raised).toBe(true);
      // Listening again on a fresh connection: a notice arrives.
      await stream.entries.wait(0);
      await h.pool.query('SELECT pg_notify($1, \'{"k":"entry","c":"c","ch":"x"}\')', [
        LIVE_NOTICE_CHANNEL,
      ]);
      expect(await stream.entries.wait(3_000)).toBe(true);
    } finally {
      await live.stop();
      await proxy.close();
    }
  });

  it('opens a stream without waiting for a listener that is reconnecting', async () => {
    // Purpose: fails if every new stream waits out a connect timeout while the database is
    // unreachable; the retry timer reconnects and its wake-up covers these streams.
    const proxy = await silentProxy();
    const live = hubFor(proxy.url, { everyMs: 200, timeoutMs: 200 });
    try {
      await live.start(h.pool);
      proxy.silence();
      await expect.poll(() => live.listenerState, { timeout: 5_000 }).not.toBe('listening');
      const started = Date.now();
      await live.open({ communityId: 'c', channelId: 'x', memberId: 'm' });
      expect(Date.now() - started).toBeLessThan(500);
    } finally {
      await live.stop();
      await proxy.close();
    }
  });

  it('passes its self-test on a direct connection, and readiness then needs it', async () => {
    const live = hubFor(h.config.databaseUrl);
    try {
      await live.start(h.pool);
      expect(live.listenerState).toBe('listening');
      const app = createCommunityApp({ config: h.config, pool: h.pool, live });
      const ready = await app.fetch(new Request('http://localhost/health/ready'));
      expect(await ready.json()).toMatchObject({ status: 'ok', listener: 'listening' });
    } finally {
      await live.stop();
    }
  });

  it('fails its self-test when notices never arrive', async () => {
    // Purpose: fails if the boot check only proves LISTEN ran. Listening on another database is
    // what a transaction-mode pooler looks like from here: LISTEN succeeds, nothing comes.
    const elsewhere = hubFor(process.env.COMMUNITY_TEST_DATABASE_URL!);
    try {
      await expect(elsewhere.start(h.pool)).rejects.toThrow('the notice never arrived');
    } finally {
      await elsewhere.stop();
    }
  });

  it('reports not ready while a pinned listener cannot connect', async () => {
    const broken = hubFor('postgres://nobody@127.0.0.1:1/none');
    try {
      await expect(broken.start(h.pool)).rejects.toThrow();
      const app = createCommunityApp({ config: h.config, pool: h.pool, live: broken });
      const ready = await app.fetch(new Request('http://localhost/health/ready'));
      expect(ready.status).toBe(503);
      expect(await ready.json()).toMatchObject({ status: 'unavailable', database: 'ok' });
    } finally {
      await broken.stop();
    }
  });
});
