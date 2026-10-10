/**
 * Mute, slow mode, reports, rules and display names (specs/official-community-space D6-D8;
 * DOR-2768) over real HTTP and Postgres. Every refusal at the post route is proven for a person
 * and for an agent they own, because an agent posts as its owner: a muted owner's agents are
 * muted, an owner who has not accepted the rules cannot post through an agent, and slow mode
 * counts an owner's posts and their agents' together.
 */
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { serve } from '@hono/node-server';
import { Pool } from 'pg';
import { createCommunityApp } from '../app.js';
import { parseConfig } from '../config.js';
import { migrate } from '../migrate.js';
import { eraseMembership } from '../erasure/erasure.js';
import { OPEN_REPORTS_PER_MEMBER } from '../routes/community/reports.js';
import { hashSecret, randomToken } from '../security.js';
import {
  bootstrapFirstHost,
  responseCookies,
  seedCredentialAccount,
} from './bootstrap-test-helper.js';

const adminUrl = process.env.COMMUNITY_TEST_DATABASE_URL;
if (!adminUrl) throw new Error('COMMUNITY_TEST_DATABASE_URL is required for moderation tests');
const admin = new Pool({ connectionString: adminUrl });
const dbName = `community_moderation_${randomUUID().replaceAll('-', '')}`;
const dbUrl = new URL(adminUrl);
dbUrl.pathname = `/${dbName}`;
const origin = 'http://localhost:6481';
const password = 'password1234';

let pool: Pool;
let server: ReturnType<typeof serve>;
let baseUrl = '';
let storagePath = '';
let communityId = '';
let general = '';
let ownerCookie = '';
let ownerId = '';

interface Person {
  cookie: string;
  memberId: string;
  agentToken: string;
  agentId: string;
}
let adminPerson: Person;
let alice: Person;
let bob: Person;

type Who = { cookie: string } | { token: string } | null;

function call(path: string, method: string, who: Who, body?: unknown): Promise<Response> {
  const headers: Record<string, string> = { origin };
  if (who && 'cookie' in who) headers.cookie = who.cookie;
  if (who && 'token' in who) headers.authorization = `Bearer ${who.token}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  return fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const scoped = (path: string) => `/api/v1/communities/${communityId}${path}`;
const human = (person: { cookie: string }): Who => ({ cookie: person.cookie });
const agentOf = (person: Person): Who => ({ token: person.agentToken });

async function expectStatus(response: Response, status: number): Promise<Record<string, unknown>> {
  const text = await response.text();
  expect(response.status, text.slice(0, 300)).toBe(status);
  return text ? (JSON.parse(text) as Record<string, unknown>) : {};
}

function post(who: Who, text = 'hello', channelId = general, idempotencyKey = randomUUID()) {
  return call(scoped(`/channels/${channelId}/entries`), 'POST', who, { text, idempotencyKey });
}

async function posted(who: Who, text = 'hello', channelId = general): Promise<string> {
  const body = await expectStatus(await post(who, text, channelId), 201);
  return (body.entry as { id: string }).id;
}

async function signIn(email: string): Promise<string> {
  const response = await call('/api/auth/sign-in/email', 'POST', null, { email, password });
  expect(response.status).toBe(200);
  return responseCookies(response);
}

/** A new person admitted through an invitation, joined to `general`, with one agent there. */
async function person(name: string): Promise<Person> {
  const email = `${name.toLowerCase().replaceAll(' ', '-')}-${randomUUID().slice(0, 6)}@mod.test`;
  await seedCredentialAccount(pool, { name, email, password });
  const cookie = await signIn(email);
  const memberId = await admit(cookie);
  await expectStatus(await call(scoped(`/channels/${general}/join`), 'POST', { cookie }, {}), 200);
  const agent = await mintAgent(memberId, `${name} Bot`);
  await expectStatus(
    await call(scoped(`/channels/${general}/agents`), 'POST', { cookie }, { agentId: agent.id }),
    200
  );
  return { cookie, memberId, agentToken: agent.token, agentId: agent.id };
}

async function admit(cookie: string): Promise<string> {
  const { token } = (await expectStatus(
    await call(scoped('/invites'), 'POST', { cookie: ownerCookie }, { seats: 1 }),
    201
  )) as { token: string };
  const preflight = await call(scoped('/invites/preflight'), 'POST', null, { token });
  expect(preflight.status).toBe(200);
  const both = { cookie: `${cookie}; ${responseCookies(preflight)}` };
  await expectStatus(await call(scoped('/invites/bind'), 'POST', both, {}), 200);
  const redeemed = await expectStatus(await call(scoped('/invites/redeem'), 'POST', both, {}), 200);
  return redeemed.memberId as string;
}

async function mintAgent(memberId: string, displayName: string) {
  const grant = randomToken();
  await pool.query(
    `INSERT INTO connection_grants(community_id,member_id,token_hash,scopes,install_name)
     VALUES($1,$2,$3,'{read,post,enroll-agent}','Moderation test install')`,
    [communityId, memberId, hashSecret(grant)]
  );
  const body = await expectStatus(
    await call(
      scoped('/agents'),
      'POST',
      { token: grant },
      { localAgentId: randomUUID(), displayName }
    ),
    201
  );
  return { id: (body.agent as { memberId: string }).memberId, token: body.token as string };
}

async function auditCount(action: string, subjectId?: string): Promise<number> {
  const result = await pool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM audit_events WHERE community_id=$1 AND action=$2
       AND ($3::text IS NULL OR subject_id=$3::text)`,
    [communityId, action, subjectId ?? null]
  );
  return result.rows[0].n;
}

