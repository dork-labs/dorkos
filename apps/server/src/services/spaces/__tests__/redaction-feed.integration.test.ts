/**
 * The redaction feed (specs/community-member-erasure task 2.1, AC-13, and
 * specs/community-single-item-delete task 1.3, AC-12): the entries of one channel that changed
 * after they were posted, as they stand now, read by cursor. Real PostgreSQL and a real server.
 */
import { randomBytes } from 'node:crypto';
import type { PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CommunityWireRedactionPageSchema,
  type CommunityWireRedactionPage,
} from '@dorkos/shared/community-wire';
import { removeEntry } from '../content-removal.js';
import { ERASED_ENTRY_TEXT, REMOVED_ENTRY_TEXT } from '../content/tombstones.js';
import { eraseMembership } from '../erasure/erasure.js';
import {
  bootstrapHost,
  expectStatus,
  startTenancyHarness,
  type TenancyHarness,
} from './tenancy-test-harness.js';
import { body, PASSWORD, post } from './member-erasure-fixture.js';
import { makeScene, type Scene } from './member-erasure-scenes.js';

let h: TenancyHarness;
let host: { cookie: string; communityId: string };
let keyCounter = 0;

beforeAll(async () => {
  h = await startTenancyHarness('redactionfeed');
  host = await bootstrapHost(h, 'Rae Host', 'rae@host.test');
}, 60_000);

afterAll(async () => {
  await h?.close();
});

type Auth = { cookie?: string; bearer?: string };
const scene = (label: string) => makeScene(h, host.cookie, label);

function feedUrl(s: Scene, query: Record<string, string> = {}, channelId = s.channelId) {
  const params = new URLSearchParams(query);
  return `${s.base}/channels/${channelId}/redactions${params.size ? `?${params}` : ''}`;
}

async function page(
  s: Scene,
  auth: Auth,
  query: Record<string, string> = {}
): Promise<CommunityWireRedactionPage> {
  // Every page must parse with the strict wire schema, or a DorkOS installation would refuse it.
  return CommunityWireRedactionPageSchema.parse(
    await body(await h.call(feedUrl(s, query), auth), 200, 'redaction page')
  );
}

/** Read the feed to its end from `cursor`, following `hasMore`, and return every item and the end. */
async function readAll(s: Scene, auth: Auth, cursor?: string, limit = 100) {
  const items: CommunityWireRedactionPage['redactions'] = [];
  let next = cursor;
  for (let round = 0; round < 100; round++) {
    const read = await page(s, auth, {
      ...(next ? { cursor: next } : {}),
      limit: String(limit),
    });
    items.push(...read.redactions);
    next = read.nextCursor;
    if (!read.hasMore) return { items, cursor: next };
  }
  throw new Error('The redaction feed never reached its end');
}

async function say(s: Scene, auth: Auth, text: string) {
  return (
    await post(h, s.communityId, s.channelId, auth, {
      text,
      idempotencyKey: `feed-${++keyCounter}`,
    })
  ).id;
}

const deleteEntry = (s: Scene, entryId: string, auth: Auth) =>
  h.call(`${s.base}/entries/${entryId}`, { method: 'DELETE', ...auth });

