/**
 * What a ban actually ends (DOR-3623): one person, with every credential they can hold, proven
 * able to reach each route first and refused on all of them after. Real HTTP and PostgreSQL.
 * Every read is checked for the words it must no longer show, and every write for leaving nothing.
 * The rules of who may ban, and the refusal of each way back in, are in open-admission and
 * owner-claim-ban; this file is the whole reach of one ban, ending with the ban lifted.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  admit,
  bootstrapHost,
  expectStatus,
  pairInstall,
  startTenancyHarness,
  type TenancyHarness,
} from './tenancy-test-harness.js';
import { responseCookies } from './bootstrap-test-helper.js';
import { body, post, upload } from './member-erasure-fixture.js';
import { makeScene, type Scene } from './member-erasure-scenes.js';

const SECRET_WORDS = 'words the banned person must not read';

let h: TenancyHarness;
let host: { cookie: string; communityId: string };

beforeAll(async () => {
  h = await startTenancyHarness('banreach');
  host = await bootstrapHost(h, 'Bo Host', 'bo@host.test');
}, 60_000);

afterAll(async () => {
  await h?.close();
});

type Auth = { cookie?: string; bearer?: string };

/** One request a person could make, as a path under the space. */
interface Reach {
  name: string;
  path: string;
  method?: string;
  body?: unknown;
}

/** Everything a member can read, by the routes that read it. */
function reads(s: Scene, fileId: string): Reach[] {
  const channel = `/channels/${s.channelId}`;
  return [
    { name: 'own membership', path: '/me' },
    { name: 'member list', path: '/members' },
    { name: 'channel list', path: '/channels' },
    { name: 'one channel', path: channel },
    { name: 'channel members', path: `${channel}/members` },
    { name: 'messages', path: `${channel}/entries` },
    { name: 'threads', path: `${channel}/threads?roots=${s.pEntryId}` },
    { name: 'changed messages', path: `${channel}/redactions` },
    { name: 'read position', path: `${channel}/read-cursor` },
    { name: 'mentions', path: '/attention' },
    { name: 'direct messages', path: '/dms' },
    { name: 'a file', path: `/attachments/${fileId}` },
  ];
}

/** The reads a connection or an agent has too. */
function bearerReads(s: Scene): Reach[] {
  const channel = `/channels/${s.channelId}`;
  return [
    { name: 'channel list', path: '/channels' },
    { name: 'one channel', path: channel },
    { name: 'messages', path: `${channel}/entries` },
  ];
}

function reach(s: Scene, target: Reach, auth: Auth) {
  return h.call(`${s.base}${target.path}`, {
    method: target.method ?? 'GET',
    ...auth,
    ...(target.body === undefined ? {} : { body: target.body }),
  });
}

/** How many messages the space holds, so a refused post can be shown to have left nothing. */
async function entryCount(s: Scene): Promise<number> {
  const rows = await h.pool.query<{ n: number }>(
    'SELECT count(*)::int AS n FROM entries WHERE community_id=$1',
    [s.communityId]
  );
  return rows.rows[0].n;
}

/** Whether a stream ends by itself within `ms`. It answers true once the body closes. */
async function endsWithin(stream: Response, ms: number): Promise<boolean> {
  const reader = stream.body!.getReader();
  const timer = new Promise<false>((resolve) => setTimeout(() => resolve(false), ms));
  const drained = (async () => {
    for (;;) if ((await reader.read()).done) return true;
  })();
  const ended = await Promise.race([drained, timer]);
  await reader.cancel().catch(() => undefined);
  return ended;
}

/** Try the invitation route with `cookie`, and answer the status redeeming gives. */
async function redeemStatus(s: Scene, cookie: string): Promise<number> {
  const { token } = await body<{ token: string }>(
    await h.call(`${s.base}/invites`, { cookie: s.owner.cookie, body: { seats: 1 } }),
    201,
    'issue invite'
  );
  const preflight = await expectStatus(
    await h.call(`${s.base}/invites/preflight`, { body: { token } }),
    200,
    'preflight'
  );
  const signedIn = cookie
    .split('; ')
    .filter((part) => !part.startsWith('community_admission='))
    .join('; ');
  const both = `${signedIn}; ${responseCookies(preflight)}`;
  await expectStatus(
    await h.call(`${s.base}/invites/bind`, { cookie: both, body: {} }),
    200,
    'bind'
  );
  const redeemed = await h.call(`${s.base}/invites/redeem`, { cookie: both, body: {} });
  await redeemed.body?.cancel();
  return redeemed.status;
}