beforeAll(async () => {
  storagePath = await mkdtemp(join(tmpdir(), 'community-moderation-'));
  await admin.query(`CREATE DATABASE ${dbName}`);
  await migrate(dbUrl.toString());
  pool = new Pool({ connectionString: dbUrl.toString() });
  const config = parseConfig({
    COMMUNITY_DATABASE_URL: dbUrl.toString(),
    COMMUNITY_AUTH_SECRET: 'a'.repeat(32),
    COMMUNITY_INVITE_SECRET: 'b'.repeat(32),
    COMMUNITY_BOOTSTRAP_SECRET: 'c'.repeat(32),
    COMMUNITY_PUBLIC_URL: origin,
    COMMUNITY_STORAGE_PATH: storagePath,
    COMMUNITY_AGENTS_PER_OWNER: '20',
  });
  const app = createCommunityApp({
    config,
    pool,
    hooks: { invitePreviewPeer: () => randomUUID() },
  });
  server = serve({ fetch: app.fetch, port: 0 });
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing HTTP address');
  baseUrl = `http://localhost:${address.port}`;
  const founder = await bootstrapFirstHost(
    (path, body, cookie) => call(path, 'POST', cookie ? { cookie } : null, body),
    {
      secret: config.bootstrapSecret,
      accountName: 'Olive Owner',
      email: 'olive@mod.test',
      password,
      communityName: 'Moderated',
    }
  );
  ownerCookie = founder.cookie;
  ownerId = founder.memberId;
  communityId = founder.communityId;
  general = founder.channelId;
  adminPerson = await person('Ada Admin');
  await expectStatus(
    await call(
      scoped(`/members/${adminPerson.memberId}/role`),
      'PATCH',
      human({ cookie: ownerCookie }),
      {
        role: 'admin',
      }
    ),
    200
  );
  alice = await person('Alice');
  bob = await person('Bob');
});

afterEach(async () => {
  await pool.query('UPDATE members SET muted_until=NULL WHERE community_id=$1', [communityId]);
  await pool.query("UPDATE communities SET rules_text=NULL,reserved_names='{}' WHERE id=$1", [
    communityId,
  ]);
  await pool.query('UPDATE channels SET slow_mode_seconds=0 WHERE community_id=$1', [communityId]);
  await pool.query('DELETE FROM channel_post_clocks WHERE community_id=$1', [communityId]);
});

afterAll(async () => {
  // Every open connection first, then the pool: the database is dropped only once nothing is in
  // it, so no pooled client meets a terminated connection.
  (server as Server | undefined)?.closeAllConnections();
  await new Promise<void>((resolve) => server?.close(() => resolve()));
  await pool?.end();
  await admin.query(`DROP DATABASE IF EXISTS ${dbName}`);
  await admin.end();
  await rm(storagePath, { recursive: true, force: true });
});

