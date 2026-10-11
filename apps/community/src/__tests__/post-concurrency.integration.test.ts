/**
 * Posts to one channel run side by side and queue only for the channel's next sequence number
 * (DOR-2837). These prove the parts of that the load test cannot: a post no longer waits for
 * another post's checks, a change to the channel still holds posts back, and posts that land at
 * once still number gap-free, commit in number order, and never deadlock on each other's
 * mentions.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { COMMUNITY_TEST_RUNTIME_ACKNOWLEDGEMENT_PHRASE } from '../config.js';
import {
  expectStatus,
  holdingLock,
  startTenancyHarness,
  waitForBlockedBy,
  type TenancyHarness,
} from './tenancy-test-harness.js';

interface Writer {
  agentId: string;
  token: string;
  ownerMemberId: string;
}

let h: TenancyHarness;
let communityId = '';
let channelId = '';
let writers: Writer[] = [];

beforeAll(async () => {
  h = await startTenancyHarness('postconcurrency', {
    env: {
      COMMUNITY_TEST_RUNTIME: 'true',
      COMMUNITY_TEST_RUNTIME_ACKNOWLEDGEMENT: COMMUNITY_TEST_RUNTIME_ACKNOWLEDGEMENT_PHRASE,
    },
  });
  const seeded = await expectStatus(
    await h.call('/api/test/load-fixture', { body: { readerCount: 0, writerCount: 12 } }),
    201,
    'seed'
  );
  const fixture = (await seeded.json()) as {
    communityId: string;
    channelId: string;
    writers: Array<{ agentId: string; token: string }>;
  };
  communityId = fixture.communityId;
  channelId = fixture.channelId;
  const owners = await h.pool.query<{ id: string; owner_member_id: string }>(
    'SELECT id,owner_member_id FROM agents WHERE id=ANY($1::uuid[])',
    [fixture.writers.map((writer) => writer.agentId)]
  );
  const ownerOf = new Map(owners.rows.map((row) => [row.id, row.owner_member_id]));
  writers = fixture.writers.map((writer) => ({
    ...writer,
    ownerMemberId: ownerOf.get(writer.agentId)!,
  }));
  // The fixture joins only the agents; join their owners too, so a post can mention them.
  await h.pool.query(
    `INSERT INTO channel_members(community_id,channel_id,member_id)
     SELECT $1,$2,member_id FROM unnest($3::uuid[]) AS t(member_id)`,
    [communityId, channelId, writers.map((writer) => writer.ownerMemberId)]
  );
}, 60_000);

afterAll(async () => {
  await h?.close();
});

function post(writer: Writer, body: Record<string, unknown> = {}): Promise<Response> {
  return h.call(`/api/v1/communities/${communityId}/channels/${channelId}/entries`, {
    bearer: writer.token,
    body: { text: `post ${randomUUID()}`, idempotencyKey: randomUUID(), ...body },
  });
}

describe('posting in one channel', () => {
  it('does not wait for another post that is still being checked', async () => {
    // Purpose: fails if a post takes the channel row FOR UPDATE again before its checks, which
    // queued every post in a busy channel behind the slowest one (DOR-2837).
    await holdingLock(
      h,
      'SELECT 1 FROM channels WHERE id=$1 FOR KEY SHARE',
      [channelId],
      async (release) => {
        const response = await post(writers[0]);
        expect(response.status).toBe(201);
        await release();
      }
    );
  });

  it('still waits for a change to the channel, and then sees it', async () => {
    // Purpose: fails if the shared lock stopped waiting for a channel change in flight, so a
    // post could land in a channel archived a moment before it committed.
    const holder = await h.pool.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT 1 FROM channels WHERE id=$1 FOR UPDATE', [channelId]);
      const pid = (await holder.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]
        .pid;
      const pending = post(writers[1]);
      await waitForBlockedBy(h, pid, 1);
      await holder.query('UPDATE channels SET archived=true WHERE id=$1', [channelId]);
      await holder.query('COMMIT');
      const response = await pending;
      expect(response.status).toBe(409);
      expect(((await response.json()) as { code: string }).code).toBe('STATE_CONFLICT');
    } finally {
      await holder.query('UPDATE channels SET archived=false WHERE id=$1', [channelId]);
      holder.release();
    }
  });

  it('lets a channel change wait for posts that are taking a number, without a deadlock', async () => {
    // Purpose: a post upgrades its shared channel lock to take its number. If a change were
    // waiting for the channel while another post held the number, and the upgrading post queued
    // behind that change, each would wait for the other until Postgres ended one with a deadlock
    // error. Postgres lets a transaction that already holds a lock on the row skip that queue,
    // which is what makes the upgrade safe; this fails if a post and a waiting change deadlock.
    const numbered = await h.pool.connect();
    const change = await h.pool.connect();
    try {
      // Another post, holding the next number and not yet committed.
      await numbered.query('BEGIN');
      await numbered.query('SELECT 1 FROM channels WHERE id=$1 FOR KEY SHARE', [channelId]);
      await numbered.query('UPDATE channels SET last_seq=last_seq+1 WHERE id=$1', [channelId]);
      const numberedPid = (await numbered.query<{ pid: number }>('SELECT pg_backend_pid() AS pid'))
        .rows[0].pid;
      // A change to the channel, waiting for that post.
      await change.query('BEGIN');
      const changing = change.query('SELECT 1 FROM channels WHERE id=$1 FOR UPDATE', [channelId]);
      await waitForBlockedBy(h, numberedPid, 1);
      // A new post: it runs its checks, then waits for the number.
      const posting = post(writers[2]);
      await waitForBlockedBy(h, numberedPid, 2);
      await numbered.query('UPDATE channels SET last_seq=last_seq-1 WHERE id=$1', [channelId]);
      await numbered.query('COMMIT');
      const response = await posting;
      expect(response.status, await response.clone().text()).toBe(201);
      await changing;
      await change.query('COMMIT');
    } finally {
      await numbered.query('ROLLBACK').catch(() => undefined);
      await change.query('ROLLBACK').catch(() => undefined);
      numbered.release();
      change.release();
    }
  });

  it('numbers posts that land at once without a gap, committing them in order', async () => {
    // Purpose: fails if two posts could take one number, skip one, or commit out of number
    // order (a reader that saw n + 1 before n would page past n for good), or if posts that
    // mention each other's owners and agents deadlock now that they run side by side.
    const before = await h.pool.query<{ last_seq: string }>(
      'SELECT last_seq FROM channels WHERE id=$1',
      [channelId]
    );
    const start = Number(before.rows[0].last_seq);
    let watching = true;
    const gaps: string[] = [];
    const watcher = (async () => {
      while (watching) {
        const seen = await h.pool.query<{ seq: string }>(
          'SELECT seq FROM entries WHERE channel_id=$1 AND seq>$2 ORDER BY seq',
          [channelId, start]
        );
        seen.rows.forEach((row, index) => {
          if (Number(row.seq) !== start + index + 1) gaps.push(seen.rows.map((r) => r.seq).join());
        });
        await new Promise((resolve) => setTimeout(resolve, 2));
      }
    })();
    const rounds = 4;
    const responses = await Promise.all(
      Array.from({ length: rounds * writers.length }, (_, n) => {
        // Writers in pairs, each mentioning the other's owner and agent at the same moment.
        const writer = writers[n % writers.length];
        const partner = writers[(n % writers.length) ^ 1];
        return post(writer, { mentions: [partner.ownerMemberId, partner.agentId] });
      })
    );
    watching = false;
    await watcher;
    const statuses = responses.map((response) => response.status);
    expect(statuses.filter((status) => status !== 201)).toEqual([]);
    const seqs = (
      await Promise.all(responses.map(async (r) => (await r.json()) as { entry: { seq: number } }))
    )
      .map((body) => body.entry.seq)
      .sort((a, b) => a - b);
    expect(seqs).toEqual(Array.from({ length: seqs.length }, (_, i) => start + i + 1));
    expect(gaps).toEqual([]);
    const mentions = await h.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM entry_mentions em JOIN entries e ON e.id=em.entry_id
       WHERE e.channel_id=$1 AND e.seq>$2`,
      [channelId, start]
    );
    expect(Number(mentions.rows[0].count)).toBe(2 * seqs.length);
  });
});
