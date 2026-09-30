/**
 * A deleted community answers `410 COMMUNITY_DELETED` on every canonical community route while
 * its content-free deletion record lasts, and a live stream ended by the deletion says
 * `deleted`. A DorkOS installation uses this to tell "the community is gone" apart from
 * "that channel is not there" (`404 NOT_FOUND`) and to purge what it mirrored.
 *
 * Tenancy is the adversarial half: one community's deletion record must never change the
 * answer for another community, for an id that never existed, or for the unqualified alias.
 *
 * Tests run in order and share one host.
 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import { Pool } from 'pg';
import {
  prepareCommunityDeletionInventory,
  sweepCommunityDeletionTombstones,
  sweepCommunityDeletions,
} from '../deletion-worker.js';
import {
  TENANCY_PASSWORD,
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

let h: TenancyHarness;
/** The first host's own community. It stays live throughout. */
let live = '';
let liveChannel = '';
let liveBearer = '';
let operator: TenancyMember;
/** The community deleted through the owner's own request and the deletion worker. */
let gone = '';
let goneChannel = '';
let goneBearer = '';
let goneOwner: TenancyMember;

const tenant = (communityId: string) => `/api/v1/communities/${communityId}`;
const NEVER_EXISTED = '5b0c4ad4-8a51-4a8e-9d53-0f6f7e2f1a11';
const DELETED_BODY = { code: 'COMMUNITY_DELETED', message: 'This community was deleted.' };

/** Every community-scoped route family a DorkOS installation calls, with its own credential. */
function routes(communityId: string, channelId: string, bearer: string, cookie: string) {
  const base = tenant(communityId);
  return [
    { label: 'connection access', path: `${base}/me/connection-access`, init: { bearer } },
    { label: 'room list', path: `${base}/channels`, init: { bearer } },
    { label: 'room history', path: `${base}/channels/${channelId}/entries`, init: { bearer } },
    { label: 'live stream open', path: `${base}/channels/${channelId}/events`, init: { bearer } },
    {
      label: 'post',
      path: `${base}/channels/${channelId}/entries`,
      init: { bearer, body: { text: 'hello', idempotencyKey: 'deleted-post' } },
    },
    { label: 'attention', path: `${base}/attention`, init: { bearer } },
    { label: 'agents', path: `${base}/agents`, init: { bearer } },
    { label: 'browser member', path: `${base}/me`, init: { cookie } },
    { label: 'community metadata', path: `${base}/community`, init: {} },
    {
      label: 'pairing start',
      path: `${base}/pairings/start`,
      init: {
        headers: { origin: '' },
        body: { installName: 'Late', challenge: 'x'.repeat(43), scopes: ['read'] },
      },
    },
  ] as const;
}

/** Drain a response so an event stream never stays open between tests. */
async function settle(response: Response): Promise<{ status: number; body: unknown }> {
  if (response.headers.get('content-type')?.includes('text/event-stream')) {
    await response.body?.cancel();
    return { status: response.status, body: '<stream>' };
  }
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

/** Walk a pending deletion to completion the way the scheduled worker does. */
async function runDeletion(pool: Pool, communityId: string): Promise<void> {
  // Fixture shortcut: skip the grace period rather than wait for it.
  await pool.query(
    `UPDATE communities SET delete_requested_at=now()-interval '8 days',
       delete_after=now()-interval '1 day' WHERE id=$1`,
    [communityId]
  );
  await pool.query(
    `UPDATE community_deletion_jobs SET delete_after=now()-interval '1 day',next_attempt_at=now()
     WHERE community_id=$1`,
    [communityId]
  );
  for (let pass = 0; pass < 20; pass++) {
    const result = await sweepCommunityDeletions(pool, h.blobStore, 100);
    expect(result.failed).toBe(0);
    if (result.completed) break;
    await pool.query('UPDATE community_deletion_jobs SET next_attempt_at=now()');
    await pool.query('UPDATE community_deletion_blob_progress SET next_attempt_at=now()');
  }
  expect((await pool.query('SELECT 1 FROM communities WHERE id=$1', [communityId])).rowCount).toBe(
    0
  );
}

/** Open an event stream and return a reader that yields named events, bounded per event. */
async function openStream(path: string, init: { cookie?: string; bearer?: string }) {
  const response = await expectStatus(await h.call(path, init), 200, `stream ${path}`);
  const reader = response.body!.getReader();
  let buffer = '';
  return {
    async next(
      timeoutMs = 5_000
    ): Promise<{ event: string; data: Record<string, unknown> } | 'ended'> {
      while (true) {
        const boundary = buffer.indexOf('\n\n');
        if (boundary >= 0) {
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const event = /^event: (.*)$/m.exec(frame)?.[1];
          const data = /^data: (.*)$/m.exec(frame)?.[1];
          if (event && data) return { event, data: JSON.parse(data) };
          continue;
        }
        let timer: ReturnType<typeof setTimeout> | undefined;
        const part = await Promise.race([
          reader.read(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error(`No event on ${path}`)), timeoutMs);
          }),
        ]).finally(() => clearTimeout(timer));
        if (part.done) return 'ended';
        buffer += new TextDecoder().decode(part.value);
      }
    },
    cancel: () => reader.cancel().catch(() => undefined),
  };
}