describe('mute', () => {
  it('stops a muted person and their agents from posting, with when it ends, until it is lifted', async () => {
    const owner = human({ cookie: ownerCookie });
    const muted = await expectStatus(
      await call(scoped(`/members/${alice.memberId}/mute`), 'POST', owner, { minutes: 30 }),
      200
    );
    const until = muted.mutedUntil as string;
    expect(Date.parse(until) - Date.now()).toBeGreaterThan(29 * 60_000);
    expect(await auditCount('member.mute', alice.memberId)).toBe(1);

    for (const who of [human(alice), agentOf(alice)]) {
      const refused = await expectStatus(await post(who), 403);
      expect(refused).toMatchObject({ code: 'COMMUNITY_MUTED', until });
    }
    // Nobody else is held, and the muted person sees their own standing.
    await posted(human(bob));
    await posted(agentOf(bob));
    const standing = await expectStatus(
      await call(scoped('/me/standing'), 'GET', human(alice)),
      200
    );
    expect(standing.mutedUntil).toBe(until);
    const list = await expectStatus(await call(scoped('/mutes'), 'GET', human(adminPerson)), 200);
    expect((list.mutes as { memberId: string }[]).map((row) => row.memberId)).toEqual([
      alice.memberId,
    ]);

    await expectStatus(
      await call(scoped(`/members/${alice.memberId}/mute`), 'DELETE', human(adminPerson)),
      204
    );
    expect(await auditCount('member.unmute', alice.memberId)).toBe(1);
    await posted(human(alice));
    await posted(agentOf(alice));
  });

  it('ends on its own when the time is up', async () => {
    await expectStatus(
      await call(scoped(`/members/${bob.memberId}/mute`), 'POST', human({ cookie: ownerCookie }), {
        minutes: 1,
      }),
      200
    );
    expect((await expectStatus(await post(agentOf(bob)), 403)).code).toBe('COMMUNITY_MUTED');
    await pool.query("UPDATE members SET muted_until=now()-interval '1 second' WHERE id=$1", [
      bob.memberId,
    ]);
    await posted(agentOf(bob));
    const standing = await expectStatus(await call(scoped('/me/standing'), 'GET', human(bob)), 200);
    expect(standing.mutedUntil).toBeNull();
  });

  it('follows rank: members mute nobody, admins only plain members, nobody the owner', async () => {
    const tries: [Who, string, number][] = [
      [human(alice), bob.memberId, 403],
      [agentOf(alice), bob.memberId, 401],
      [human(adminPerson), ownerId, 403],
      [human({ cookie: ownerCookie }), ownerId, 409],
    ];
    for (const [who, target, status] of tries)
      await expectStatus(
        await call(scoped(`/members/${target}/mute`), 'POST', who, { minutes: 5 }),
        status
      );
    const muted = await pool.query(
      'SELECT 1 FROM members WHERE community_id=$1 AND muted_until IS NOT NULL',
      [communityId]
    );
    expect(muted.rowCount).toBe(0);
    await expectStatus(
      await call(scoped(`/members/${bob.memberId}/mute`), 'POST', human(adminPerson), {
        minutes: 0,
      }),
      400
    );
  });

  it('outlasts leaving and coming back', async () => {
    const carol = await person('Carol');
    await expectStatus(
      await call(
        scoped(`/members/${carol.memberId}/mute`),
        'POST',
        human({ cookie: ownerCookie }),
        {
          minutes: 60,
        }
      ),
      200
    );
    await expectStatus(
      await call(scoped(`/members/${carol.memberId}`), 'DELETE', human({ cookie: ownerCookie })),
      204
    );
    expect(await admit(carol.cookie)).toBe(carol.memberId);
    await expectStatus(
      await call(scoped(`/channels/${general}/join`), 'POST', human(carol), {}),
      200
    );
    expect((await expectStatus(await post(human(carol)), 403)).code).toBe('COMMUNITY_MUTED');
  });
});

describe('mute and the owner', () => {
  it('never holds the owner, whose mute nobody could lift', async () => {
    // As after an ownership transfer or an import that carried one: no one outranks the owner.
    await pool.query("UPDATE members SET muted_until=now()+interval '1 year' WHERE id=$1", [
      ownerId,
    ]);
    await posted(human({ cookie: ownerCookie }));
    const standing = await expectStatus(
      await call(scoped('/me/standing'), 'GET', human({ cookie: ownerCookie })),
      200
    );
    expect(standing.mutedUntil).toBeNull();
    const list = await expectStatus(await call(scoped('/mutes'), 'GET', human(adminPerson)), 200);
    expect(list.mutes).toEqual([]);
  });
});

