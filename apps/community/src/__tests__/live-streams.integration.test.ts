/**
 * Live channel streams wake on Postgres notices (spec official-community-space, D12 and D13).
 *
 * The main server here re-reads a quiet stream only every five minutes, so anything that reaches
 * a stream within a few seconds reached it through a notice. Each revocation source the stream's
 * access check covers gets its own test: change it through the real route, and the stream must
 * end promptly with no message posted to wake it.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCommunityApp } from '../app.js';
import { LiveHub } from '../live/hub.js';
import { LIVE_LISTENER_APPLICATION_NAME } from '../live/listener.js';
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

beforeAll(async () => {
  h = await startTenancyHarness('live', { env: { COMMUNITY_STREAM_FALLBACK_MS: NO_FALLBACK_MS } });
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
  function hubFor(listenUrl: string) {
    return new LiveHub({
      listenUrl,
      maxStreams: 10,
      maxStreamsPerCommunity: 10,
      fallbackMs: NO_FALLBACK_MS,
      selfTestMs: 1_000,
      log: () => undefined,
    });
  }

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