beforeAll(async () => {
  h = await startTenancyHarness('community_deleted');
  const host = await bootstrapHost(h, 'Operator', 'operator@deleted.test');
  operator = { cookie: host.cookie, memberId: host.memberId };
  live = host.communityId;
  liveChannel = await createChannel(h, live, operator.cookie, 'still-here');
  liveBearer = await pairInstall(h, live, operator.cookie);

  const pending = await createPendingCommunity(h, operator.cookie, 'Going Away');
  gone = pending.communityId;
  goneOwner = await claimAsNewAccount(h, pending.token, 'Gone Owner', 'gone-owner@deleted.test');
  goneChannel = await createChannel(h, gone, goneOwner.cookie, 'soon-gone');
  goneBearer = await pairInstall(h, gone, goneOwner.cookie);

  // Before deletion, every route family answers for the community (proves the paths are real).
  for (const route of routes(gone, goneChannel, goneBearer, goneOwner.cookie)) {
    const { status } = await settle(await h.call(route.path, route.init));
    expect({ route: route.label, status }).not.toMatchObject({ status: 404 });
    expect({ route: route.label, status }).not.toMatchObject({ status: 410 });
  }

  const lifecycle = await h.pool.query<{ lifecycle_version: number }>(
    'SELECT lifecycle_version FROM communities WHERE id=$1',
    [gone]
  );
  await expectStatus(
    await h.call(`${tenant(gone)}/owner/deletion`, {
      cookie: goneOwner.cookie,
      body: {
        lifecycleVersion: lifecycle.rows[0].lifecycle_version,
        password: TENANCY_PASSWORD,
        confirmName: 'Going Away',
        confirmIdSuffix: gone.slice(-8),
      },
    }),
    200,
    'request deletion'
  );
  await runDeletion(h.pool, gone);
}, 90_000);

afterAll(async () => {
  await h?.close();
});

it('answers 410 COMMUNITY_DELETED on every community route family of a deleted community', async () => {
  // Purpose: fails if any route family DorkOS calls still answers 404 (or anything else) for a
  // community whose deletion finished, which is the ambiguity this contract removes.
  const answers = [];
  for (const route of routes(gone, goneChannel, goneBearer, goneOwner.cookie)) {
    answers.push({ route: route.label, ...(await settle(await h.call(route.path, route.init))) });
  }
  expect(answers).toEqual(
    routes(gone, goneChannel, goneBearer, goneOwner.cookie).map((route) => ({
      route: route.label,
      status: 410,
      body: DELETED_BODY,
    }))
  );
});

it('says nothing about the deleted community beyond the fact of its deletion', async () => {
  // Purpose: fails if the 410 leaks the community's name, id, dates, or who asked for deletion.
  const response = await h.call(`${tenant(gone)}/community`);
  const text = await response.text();
  expect(response.status).toBe(410);
  expect(JSON.parse(text)).toEqual(DELETED_BODY);
  for (const secret of ['Going Away', gone, 'owner', 'host', '20']) {
    expect(text).not.toContain(secret);
  }
});