describe('a ban', { timeout: 120_000 }, () => {
  // Purpose: fails if any route still answers a banned person, through their browser, their
  // app's connection, or their agent; if a file link or a live stream outlives the ban; if a
  // way back in stays open; or if lifting the ban brings back any old access.
  it('ends everything the person could reach, and lifting it brings none of it back', async () => {
    const s = await makeScene(h, host.cookie, 'reach');
    const fileId = await upload(h, s.communityId, s.channelId, s.q.cookie, 'q.txt', SECRET_WORDS);
    const qEntry = await post(
      h,
      s.communityId,
      s.channelId,
      { cookie: s.q.cookie },
      { text: SECRET_WORDS, idempotencyKey: 'q-secret', attachmentIds: [fileId] }
    );
    const cookie = { cookie: s.p.cookie };
    const grant = { bearer: s.grant };
    const agent = { bearer: s.agent.token };
    const channel = `/channels/${s.channelId}`;

    // Every route answers before the ban, so a refusal after it can only be the ban's doing.
    const browserReads = reads(s, fileId);
    for (const target of browserReads) {
      const response = await reach(s, target, cookie);
      await response.body?.cancel();
      expect(response.status, `before the ban: ${target.name}`).toBe(200);
    }
    for (const [who, auth] of [
      ['connection', grant],
      ['agent', agent],
    ] as const)
      for (const target of bearerReads(s)) {
        const response = await reach(s, target, auth);
        await response.body?.cancel();
        expect(response.status, `before the ban: ${who}, ${target.name}`).toBe(200);
      }
    const { url: fileLink } = await body<{ url: string }>(
      await h.call(`${s.base}/attachments/${fileId}/link`, { ...cookie, body: {} }),
      200,
      'file link'
    );
    const linkPath = new URL(fileLink).pathname;
    await expectStatus(await h.call(linkPath), 200, 'file link opens before the ban');
    const streams = await Promise.all(
      [cookie, agent].map((auth) => reach(s, { name: 'stream', path: `${channel}/events` }, auth))
    );
    for (const stream of streams) expect(stream.status).toBe(200);

    const banned = await body<{ ban: { id: string } }>(
      await h.call(`${s.base}/members/${s.p.memberId}/ban`, {
        cookie: s.owner.cookie,
        body: { reason: 'Reach test' },
      }),
      201,
      'ban'
    );

    expect(await Promise.all(streams.map((stream) => endsWithin(stream, 10_000)))).toEqual([
      true,
      true,
    ]);

    // Nothing reads, by any credential, and nothing it answers shows the words.
    for (const [who, auth, targets] of [
      ['browser', cookie, browserReads],
      ['connection', grant, bearerReads(s)],
      ['agent', agent, bearerReads(s)],
    ] as const)
      for (const target of targets) {
        const response = await reach(s, target, auth);
        const text = await response.text();
        expect([401, 403, 404], `${who}, ${target.name}: ${text.slice(0, 200)}`).toContain(
          response.status
        );
        expect(text, `${who}, ${target.name}`).not.toContain(SECRET_WORDS);
      }
    for (const [who, auth] of [
      ['browser', cookie],
      ['connection', grant],
      ['agent', agent],
    ] as const) {
      const stream = await reach(s, { name: 'stream', path: `${channel}/events` }, auth);
      await stream.body?.cancel();
      expect([401, 403, 404], `${who}, new stream`).toContain(stream.status);
    }
    const linked = await h.call(linkPath);
    await linked.body?.cancel();
    expect(linked.status, 'file link after the ban').toBe(403);

    // Nothing writes, and nothing is left behind.
    const before = await entryCount(s);
    const writes: [string, Auth, Reach][] = [
      [
        'browser',
        cookie,
        {
          name: 'post',
          path: `${channel}/entries`,
          method: 'POST',
          body: { text: 'still here', idempotencyKey: 'after-ban-browser' },
        },
      ],
      [
        'connection',
        grant,
        {
          name: 'post',
          path: `${channel}/entries`,
          method: 'POST',
          body: { text: 'still here', idempotencyKey: 'after-ban-grant' },
        },
      ],
      [
        'agent',
        agent,
        {
          name: 'post',
          path: `${channel}/entries`,
          method: 'POST',
          body: { text: 'still here', idempotencyKey: 'after-ban-agent' },
        },
      ],
      [
        'browser',
        cookie,
        {
          name: 'report',
          path: `/entries/${qEntry.id}/reports`,
          method: 'POST',
          body: { reason: 'spam' },
        },
      ],
      ['browser', cookie, { name: 'join', path: `${channel}/join`, method: 'POST', body: {} }],
      [
        'browser',
        cookie,
        {
          name: 'file link',
          path: `/attachments/${fileId}/link`,
          method: 'POST',
          body: {},
        },
      ],
      [
        'browser',
        cookie,
        { name: 'remove a message', path: `/entries/${qEntry.id}`, method: 'DELETE' },
      ],
      [
        'connection',
        grant,
        {
          name: 'new agent',
          path: '/agents',
          method: 'POST',
          body: { localAgentId: 'after-ban', displayName: 'After' },
        },
      ],
      [
        'browser',
        cookie,
        { name: 'ban someone', path: `/members/${s.q.memberId}/ban`, method: 'POST', body: {} },
      ],
    ];
    for (const [who, auth, target] of writes) {
      const response = await reach(s, target, auth);
      const text = await response.text();
      expect([401, 403, 404], `${who}, ${target.name}: ${text.slice(0, 200)}`).toContain(
        response.status
      );
    }
    expect(await entryCount(s)).toBe(before);
    const qStill = await h.pool.query('SELECT removed_at FROM entries WHERE id=$1', [qEntry.id]);
    expect(qStill.rows[0].removed_at).toBeNull();
    const reports = await h.pool.query('SELECT 1 FROM reports WHERE reporter_member_id=$1', [
      s.p.memberId,
    ]);
    expect(reports.rowCount).toBe(0);

    // The way back in stays shut.
    expect(await redeemStatus(s, s.p.cookie)).toBe(403);

    // The record says who did it, and the person sees none of it.
    const audit = await h.pool.query(
      `SELECT actor_member_id FROM audit_events WHERE community_id=$1 AND action='member.ban'
       AND subject_id=$2`,
      [s.communityId, s.p.memberId]
    );
    expect(audit.rows).toEqual([{ actor_member_id: s.owner.memberId }]);
    const banList = await h.call(`${s.base}/bans`, cookie);
    await banList.body?.cancel();
    expect([401, 403, 404], 'the ban list').toContain(banList.status);

    // Lifted: they can come back the usual way, and none of the old access comes with them.
    await expectStatus(
      await h.call(`${s.base}/bans/${banned.ban.id}`, { method: 'DELETE', cookie: s.owner.cookie }),
      204,
      'lift'
    );
    for (const [who, auth] of [
      ['browser, before rejoining', cookie],
      ['old connection', grant],
      ['old agent', agent],
    ] as const) {
      const response = await reach(s, { name: 'messages', path: `${channel}/entries` }, auth);
      await response.body?.cancel();
      expect([401, 403, 404], who).toContain(response.status);
    }
    const back = await admit(h, s.communityId, s.owner.cookie, { cookie: s.p.cookie });
    expect(back.memberId).toBe(s.p.memberId);
    // Back, but in no channel, until they join one again.
    const seats = await h.pool.query(
      'SELECT 1 FROM channel_members WHERE member_id=$1 AND channel_id=$2',
      [s.p.memberId, s.channelId]
    );
    expect(seats.rowCount).toBe(0);
    for (const [who, auth] of [
      ['old connection', grant],
      ['old agent', agent],
    ] as const) {
      const response = await reach(s, { name: 'messages', path: `${channel}/entries` }, auth);
      await response.body?.cancel();
      expect([401, 403, 404], `${who} after rejoining`).toContain(response.status);
    }
    const oldLink = await h.call(linkPath);
    await oldLink.body?.cancel();
    expect(oldLink.status, 'old file link after rejoining').toBe(403);

    // A connection made now works: the point of the lifted ban is that normal joining is back.
    const fresh = await pairInstall(h, s.communityId, back.cookie, ['read'], 'after the ban');
    await expectStatus(
      await h.call(`${s.base}/channels`, { bearer: fresh }),
      200,
      'new connection'
    );
  });
});