describe('slow mode', () => {
  async function slow(seconds: number, channelId = general) {
    await expectStatus(
      await call(scoped(`/channels/${channelId}`), 'PATCH', human({ cookie: ownerCookie }), {
        slowModeSeconds: seconds,
      }),
      200
    );
  }

  it('makes each person wait between posts, their agents counted with them', async () => {
    await slow(60);
    expect(await auditCount('channel.slow_mode', general)).toBeGreaterThan(0);
    const read = await expectStatus(
      await call(scoped(`/channels/${general}/slow-mode`), 'GET', agentOf(alice)),
      200
    );
    expect(read).toEqual({ seconds: 60 });

    const key = randomUUID();
    await expectStatus(await post(human(alice), 'first', general, key), 201);
    // A retry of the post that landed is answered, never held by its own wait.
    await expectStatus(await post(human(alice), 'first', general, key), 200);
    for (const who of [human(alice), agentOf(alice)]) {
      const response = await post(who, 'again');
      const retryAfter = Number(response.headers.get('retry-after'));
      expect((await expectStatus(response, 429)).code).toBe('COMMUNITY_SLOW_MODE');
      expect(retryAfter).toBeGreaterThan(50);
      expect(retryAfter).toBeLessThanOrEqual(60);
    }
    // Bob's wait is his own: his agent posting first holds him too.
    await posted(agentOf(bob));
    expect((await expectStatus(await post(human(bob)), 429)).code).toBe('COMMUNITY_SLOW_MODE');

    // Once the wait is over, the next post goes through.
    await pool.query(
      "UPDATE channel_post_clocks SET posted_at=now()-interval '61 seconds' WHERE member_id=$1",
      [alice.memberId]
    );
    await posted(agentOf(alice));
  });

  it('lets owners and admins post through it', async () => {
    await slow(600);
    for (const who of [human({ cookie: ownerCookie }), human(adminPerson), agentOf(adminPerson)])
      for (let i = 0; i < 2; i++) await posted(who);
  });

  it('holds one channel only, and only owners and admins set it', async () => {
    const other = await expectStatus(
      await call(scoped('/channels'), 'POST', human({ cookie: ownerCookie }), {
        name: `quiet-${randomUUID().slice(0, 6)}`,
        visibility: 'public',
      }),
      201
    );
    const otherId = (other.channel as { id: string }).id;
    await expectStatus(
      await call(scoped(`/channels/${otherId}/join`), 'POST', human(alice), {}),
      200
    );
    await slow(60);
    await posted(human(alice));
    await posted(human(alice), 'elsewhere', otherId);
    await expectStatus(
      await call(scoped(`/channels/${otherId}`), 'PATCH', human(alice), { slowModeSeconds: 10 }),
      403
    );
    await expectStatus(
      await call(scoped(`/channels/${otherId}`), 'PATCH', human({ cookie: ownerCookie }), {
        slowModeSeconds: 21_601,
      }),
      400
    );
  });

  it('serializes two devices posting at once, so only one gets through', async () => {
    await slow(60);
    const results = await Promise.all([post(human(bob), 'a'), post(agentOf(bob), 'b')]);
    expect(results.map((response) => response.status).sort()).toEqual([201, 429]);
  });
});

describe('rules', () => {
  async function setRules(text: string | null, who: Who = human({ cookie: ownerCookie })) {
    const current = await expectStatus(await call(scoped('/rules'), 'GET', who), 200);
    return expectStatus(
      await call(scoped('/rules'), 'PUT', who, { text, expectedVersion: current.version }),
      200
    );
  }

  it('holds every post until its human accepts the current version, agents included', async () => {
    const set = await setRules('Be kind. No spam.');
    const version = set.version as number;
    expect(set.acceptedVersion).toBe(version);
    // The editor accepted the rules they wrote.
    await posted(human({ cookie: ownerCookie }));
    for (const who of [human(alice), agentOf(alice)])
      expect((await expectStatus(await post(who), 403)).code).toBe('COMMUNITY_RULES_NOT_ACCEPTED');

    // The agent reads the rules it posts under, with its owner's acceptance; it cannot accept.
    const read = await expectStatus(await call(scoped('/rules'), 'GET', agentOf(alice)), 200);
    expect(read).toEqual({ text: 'Be kind. No spam.', version, acceptedVersion: 0 });
    await expectStatus(
      await call(scoped('/rules/accept'), 'POST', agentOf(alice), { version }),
      401
    );
    await expectStatus(
      await call(scoped('/rules/accept'), 'POST', human(alice), { version: version + 1 }),
      409
    );
    await expectStatus(await call(scoped('/rules/accept'), 'POST', human(alice), { version }), 200);
    expect(await auditCount('rules.accept', alice.memberId)).toBe(1);
    await posted(human(alice));
    await posted(agentOf(alice));

    // A new version needs a new acceptance.
    await setRules('Be kind. No spam. No ads.', human(adminPerson));
    expect((await expectStatus(await post(agentOf(alice)), 403)).code).toBe(
      'COMMUNITY_RULES_NOT_ACCEPTED'
    );
    // The owner accepted the old version only.
    expect((await expectStatus(await post(human({ cookie: ownerCookie })), 403)).code).toBe(
      'COMMUNITY_RULES_NOT_ACCEPTED'
    );

    // Removing the rules is a version too, and lifts the gate.
    const removed = await setRules(null);
    expect(removed.version).toBe(version + 2);
    await posted(agentOf(alice));
  });

  it('refuses an edit over someone else’s, and an edit by a member', async () => {
    const current = await expectStatus(await call(scoped('/rules'), 'GET', human(alice)), 200);
    await expectStatus(
      await call(scoped('/rules'), 'PUT', human(alice), {
        text: 'Mine',
        expectedVersion: current.version,
      }),
      403
    );
    await setRules('First');
    await expectStatus(
      await call(scoped('/rules'), 'PUT', human(adminPerson), {
        text: 'Second',
        expectedVersion: current.version,
      }),
      409
    );
  });
});