it('keeps every other community and unknown id on its own answer (tenancy)', async () => {
  // Purpose: fails if one community's deletion record changes the answer for another
  // community, for an id that never existed, or for the single-community alias.
  const liveAnswers = [];
  for (const route of routes(live, liveChannel, liveBearer, operator.cookie)) {
    if (route.label === 'pairing start' || route.label === 'post') continue;
    const { status } = await settle(await h.call(route.path, route.init));
    liveAnswers.push({ route: route.label, status });
  }
  expect(liveAnswers).toEqual(liveAnswers.map((answer) => ({ ...answer, status: 200 })));

  // The deleted community's own bearer sent to the live community is simply not a grant there.
  const crossed = await h.call(`${tenant(live)}/me/connection-access`, { bearer: goneBearer });
  expect(crossed.status).toBe(401);

  for (const path of [
    `${tenant(NEVER_EXISTED)}/community`,
    `${tenant(NEVER_EXISTED)}/me/connection-access`,
    `${tenant(NEVER_EXISTED)}/channels`,
  ]) {
    const response = await h.call(path, { bearer: goneBearer });
    expect({ path, status: response.status, body: await response.json() }).toMatchObject({
      status: 404,
      body: { code: 'NOT_FOUND' },
    });
  }
  // The deleted community's channel id under the live community is an unknown channel.
  const channel = await h.call(`${tenant(live)}/channels/${goneChannel}/entries`, {
    bearer: liveBearer,
  });
  expect(channel.status).toBe(404);
  expect(await channel.json()).toMatchObject({ code: 'NOT_FOUND' });
  // With one community left, the unqualified alias resolves to it, never to the record.
  const alias = await h.call('/api/v1/community', { cookie: operator.cookie });
  expect(alias.status).toBe(200);
  expect((await alias.json()).id).toBe(live);
});

it('answers 404 again once the deletion record expires, swept or not', async () => {
  // Purpose: fails if an expired record still answers 410, which would keep a deleted id
  // distinguishable beyond the 30 days the record promises.
  await h.pool.query(
    `UPDATE community_deletion_tombstones SET requested_at=now()-interval '32 days',
       completed_at=now()-interval '31 days',expires_at=now()-interval '1 day'
     WHERE community_id=$1`,
    [gone]
  );
  const expired = await h.call(`${tenant(gone)}/me/connection-access`, { bearer: goneBearer });
  expect(expired.status).toBe(404);
  expect(await expired.json()).toMatchObject({ code: 'NOT_FOUND' });
  expect(await sweepCommunityDeletionTombstones(h.pool)).toBe(1);
  const swept = await h.call(`${tenant(gone)}/channels`, { bearer: goneBearer });
  expect(swept.status).toBe(404);
});

it('closes a live stream as deleted when the community is deleted under it', async () => {
  // Purpose: fails if a stream that outlives its community closes as `removed`, the reason a
  // pending deletion, suspension or lost access already uses.
  const pending = await createPendingCommunity(h, operator.cookie, 'Vanishing');
  const communityId = pending.communityId;
  const owner = await claimAsNewAccount(h, pending.token, 'Vanish Owner', 'vanish@deleted.test');
  const channelId = await createChannel(h, communityId, owner.cookie, 'vanishing');
  const stream = await openStream(`${tenant(communityId)}/channels/${channelId}/events`, {
    cookie: owner.cookie,
  });
  // A second pool for the worker, so the server's own pool (whose access checks block below)
  // cannot starve the deletion of connections.
  const side = new Pool({ connectionString: h.config.databaseUrl, max: 4 });
  const lock = await side.connect();
  try {
    expect(await stream.next()).toMatchObject({ event: 'snapshot' });
    expect(await stream.next()).toMatchObject({ event: 'replay_complete' });
    // A deletion normally passes through `deletion_pending`, which ends a stream as `removed`
    // within a poll. Freeze the stream's access checks (a cookie stream reads the session
    // table, which the deletion never touches) so the whole deletion lands between two polls.
    await lock.query('BEGIN');
    await lock.query('LOCK TABLE "session" IN ACCESS EXCLUSIVE MODE');
    expect(await prepareCommunityDeletionInventory(side, h.blobStore, communityId)).toBe(true);
    // The same writes `POST /owner/deletion` makes; the route itself would wait on the lock.
    const updated = await side.query<{ lifecycle_version: number }>(
      `UPDATE communities SET lifecycle='deletion_pending',deletion_from_state=lifecycle,
         delete_requested_at=now(),delete_after=now()+interval '7 days',delete_requested_by=$2,
         lifecycle_version=lifecycle_version+1
       WHERE id=$1 RETURNING lifecycle_version`,
      [communityId, owner.memberId]
    );
    await side.query(
      `INSERT INTO community_deletion_jobs(
         community_id,requested_by_member_id,lifecycle_version,delete_after,next_attempt_at
       ) VALUES($1,$2,$3,now()+interval '7 days',now()+interval '7 days')`,
      [communityId, owner.memberId, updated.rows[0].lifecycle_version]
    );
    await runDeletion(side, communityId);
    await lock.query('COMMIT');
    expect(await stream.next()).toMatchObject({ event: 'closed', data: { reason: 'deleted' } });
    expect(await stream.next()).toBe('ended');
  } finally {
    await lock.query('ROLLBACK').catch(() => undefined);
    lock.release();
    await side.end();
    await stream.cancel();
  }
}, 60_000);