describe('the redaction feed (AC-13)', { timeout: 120_000 }, () => {
  // Purpose: the feed says nothing before a change, and after an erasure returns each changed
  // entry once, as it stands now. It fails if the feed returns rows before any change, repeats an
  // entry changed twice in one page, returns stale text, or breaks the strict wire schema.
  it('is empty before erasure and lists each changed entry once, as it is now, after it', async () => {
    const s = await scene('feed');
    const before = await page(s, { cookie: s.q.cookie });
    expect(before).toMatchObject({ redactions: [], hasMore: false });

    await eraseMembership(h.pool, s.communityId, s.p.memberId);

    const after = await readAll(s, { cookie: s.q.cookie }, before.nextCursor);
    const changed = await h.pool.query<{ entry_id: string }>(
      'SELECT DISTINCT entry_id FROM entry_redactions WHERE channel_id=$1',
      [s.channelId]
    );
    // P's message, P's agent's note, P's file message (its file went first, then its text), and
    // Q's message that mentioned P and the agent.
    expect(changed.rowCount).toBe(4);
    expect(after.items.map((item) => item.entry.id).sort()).toEqual(
      changed.rows.map((row) => row.entry_id).sort()
    );
    const byId = new Map(after.items.map((item) => [item.entry.id, item.entry]));
    expect(byId.get(s.pEntryId)).toMatchObject({
      text: ERASED_ENTRY_TEXT,
      authorDisplayName: 'Erased member',
      mentions: [],
      attachments: [],
    });
    expect(byId.get(s.qMentionId)?.text).toBe('@[erased] and @[erased] thanks');
    expect(JSON.stringify(after.items)).not.toContain(s.p.handle);

    // Nothing new since: the stored cursor now reads an empty page, and says so.
    const idle = await page(s, { cookie: s.q.cookie }, { cursor: after.cursor });
    expect(idle).toMatchObject({ redactions: [], hasMore: false });
  });

  // Purpose: `from=end` hands a reader that just loaded history a cursor past every earlier
  // change, and later changes still arrive. It fails if the end cursor replays old changes or
  // skips new ones.
  it('starts a reader at the end, then gives it only later changes', async () => {
    const s = await scene('end');
    const early = await say(s, { cookie: s.q.cookie }, 'early message');
    await body(await deleteEntry(s, early, { cookie: s.q.cookie }), 200, 'delete early');
    const end = await page(s, { cookie: s.q.cookie }, { from: 'end' });
    expect(end).toMatchObject({ redactions: [], hasMore: false });

    const late = await say(s, { cookie: s.q.cookie }, 'late message');
    await body(await deleteEntry(s, late, { cookie: s.q.cookie }), 200, 'delete late');
    const read = await readAll(s, { cookie: s.q.cookie }, end.nextCursor);
    expect(read.items.map((item) => item.entry.id)).toEqual([late]);
  });

  // Purpose (single-item delete AC-12, feed half): a removal (not an erasure) is carried with its
  // tombstone projection and the author's name unchanged.
  it('carries a deleted message as its tombstone, keeping its author', async () => {
    const s = await scene('delete');
    const start = await page(s, { cookie: s.q.cookie }, { from: 'end' });
    const entryId = await say(s, { cookie: s.p.cookie }, 'canary-deleted-text');
    await body(await deleteEntry(s, entryId, { cookie: s.p.cookie }), 200, 'delete');
    const read = await readAll(s, { cookie: s.q.cookie }, start.nextCursor);
    expect(read.items).toHaveLength(1);
    expect(read.items[0].entry).toMatchObject({
      id: entryId,
      text: REMOVED_ENTRY_TEXT.author,
      authorDisplayName: expect.stringMatching(/^Pat /),
    });
    expect(JSON.stringify(read.items)).not.toContain('canary-deleted-text');
  });

  // Purpose: the feed is read with exactly history's authority. A private channel the caller is
  // not in, and another community's channel, answer 404; a public channel they did not join
  // answers 403, as history does; a member who left can no longer read it (their installation
  // keeps what it had, the named limit).
  it('refuses readers who cannot read the channel', async () => {
    const s = await scene('authz');
    const other = await scene('authzother');
    const privateChannel = await body<{ channel: { id: string } }>(
      await h.call(`${s.base}/channels`, {
        cookie: s.owner.cookie,
        body: { name: 'secret', visibility: 'private' },
      }),
      201,
      'private channel'
    );
    expect(
      (await h.call(feedUrl(s, {}, privateChannel.channel.id), { cookie: s.q.cookie })).status
    ).toBe(404);
    expect((await h.call(feedUrl(s, {}, other.channelId), { cookie: s.q.cookie })).status).toBe(
      404
    );
    const unjoined = await body<{ channel: { id: string } }>(
      await h.call(`${s.base}/channels`, {
        cookie: s.owner.cookie,
        body: { name: 'lobby', visibility: 'public' },
      }),
      201,
      'public channel'
    );
    expect((await h.call(feedUrl(s, {}, unjoined.channel.id), { cookie: s.q.cookie })).status).toBe(
      403
    );
    // The personal grant of P's installation reads the feed while P is a member...
    expect((await h.call(feedUrl(s), { bearer: s.grant })).status).toBe(200);
    await expectStatus(
      await h.call(`${s.base}/me/leave`, {
        cookie: s.p.cookie,
        body: { password: PASSWORD, communityName: `Scene ${s.slug}` },
      }),
      204,
      'leave'
    );
    // ...and not after P leaves.
    expect((await h.call(feedUrl(s), { bearer: s.grant })).status).toBe(401);
    expect((await h.call(feedUrl(s), { bearer: s.agent.token })).status).toBe(401);
  });

  // Purpose: a cursor is bound to one channel, one community, and the feed (not history). Each
  // mismatch answers 410 so a reader starts over rather than reading the wrong rows.
  it('answers 410 for another channel, a history cursor, or a forged cursor', async () => {
    const s = await scene('cursor');
    const other = await scene('cursorother');
    const otherChannel = await body<{ channel: { id: string } }>(
      await h.call(`${s.base}/channels`, {
        cookie: s.owner.cookie,
        body: { name: 'second', visibility: 'public' },
      }),
      201,
      'second channel'
    );
    await body(
      await h.call(`${s.base}/channels/${otherChannel.channel.id}/join`, {
        cookie: s.q.cookie,
        body: {},
      }),
      200,
      'join second'
    );
    const secondCursor = (
      await body<{ nextCursor: string }>(
        await h.call(feedUrl(s, {}, otherChannel.channel.id), { cookie: s.q.cookie }),
        200,
        'second channel feed'
      )
    ).nextCursor;
    const foreignCursor = (
      await body<{ nextCursor: string }>(
        await h.call(feedUrl(other), { cookie: other.q.cookie }),
        200,
        'other community feed'
      )
    ).nextCursor;
    const historyCursor = (
      await body<{ entries: { cursor: string }[] }>(
        await h.call(`${s.base}/channels/${s.channelId}/entries`, { cookie: s.q.cookie }),
        200,
        'history'
      )
    ).entries[0].cursor;
    for (const cursor of [secondCursor, foreignCursor, historyCursor, 'forged.cursor']) {
      const response = await h.call(feedUrl(s, { cursor }), { cookie: s.q.cookie });
      expect(response.status).toBe(410);
      expect(await response.json()).toMatchObject({ code: 'CURSOR_STALE' });
    }
    // And the reverse: a feed cursor is not a history cursor.
    const feedCursor = (await page(s, { cookie: s.q.cookie })).nextCursor;
    expect(
      (
        await h.call(
          `${s.base}/channels/${s.channelId}/entries?cursor=${encodeURIComponent(feedCursor)}`,
          { cookie: s.q.cookie }
        )
      ).status
    ).toBe(410);
    // Asking for both a cursor and the end is a malformed request.
    expect(
      (await h.call(feedUrl(s, { cursor: feedCursor, from: 'end' }), { cookie: s.q.cookie })).status
    ).toBe(400);
  });

  // Purpose (AC-12, 2.1 half): a restore rewinds the redaction ids, and erasure:reapply gives the
  // community a new epoch, so a cursor saved before it answers 410 and a fresh read returns every
  // redaction. Here the epoch change is made directly; member-erasure-recovery runs the restore.
  it('answers 410 for a cursor from an older epoch, and a fresh read returns everything', async () => {
    const s = await scene('epoch');
    await eraseMembership(h.pool, s.communityId, s.p.memberId);
    const first = await readAll(s, { cookie: s.q.cookie });
    expect(first.items).toHaveLength(4);
    await h.pool.query('UPDATE communities SET redaction_epoch=$2 WHERE id=$1', [
      s.communityId,
      randomBytes(8).readBigInt64BE().toString(),
    ]);
    const stale = await h.call(feedUrl(s, { cursor: first.cursor }), { cookie: s.q.cookie });
    expect(stale.status).toBe(410);
    const fresh = await readAll(s, { cookie: s.q.cookie });
    expect(fresh.items.map((item) => item.entry.id).sort()).toEqual(
      first.items.map((item) => item.entry.id).sort()
    );
  });
});