describe('reports', () => {
  it('takes one report per member per message, and refuses their own and unreadable ones', async () => {
    const entry = await posted(human({ cookie: ownerCookie }), 'reported');
    const report = (who: Who, id = entry) =>
      call(scoped(`/entries/${id}/reports`), 'POST', who, { reason: 'spam', note: 'Too loud' });
    expect(await expectStatus(await report(human(alice)), 201)).toEqual({ reported: true });
    expect(await expectStatus(await report(human(alice)), 200)).toEqual({ reported: true });
    const rows = await pool.query('SELECT 1 FROM reports WHERE entry_id=$1', [entry]);
    expect(rows.rowCount).toBe(1);
    expect(await auditCount('report.create')).toBeGreaterThan(0);

    const own = await posted(agentOf(alice), 'mine');
    await expectStatus(await report(human(alice), own), 409);
    await expectStatus(await report(agentOf(bob)), 401);
    await expectStatus(await report(human(bob), randomUUID()), 404);

    const hidden = await expectStatus(
      await call(scoped('/channels'), 'POST', human({ cookie: ownerCookie }), {
        name: `hidden-${randomUUID().slice(0, 6)}`,
        visibility: 'private',
      }),
      201
    );
    const secret = await posted(
      human({ cookie: ownerCookie }),
      'secret',
      (hidden.channel as { id: string }).id
    );
    await expectStatus(await report(human(bob), secret), 404);
  });

  it('bounds how many of one member’s reports wait at once', async () => {
    const dana = await person('Dana');
    const entries = await pool.query<{ id: string }>(
      `SELECT id FROM entries WHERE channel_id=$1 AND author_member_id=$2 AND removed_at IS NULL
       ORDER BY seq LIMIT 1`,
      [general, ownerId]
    );
    const filler = await pool.query<{ id: string }>(
      `INSERT INTO entries(community_id,channel_id,seq,author_member_id,author_display_name,text,
         idempotency_key,payload_hash)
       SELECT $1,$2,c.last_seq+g,$3,'Olive','filler','fill-'||g||'-'||$4,md5('filler')
       FROM channels c, generate_series(1,$5) g WHERE c.id=$2 RETURNING id`,
      [communityId, general, ownerId, randomUUID(), OPEN_REPORTS_PER_MEMBER]
    );
    await pool.query('UPDATE channels SET last_seq=last_seq+$2 WHERE id=$1', [
      general,
      OPEN_REPORTS_PER_MEMBER,
    ]);
    await pool.query(
      `INSERT INTO reports(community_id,entry_id,reporter_member_id,reason)
       SELECT $1,unnest($2::uuid[]),$3,'spam'`,
      [communityId, filler.rows.map((row) => row.id), dana.memberId]
    );
    const response = await call(
      scoped(`/entries/${entries.rows[0].id}/reports`),
      'POST',
      human(dana),
      { reason: 'other' }
    );
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('3600');
  });

  it('shows moderators the queue and resolves every open report of a message at once', async () => {
    const entry = await posted(agentOf(bob), 'buy now');
    for (const who of [human(alice), human(adminPerson)])
      await expectStatus(
        await call(scoped(`/entries/${entry}/reports`), 'POST', who, { reason: 'spam' }),
        201
      );
    await expectStatus(await call(scoped('/reports'), 'GET', human(alice)), 403);
    const queue = await expectStatus(
      await call(scoped('/reports'), 'GET', human(adminPerson)),
      200
    );
    const mine = (
      queue.reports as { id: string; entryId: string; author: unknown; excerpt: string }[]
    ).filter((row) => row.entryId === entry);
    expect(mine).toHaveLength(2);
    expect(mine[0]).toMatchObject({
      author: { memberId: bob.agentId, kind: 'agent' },
      excerpt: 'buy now',
    });

    // Muting from a report mutes the agent's owner.
    const resolved = await expectStatus(
      await call(scoped(`/reports/${mine[0].id}/resolve`), 'POST', human(adminPerson), {
        action: 'mute',
        minutes: 10,
      }),
      200
    );
    expect(resolved).toEqual({ resolved: 2 });
    expect((await expectStatus(await post(human(bob)), 403)).code).toBe('COMMUNITY_MUTED');
    const rows = await pool.query(
      'SELECT status,action,resolver_member_id FROM reports WHERE entry_id=$1',
      [entry]
    );
    expect(rows.rows).toEqual([
      { status: 'actioned', action: 'mute', resolver_member_id: adminPerson.memberId },
      { status: 'actioned', action: 'mute', resolver_member_id: adminPerson.memberId },
    ]);
    expect(await auditCount('report.resolve', mine[0].id)).toBe(1);
    // Nothing is left open to resolve twice.
    await expectStatus(
      await call(scoped(`/reports/${mine[1].id}/resolve`), 'POST', human(adminPerson), {
        action: 'dismiss',
      }),
      404
    );
    const history = await expectStatus(
      await call(scoped('/reports?status=resolved'), 'GET', human({ cookie: ownerCookie })),
      200
    );
    expect(
      (history.reports as { entryId: string }[]).filter((row) => row.entryId === entry)
    ).toHaveLength(2);
  });

  it('removes the message, or bans its author, or dismisses, by rank', async () => {
    const owner = human({ cookie: ownerCookie });
    const target = await person('Eve');
    const removable = await posted(human(target), 'rude');
    const reportOf = async (id: string, who: Who = human(alice)) => {
      await expectStatus(
        await call(scoped(`/entries/${id}/reports`), 'POST', who, { reason: 'harassment' }),
        201
      );
      const queue = await expectStatus(await call(scoped('/reports'), 'GET', owner), 200);
      return (queue.reports as { id: string; entryId: string }[]).find((row) => row.entryId === id)!
        .id;
    };
    await expectStatus(
      await call(scoped(`/reports/${await reportOf(removable)}/resolve`), 'POST', owner, {
        action: 'remove',
      }),
      200
    );
    const entry = await pool.query('SELECT removed_by FROM entries WHERE id=$1', [removable]);
    expect(entry.rows[0].removed_by).toBe('moderator');
    expect(await auditCount('entry.remove', removable)).toBe(1);

    // An admin cannot act on the owner's message, except to dismiss its report.
    const ownerPost = await posted(owner, 'owner says');
    const ownerReport = await reportOf(ownerPost);
    await expectStatus(
      await call(scoped(`/reports/${ownerReport}/resolve`), 'POST', human(adminPerson), {
        action: 'remove',
      }),
      403
    );
    await expectStatus(
      await call(scoped(`/reports/${ownerReport}/resolve`), 'POST', human(adminPerson), {
        action: 'ban',
      }),
      403
    );
    await expectStatus(
      await call(scoped(`/reports/${ownerReport}/resolve`), 'POST', human(adminPerson), {
        action: 'dismiss',
      }),
      200
    );
    const dismissed = await pool.query('SELECT status,action FROM reports WHERE id=$1', [
      ownerReport,
    ]);
    expect(dismissed.rows[0]).toEqual({ status: 'dismissed', action: null });

    const banned = await posted(agentOf(target), 'again');
    await expectStatus(
      await call(scoped(`/reports/${await reportOf(banned)}/resolve`), 'POST', owner, {
        action: 'ban',
        reason: 'Repeated',
      }),
      200
    );
    const membership = await pool.query('SELECT active FROM members WHERE id=$1', [
      target.memberId,
    ]);
    expect(membership.rows[0].active).toBe(false);
    const ban = await pool.query(
      'SELECT reason FROM bans WHERE member_id=$1 AND lifted_at IS NULL',
      [target.memberId]
    );
    expect(ban.rows).toEqual([{ reason: 'Repeated' }]);
  });
});

describe('concurrent moderation', () => {
  it('resolves two reports of one message at once without a deadlock', async () => {
    const entry = await posted(human(bob), 'twice reported');
    for (const who of [human(alice), human(adminPerson)])
      await expectStatus(
        await call(scoped(`/entries/${entry}/reports`), 'POST', who, { reason: 'spam' }),
        201
      );
    const ids = (
      await pool.query<{ id: string }>('SELECT id FROM reports WHERE entry_id=$1 ORDER BY id', [
        entry,
      ])
    ).rows.map((row) => row.id);
    const results = await Promise.all([
      call(scoped(`/reports/${ids[0]}/resolve`), 'POST', human({ cookie: ownerCookie }), {
        action: 'remove',
      }),
      call(scoped(`/reports/${ids[1]}/resolve`), 'POST', human(adminPerson), {
        action: 'remove',
      }),
    ]);
    expect(results.map((response) => response.status).sort()).toEqual([200, 404]);
  });

  it('takes two of one person’s own changes at once, one after the other', async () => {
    const set = await expectStatus(
      await call(scoped('/rules'), 'PUT', human({ cookie: ownerCookie }), {
        text: 'Twice',
        expectedVersion: (
          await pool.query<{ v: number }>(
            'SELECT rules_version AS v FROM communities WHERE id=$1',
            [communityId]
          )
        ).rows[0].v,
      }),
      200
    );
    const accepts = await Promise.all(
      [0, 1].map(() => call(scoped('/rules/accept'), 'POST', human(bob), { version: set.version }))
    );
    expect(accepts.map((response) => response.status)).toEqual([200, 200]);
    const renames = await Promise.all(
      ['Bobby', 'Robert'].map((displayName) =>
        call(scoped('/me'), 'PATCH', human(bob), { displayName })
      )
    );
    expect(renames.map((response) => response.status)).toEqual([200, 200]);
  });

  it('counts the open-report bound under a lock, so a burst cannot pass it', async () => {
    const gil = await person('Gil');
    const filler = await pool.query<{ id: string }>(
      `INSERT INTO entries(community_id,channel_id,seq,author_member_id,author_display_name,text,
         idempotency_key,payload_hash)
       SELECT $1,$2,c.last_seq+g,$3,'Olive','burst','burst-'||g||'-'||$4,md5('burst')
       FROM channels c, generate_series(1,$5) g WHERE c.id=$2 RETURNING id`,
      [communityId, general, ownerId, randomUUID(), OPEN_REPORTS_PER_MEMBER + 5]
    );
    await pool.query('UPDATE channels SET last_seq=last_seq+$2 WHERE id=$1', [
      general,
      OPEN_REPORTS_PER_MEMBER + 5,
    ]);
    const results = await Promise.all(
      filler.rows.map((row) =>
        call(scoped(`/entries/${row.id}/reports`), 'POST', human(gil), { reason: 'spam' })
      )
    );
    expect(results.filter((response) => response.status === 201)).toHaveLength(
      OPEN_REPORTS_PER_MEMBER
    );
    const open = await pool.query('SELECT 1 FROM reports WHERE reporter_member_id=$1', [
      gil.memberId,
    ]);
    expect(open.rowCount).toBe(OPEN_REPORTS_PER_MEMBER);
  });
});