describe(
  'the feed cursor never skips (AC-13, single-item delete AC-8)',
  { timeout: 120_000 },
  () => {
    // Purpose: a reader polling the feed while many removals commit concurrently, storing each
    // page's cursor as a DorkOS installation does, ends up with every removal. It fails if a
    // redaction id could become visible after a higher one a reader has already stepped past.
    it('gives a polling reader every removal made while it polls', async () => {
      const s = await scene('race');
      const ids: string[] = [];
      for (let index = 0; index < 24; index++)
        ids.push(await say(s, { cookie: s.q.cookie }, `race ${index}`));
      let cursor = (await page(s, { cookie: s.q.cookie }, { from: 'end' })).nextCursor;
      const seen = new Set<string>();
      let removing = true;
      const poller = (async () => {
        while (removing) {
          const read = await readAll(s, { cookie: s.q.cookie }, cursor, 3);
          for (const item of read.items) seen.add(item.entry.id);
          cursor = read.cursor;
        }
      })();
      await Promise.all(
        ids.map(async (id) =>
          body(await deleteEntry(s, id, { cookie: s.q.cookie }), 200, `delete ${id}`)
        )
      );
      removing = false;
      await poller;
      const last = await readAll(s, { cookie: s.q.cookie }, cursor, 3);
      for (const item of last.items) seen.add(item.entry.id);
      expect([...seen].sort()).toEqual([...ids].sort());
    });

    // Purpose: while one removal has bumped the version and not yet written its row, a second waits,
    // and a reader that stores a cursor in between still receives both afterwards. It fails if the
    // feed's cursor could run ahead of a row that commits later.
    it('keeps a stored cursor behind a removal that is still committing', async () => {
      const s = await scene('barrier');
      const first = await say(s, { cookie: s.q.cookie }, 'first');
      const second = await say(s, { cookie: s.q.cookie }, 'second');
      const start = await page(s, { cookie: s.q.cookie }, { from: 'end' });
      let release!: () => void;
      const released = new Promise<void>((resolve) => (release = resolve));
      let paused!: () => void;
      const pausedAfterBump = new Promise<void>((resolve) => (paused = resolve));

      const inTransaction = async (work: (client: PoolClient) => Promise<void>) => {
        const client = await h.pool.connect();
        try {
          await client.query('BEGIN');
          await client.query('SELECT 1 FROM communities WHERE id=$1 FOR SHARE', [s.communityId]);
          await work(client);
          await client.query('COMMIT');
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        } finally {
          client.release();
        }
      };
      const a = inTransaction((client) =>
        removeEntry(
          client,
          { communityId: s.communityId, entryId: first, removedBy: 'moderator' },
          {
            afterVersionBump: async () => {
              paused();
              await released;
            },
          }
        ).then(() => undefined)
      );
      await pausedAfterBump;
      const b = inTransaction((client) =>
        removeEntry(client, {
          communityId: s.communityId,
          entryId: second,
          removedBy: 'moderator',
        }).then(() => undefined)
      );
      // Neither removal has committed: the reader stores a cursor that must not pass either.
      const between = await readAll(s, { cookie: s.q.cookie }, start.nextCursor);
      expect(between.items).toEqual([]);
      release();
      await Promise.all([a, b]);
      const after = await readAll(s, { cookie: s.q.cookie }, between.cursor);
      expect(after.items.map((item) => item.entry.id)).toEqual([first, second]);
    });
  }
);