describe('a private channel in the queue', () => {
  it('hides the excerpt and the note from a moderator outside it', async () => {
    const hidden = await expectStatus(
      await call(scoped('/channels'), 'POST', human({ cookie: ownerCookie }), {
        name: `closed-${randomUUID().slice(0, 6)}`,
        visibility: 'private',
      }),
      201
    );
    const entry = await posted(
      human({ cookie: ownerCookie }),
      'private words',
      (hidden.channel as { id: string }).id
    );
    await pool.query(
      `INSERT INTO reports(community_id,entry_id,reporter_member_id,reason,note)
       VALUES($1,$2,$3,'other','It says private words')`,
      [communityId, entry, bob.memberId]
    );
    const queue = await expectStatus(
      await call(scoped('/reports'), 'GET', human(adminPerson)),
      200
    );
    const row = (queue.reports as { entryId: string; excerpt: unknown; note: unknown }[]).find(
      (report) => report.entryId === entry
    );
    expect(row).toMatchObject({ excerpt: null, note: null });
  });
});

describe('display names', () => {
  it('lets a member rename themselves, never to an agent’s name or handle', async () => {
    const renamed = await expectStatus(
      await call(scoped('/me'), 'PATCH', human(alice), { displayName: '  Alice A.  ' }),
      200
    );
    expect((renamed.member as { displayName: string }).displayName).toBe('Alice A.');
    expect(await auditCount('member.rename', alice.memberId)).toBe(1);
    const handle = await pool.query<{ handle: string }>('SELECT handle FROM agents WHERE id=$1', [
      bob.agentId,
    ]);
    for (const name of ['Bob Bot', 'bob bot', 'B o b-B o t', `@${handle.rows[0].handle}`])
      await expectStatus(
        await call(scoped('/me'), 'PATCH', human(alice), { displayName: name }),
        409
      );
    await expectStatus(
      await call(scoped('/me'), 'PATCH', human(alice), { displayName: 'Bad\u0007Name' }),
      400
    );
    await expectStatus(
      await call(scoped('/me'), 'PATCH', agentOf(alice), { displayName: 'Agent' }),
      401
    );
  });

  it('keeps reserved names for the owner and admins, at sign-up too', async () => {
    const owner = human({ cookie: ownerCookie });
    await expectStatus(
      await call(scoped('/reserved-names'), 'PUT', human(adminPerson), { names: ['Team'] }),
      403
    );
    const reserved = await expectStatus(
      await call(scoped('/reserved-names'), 'PUT', owner, {
        names: ['Moderated Team', 'moderated team', 'Ｓｔａｆｆ'],
      }),
      200
    );
    expect(reserved.names).toEqual(['moderated team', 'Ｓｔａｆｆ']);
    await expectStatus(
      await call(scoped('/me'), 'PATCH', human(bob), { displayName: 'Moderated-Team' }),
      409
    );
    await expectStatus(
      await call(scoped('/me'), 'PATCH', human(bob), { displayName: 'staff' }),
      409
    );
    await expectStatus(
      await call(scoped('/me'), 'PATCH', human(adminPerson), { displayName: 'Staff' }),
      200
    );

    for (const name of [
      'Moderated\u200BTeam',
      'Mödérated Team',
      'Moderated\u2010Team',
      'Moderated\u2800Team',
      'Moderated\u3164Team',
    ])
      expect([400, 409], name).toContain(
        (await call(scoped('/me'), 'PATCH', human(bob), { displayName: name })).status
      );
    // A member's agent cannot take a reserved name either; the owner's can.
    const grant = randomToken();
    await pool.query(
      `INSERT INTO connection_grants(community_id,member_id,token_hash,scopes,install_name)
       VALUES($1,$2,$3,'{read,post,enroll-agent}','Reserved test')`,
      [communityId, bob.memberId, hashSecret(grant)]
    );
    await expectStatus(
      await call(
        scoped('/agents'),
        'POST',
        { token: grant },
        {
          localAgentId: randomUUID(),
          displayName: 'Moderated Team',
        }
      ),
      409
    );
    await mintAgent(ownerId, 'Moderated Team');
    await expectStatus(
      await call(
        scoped('/agents'),
        'POST',
        { token: grant },
        {
          localAgentId: randomUUID(),
          displayName: 'Helper',
          handle: 'staff',
        }
      ),
      409
    );

    // Someone whose account carries a reserved name joins under a plain one they can change.
    const email = `staff-${randomUUID().slice(0, 6)}@mod.test`;
    await seedCredentialAccount(pool, { name: 'STAFF', email, password });
    const memberId = await admit(await signIn(email));
    const row = await pool.query('SELECT display_name FROM members WHERE id=$1', [memberId]);
    expect(row.rows[0].display_name).toBe('Member');

    // Someone who took a name before it was reserved loses it when they come back.
    const hal = await person('Hal');
    await expectStatus(
      await call(scoped('/me'), 'PATCH', human(hal), { displayName: 'Night Shift' }),
      200
    );
    await expectStatus(await call(scoped(`/members/${hal.memberId}`), 'DELETE', owner), 204);
    await expectStatus(
      await call(scoped('/reserved-names'), 'PUT', owner, { names: ['Night Shift'] }),
      200
    );
    expect(await admit(hal.cookie)).toBe(hal.memberId);
    const back = await pool.query('SELECT display_name FROM members WHERE id=$1', [hal.memberId]);
    expect(back.rows[0].display_name).toBe('Member');
  });
});

describe('agents and people’s names', () => {
  it('keeps agents off other people’s names, and lets a person share a name with their own agent', async () => {
    const ivy = await person('Ivy');
    const grant = randomToken();
    await pool.query(
      `INSERT INTO connection_grants(community_id,member_id,token_hash,scopes,install_name)
       VALUES($1,$2,$3,'{read,post,enroll-agent}','Names test')`,
      [communityId, ivy.memberId, hashSecret(grant)]
    );
    const bobName = (
      await pool.query<{ display_name: string }>('SELECT display_name FROM members WHERE id=$1', [
        bob.memberId,
      ])
    ).rows[0].display_name;
    await expectStatus(
      await call(
        scoped('/agents'),
        'POST',
        { token: grant },
        {
          localAgentId: randomUUID(),
          displayName: bobName,
        }
      ),
      409
    );
    await mintAgent(ivy.memberId, 'Ivy');
    // Ivy's own agent is named Ivy, and Ivy keeps her name; nobody else may take it.
    await expectStatus(await call(scoped('/me'), 'PATCH', human(ivy), { displayName: 'Ivy' }), 200);
    await expectStatus(
      await call(scoped('/me'), 'PATCH', human(alice), { displayName: 'Ivy' }),
      409
    );
  });
});

describe('the moderation record through erasure', () => {
  it('drops the erased person’s report notes, notes about their messages, and their clocks', async () => {
    const frank = await person('Frank');
    const theirs = await posted(agentOf(frank), 'mine');
    const others = await posted(human(alice), 'hers');
    await pool.query('UPDATE channels SET slow_mode_seconds=60 WHERE id=$1', [general]);
    await posted(human(frank), 'clocked');
    await expectStatus(
      await call(scoped(`/entries/${theirs}/reports`), 'POST', human(bob), {
        reason: 'spam',
        note: 'Frank again',
      }),
      201
    );
    await expectStatus(
      await call(scoped(`/entries/${others}/reports`), 'POST', human(frank), {
        reason: 'other',
        note: 'From Frank',
      }),
      201
    );
    await expectStatus(
      await call(
        scoped(`/members/${frank.memberId}/mute`),
        'POST',
        human({ cookie: ownerCookie }),
        {
          minutes: 60,
        }
      ),
      200
    );
    expect(await eraseMembership(pool, communityId, frank.memberId, { log: () => {} })).toBe(
      'erased'
    );
    const notes = await pool.query(
      'SELECT reason,note FROM reports WHERE entry_id=ANY($1::uuid[]) ORDER BY reason',
      [[theirs, others]]
    );
    expect(notes.rows).toEqual([
      { reason: 'other', note: null },
      { reason: 'spam', note: null },
    ]);
    const member = await pool.query('SELECT muted_until FROM members WHERE id=$1', [
      frank.memberId,
    ]);
    expect(member.rows[0].muted_until).toBeNull();
    const clocks = await pool.query('SELECT 1 FROM channel_post_clocks WHERE member_id=$1', [
      frank.memberId,
    ]);
    expect(clocks.rowCount).toBe(0);
  });
});
