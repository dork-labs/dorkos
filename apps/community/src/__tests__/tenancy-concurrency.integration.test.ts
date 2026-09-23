/**
 * Cross-tenant concurrency proof for one Community host serving several
 * communities (spec `community-tenancy-contract`, task 4.1).
 *
 * Every burst below is issued at once with `Promise.all` over real HTTP, so the
 * server's pool (several PostgreSQL clients) runs the transactions in parallel.
 * Assertions are invariants that must hold under every interleaving: no fixed
 * order is assumed, and nothing sleeps. A lock cycle surfaces as a PostgreSQL
 * deadlock error (a non-2xx status) or as a request timeout; either fails here.
 */
import { createHash, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { sweepCommunityDeletions } from '../deletion-worker.js';
import {
  TENANCY_PASSWORD,
  admit,
  bootstrapHost,
  claimAsNewAccount,
  createChannel,
  createPendingCommunity,
  expectStatus,
  holdingLock,
  preflightOwnerClaim,
  startTenancyHarness,
  type TenancyHarness,
  type TenancyMember,
  waitForLockWaiters,
} from './tenancy-test-harness.js';

let h: TenancyHarness;
/** Host operator and owner of A. */
let operator: TenancyMember;
let a = '';
let b = '';
/** Owner of B, never in A. */
let bOwner: TenancyMember;
/** One account that belongs to both A and B. */
let sharedInA: TenancyMember;
let sharedInB: TenancyMember;
/** Accounts that belong to only one community. */
let onlyA: TenancyMember;
let onlyB: TenancyMember;
let channelA = '';
let channelB = '';

const tenant = (communityId: string) => `/api/v1/communities/${communityId}`;

function post(communityId: string, channelId: string, cookie: string, text: string) {
  return h.call(`${tenant(communityId)}/channels/${channelId}/entries`, {
    cookie,
    body: { text, idempotencyKey: text },
  });
}

/** Rows that would prove a relation crossed a tenant boundary. Must stay empty. */
async function crossTenantRows(): Promise<unknown[]> {
  const { rows } = await h.pool.query(
    `SELECT 'entry' AS kind, e.id::text AS id FROM entries e
       JOIN channels c ON c.id=e.channel_id
       LEFT JOIN members m ON m.id=e.author_member_id
       LEFT JOIN agents ag ON ag.id=e.author_agent_id
     WHERE c.community_id<>e.community_id
        OR m.community_id<>e.community_id
        OR ag.community_id<>e.community_id
     UNION ALL
     SELECT 'invite', i.id::text FROM invites i JOIN members m ON m.id=i.issuer_member_id
     WHERE m.community_id<>i.community_id
     UNION ALL
     SELECT 'cursor', r.channel_id::text FROM read_cursors r
       JOIN channels c ON c.id=r.channel_id JOIN members m ON m.id=r.member_id
     WHERE c.community_id<>r.community_id OR m.community_id<>r.community_id
     UNION ALL
     SELECT 'channel_member', cm.channel_id::text FROM channel_members cm
       JOIN channels c ON c.id=cm.channel_id JOIN members m ON m.id=cm.member_id
     WHERE c.community_id<>cm.community_id OR m.community_id<>cm.community_id`
  );
  return rows;
}

/** Each channel's committed sequence must be exactly 1..n and match its counter. */
async function sequenceReport(channelIds: string[]) {
  const { rows } = await h.pool.query<{
    channel_id: string;
    community_id: string;
    seqs: string[];
    last_seq: string;
  }>(
    `SELECT c.id AS channel_id, c.community_id, c.last_seq,
            coalesce(array_agg(e.seq ORDER BY e.seq) FILTER (WHERE e.id IS NOT NULL), '{}') AS seqs
     FROM channels c LEFT JOIN entries e ON e.channel_id=c.id
     WHERE c.id=ANY($1::uuid[]) GROUP BY c.id`,
    [channelIds]
  );
  return Object.fromEntries(
    rows.map((row) => {
      const seqs = row.seqs.map(Number);
      return [
        row.channel_id,
        {
          gapFree: seqs.every((seq, index) => seq === index + 1),
          count: seqs.length,
          lastSeq: Number(row.last_seq),
        },
      ];
    })
  );
}

/** Text → authoring membership for every entry in a channel. */
async function authorsByText(channelId: string): Promise<Record<string, string>> {
  const { rows } = await h.pool.query<{ text: string; author: string }>(
    `SELECT text, coalesce(author_member_id, author_agent_id)::text AS author
     FROM entries WHERE channel_id=$1`,
    [channelId]
  );
  return Object.fromEntries(rows.map((row) => [row.text, row.author]));
}

async function deadlocks(): Promise<number> {
  const { rows } = await h.pool.query<{ deadlocks: string }>(
    'SELECT deadlocks FROM pg_stat_database WHERE datname=current_database()'
  );
  return Number(rows[0].deadlocks);
}

beforeAll(async () => {
  h = await startTenancyHarness('tenancy_concurrency');
  const host = await bootstrapHost(h, 'Operator', 'operator@concurrency.test');
  operator = { cookie: host.cookie, memberId: host.memberId };
  a = host.communityId;
  const pending = await createPendingCommunity(h, operator.cookie, 'Second tenant');
  b = pending.communityId;
  bOwner = await claimAsNewAccount(h, pending.token, 'B Owner', 'b-owner@concurrency.test');
  sharedInA = await admit(h, a, operator.cookie, {
    name: 'Shared',
    email: 'shared@concurrency.test',
  });
  sharedInB = await admit(h, b, bOwner.cookie, { cookie: sharedInA.cookie });
  onlyA = await admit(h, a, operator.cookie, { name: 'Only A', email: 'only-a@concurrency.test' });
  onlyB = await admit(h, b, bOwner.cookie, { name: 'Only B', email: 'only-b@concurrency.test' });
  channelA = await createChannel(h, a, operator.cookie, 'busy-a', [sharedInA.cookie, onlyA.cookie]);
  channelB = await createChannel(h, b, bOwner.cookie, 'busy-b', [sharedInB.cookie, onlyB.cookie]);
}, 60_000);

afterAll(async () => {
  await h?.close();
});

it('keeps concurrent posts, invites, and cursors of two communities on one host apart, each channel gap-free', async () => {
  // The shared account's two memberships hold one host session; the only thing
  // that selects which membership acts is the community in the path.
  expect(sharedInA.memberId).not.toBe(sharedInB.memberId);
  const deadlocksBefore = await deadlocks();
  const rounds = 8;
  const plan: { communityId: string; channelId: string; cookie: string; author: string }[] = [];
  for (const [communityId, channelId, writers] of [
    [a, channelA, [operator, sharedInA, onlyA]],
    [b, channelB, [bOwner, sharedInB, onlyB]],
  ] as const) {
    for (const writer of writers) {
      for (let round = 0; round < rounds; round++) {
        plan.push({ communityId, channelId, cookie: writer.cookie, author: writer.memberId });
      }
    }
  }
  const texts = plan.map(
    (step, index) => `${step.communityId === a ? 'A' : 'B'}-${index}-${step.author}`
  );
  // A cursor from each tenant, replayed into the other tenant's channel below.
  const seedA = await (
    await expectStatus(await post(a, channelA, sharedInA.cookie, 'seed-a'), 201, 'seed A')
  ).json();
  const seedB = await (
    await expectStatus(await post(b, channelB, sharedInB.cookie, 'seed-b'), 201, 'seed B')
  ).json();

  const writes = plan.map((step, index) =>
    post(step.communityId, step.channelId, step.cookie, texts[index])
  );
  const invites = [a, b].flatMap((communityId) =>
    Array.from({ length: 4 }, () =>
      h.call(`${tenant(communityId)}/invites`, {
        cookie: communityId === a ? operator.cookie : bOwner.cookie,
        body: { seats: 1 },
      })
    )
  );
  const cursors = [
    h.call(`${tenant(a)}/channels/${channelA}/read-cursor`, {
      method: 'PUT',
      cookie: sharedInA.cookie,
      body: { cursor: seedA.cursor },
    }),
    h.call(`${tenant(b)}/channels/${channelB}/read-cursor`, {
      method: 'PUT',
      cookie: sharedInB.cookie,
      body: { cursor: seedB.cursor },
    }),
  ];
  // Hostile requests racing the legitimate ones: a foreign channel under each
  // tenant's path, a foreign cursor, and a single-tenant account on the other path.
  const hostile = [
    post(a, channelB, sharedInA.cookie, 'cross-A-path-B-channel'),
    post(b, channelA, sharedInB.cookie, 'cross-B-path-A-channel'),
    post(b, channelB, onlyA.cookie, 'cross-only-A-in-B'),
    post(a, channelA, onlyB.cookie, 'cross-only-B-in-A'),
    h.call(`${tenant(b)}/channels/${channelB}/read-cursor`, {
      method: 'PUT',
      cookie: sharedInB.cookie,
      body: { cursor: seedA.cursor },
    }),
    h.call(`${tenant(a)}/invites`, { cookie: bOwner.cookie, body: { seats: 1 } }),
  ];

  const [writeResults, inviteResults, cursorResults, hostileResults] = await Promise.all([
    Promise.all(writes),
    Promise.all(invites),
    Promise.all(cursors),
    Promise.all(hostile),
  ]);

  expect(writeResults.map((response) => response.status)).toEqual(plan.map(() => 201));
  expect(inviteResults.map((response) => response.status)).toEqual(invites.map(() => 201));
  expect(cursorResults.map((response) => response.status)).toEqual([200, 200]);
  // 404 hides a foreign channel; 403 refuses an account with no membership on
  // that path; a cursor minted in A is stale anywhere in B.
  expect(hostileResults.map((response) => response.status)).toEqual([404, 404, 403, 403, 410, 403]);
  expect(await hostileResults[4].json()).toMatchObject({ code: 'CURSOR_STALE' });

  // Each response names the tenant's own channel and the author's own membership.
  const bodies = await Promise.all(writeResults.map((response) => response.json()));
  bodies.forEach((body, index) => {
    expect(body.entry.channelId).toBe(plan[index].channelId);
    expect(body.entry.authorMemberId).toBe(plan[index].author);
  });

  // Committed rows agree: every text landed once, in the channel it was sent to,
  // under the membership of that same community, and nowhere else.
  const committedA = await authorsByText(channelA);
  const committedB = await authorsByText(channelB);
  const expectedFor = (communityId: string) =>
    Object.fromEntries([
      ...plan.flatMap((step, index) =>
        step.communityId === communityId ? [[texts[index], step.author]] : []
      ),
      communityId === a ? ['seed-a', sharedInA.memberId] : ['seed-b', sharedInB.memberId],
    ]);
  expect(committedA).toEqual(expectedFor(a));
  expect(committedB).toEqual(expectedFor(b));

  // Sequence is per channel: B's burst never advanced A's counter, and neither
  // counter skipped or duplicated a value.
  const perTenantWrites = plan.length / 2 + 1;
  expect(await sequenceReport([channelA, channelB])).toEqual({
    [channelA]: { gapFree: true, count: perTenantWrites, lastSeq: perTenantWrites },
    [channelB]: { gapFree: true, count: perTenantWrites, lastSeq: perTenantWrites },
  });
  // Every invite belongs to the community whose path created it.
  const inviteCounts = await h.pool.query<{ community_id: string; count: number }>(
    `SELECT community_id, count(*)::int AS count FROM invites
     WHERE created_at > now() - interval '5 minutes' GROUP BY community_id`
  );
  const counts = Object.fromEntries(inviteCounts.rows.map((row) => [row.community_id, row.count]));
  // The fixture's own admissions issued 2 invites in each tenant before this burst.
  expect(counts).toEqual({ [a]: 4 + 2, [b]: 4 + 2 });
  // The foreign cursor replay changed nothing; each tenant's cursor points at its own seed.
  const cursorRows = await h.pool.query<{ community_id: string; channel_id: string }>(
    'SELECT community_id, channel_id FROM read_cursors WHERE member_id=ANY($1::uuid[])',
    [[sharedInA.memberId, sharedInB.memberId]]
  );
  expect(cursorRows.rows).toEqual(
    expect.arrayContaining([
      { community_id: a, channel_id: channelA },
      { community_id: b, channel_id: channelB },
    ])
  );
  expect(cursorRows.rows).toHaveLength(2);
  expect(await crossTenantRows()).toEqual([]);
  expect(await deadlocks()).toBe(deadlocksBefore);
}, 60_000);

it('removes the shared account from A while it keeps posting in B, without touching its host session', async () => {
  const burst = 10;
  const inB = Array.from({ length: burst }, (_, index) =>
    post(b, channelB, sharedInB.cookie, `shared-b-during-removal-${index}`)
  );
  const inA = Array.from({ length: burst }, (_, index) =>
    post(a, channelA, sharedInA.cookie, `shared-a-during-removal-${index}`)
  );
  const removal = h.call(`${tenant(a)}/members/${sharedInA.memberId}`, {
    method: 'DELETE',
    cookie: operator.cookie,
  });
  const [bResults, aResults, removed] = await Promise.all([
    Promise.all(inB),
    Promise.all(inA),
    removal,
  ]);

  expect(removed.status).toBe(204);
  // B never noticed: every post committed under the B membership.
  expect(bResults.map((response) => response.status)).toEqual(inB.map(() => 201));
  // A either committed before the removal or was refused after it; never an error.
  for (const response of aResults) expect([201, 403]).toContain(response.status);
  const membership = await h.pool.query<{ community_id: string; active: boolean }>(
    'SELECT community_id, active FROM members WHERE id=ANY($1::uuid[]) ORDER BY community_id=$2',
    [[sharedInA.memberId, sharedInB.memberId], a]
  );
  expect(membership.rows).toEqual([
    { community_id: b, active: true },
    { community_id: a, active: false },
  ]);
  // The host session survives; only the A membership ended.
  expect((await h.call(`${tenant(b)}/me`, { cookie: sharedInB.cookie })).status).toBe(200);
  expect((await h.call(`${tenant(a)}/me`, { cookie: sharedInA.cookie })).status).toBe(403);
  expect(
    (await post(b, channelB, sharedInB.cookie, 'shared-b-after-removal')).status,
    'B membership still posts after A removal'
  ).toBe(201);
  expect(await sequenceReport([channelA, channelB])).toEqual({
    [channelA]: expect.objectContaining({ gapFree: true }),
    [channelB]: expect.objectContaining({ gapFree: true }),
  });
  expect(await crossTenantRows()).toEqual([]);
}, 60_000);

it('deletes a third community while A and B keep writing, and leaves their rows intact', async () => {
  const deadlocksBefore = await deadlocks();
  // C is claimed by the host operator, populated, archived, and made due for deletion.
  const pending = await createPendingCommunity(h, operator.cookie, 'Doomed tenant');
  const c = pending.communityId;
  const claimCookie = `${operator.cookie}; ${await preflightOwnerClaim(h, pending.token)}`;
  await expectStatus(
    await h.call('/api/v1/owner-claims/claim', { cookie: claimCookie, body: {} }),
    200,
    'operator claims C'
  );
  const channelC = await createChannel(h, c, operator.cookie, 'doomed');
  for (let index = 0; index < 5; index++) {
    await expectStatus(await post(c, channelC, operator.cookie, `c-${index}`), 201, 'populate C');
  }
  const upload = await h.call(`${tenant(c)}/channels/${channelC}/attachments`, {
    cookie: operator.cookie,
    headers: {
      'content-type': 'text/plain',
      'x-file-name': 'doomed.txt',
      'x-file-size': '6',
      'idempotency-key': 'doomed-file',
    },
    method: 'POST',
    raw: 'doomed',
  });
  await expectStatus(upload, 201, 'upload into C');
  const attachmentId = (await upload.json()).attachment.id;
  await expectStatus(
    await h.call(`${tenant(c)}/channels/${channelC}/entries`, {
      cookie: operator.cookie,
      body: { text: 'c-file', idempotencyKey: 'c-file', attachmentIds: [attachmentId] },
    }),
    201,
    'bind C file'
  );
  let lifecycleVersion = (
    await h.pool.query<{ lifecycle_version: number }>(
      'SELECT lifecycle_version FROM communities WHERE id=$1',
      [c]
    )
  ).rows[0].lifecycle_version;
  const archived = await expectStatus(
    await h.call(`${tenant(c)}/owner/lifecycle`, {
      cookie: operator.cookie,
      body: {
        action: 'archive',
        lifecycleVersion,
        password: TENANCY_PASSWORD,
        confirmName: 'Doomed tenant',
      },
    }),
    200,
    'archive C'
  );
  lifecycleVersion = (await archived.json()).lifecycleVersion;
  await expectStatus(
    await h.call(`${tenant(c)}/owner/deletion`, {
      cookie: operator.cookie,
      body: {
        lifecycleVersion,
        password: TENANCY_PASSWORD,
        confirmName: 'Doomed tenant',
        confirmIdSuffix: c.slice(-8),
      },
    }),
    200,
    'request C deletion'
  );
  // Fixture shortcut: skip the grace period rather than wait for it.
  await h.pool.query(
    `UPDATE communities SET delete_requested_at=now()-interval '8 days',
       delete_after=now()-interval '1 day' WHERE id=$1`,
    [c]
  );
  await h.pool.query(
    `UPDATE community_deletion_jobs SET delete_after=now()-interval '1 day',next_attempt_at=now()
     WHERE community_id=$1`,
    [c]
  );

  const before = await sequenceReport([channelA, channelB]);
  const deletion = (async () => {
    // One job; each pass is a separate transaction racing the writers below.
    for (let pass = 0; pass < 20; pass++) {
      const result = await sweepCommunityDeletions(h.pool, h.blobStore, 100);
      if (result.completed) return result;
      if (result.failed) throw new Error('Community deletion failed during concurrent writes');
      await h.pool.query('UPDATE community_deletion_jobs SET next_attempt_at=now()');
      await h.pool.query('UPDATE community_deletion_blob_progress SET next_attempt_at=now()');
    }
    throw new Error('Community deletion did not complete');
  })();
  const writers = [
    ...Array.from({ length: 12 }, (_, index) =>
      post(a, channelA, onlyA.cookie, `a-during-deletion-${index}`)
    ),
    ...Array.from({ length: 12 }, (_, index) =>
      post(b, channelB, onlyB.cookie, `b-during-deletion-${index}`)
    ),
  ];
  const [deleted, results] = await Promise.all([deletion, Promise.all(writers)]);

  expect(deleted.completed).toBe(1);
  expect(results.map((response) => response.status)).toEqual(writers.map(() => 201));
  expect(
    (await h.pool.query('SELECT 1 FROM communities WHERE id=$1', [c])).rowCount,
    'C is gone'
  ).toBe(0);
  for (const table of ['entries', 'channels', 'members', 'attachments', 'managed_blobs']) {
    const quoted = `"${table}"`;
    expect(
      (await h.pool.query(`SELECT 1 FROM ${quoted} WHERE community_id=$1`, [c])).rowCount,
      `${table} rows of C`
    ).toBe(0);
  }
  expect(await sequenceReport([channelA, channelB])).toEqual({
    [channelA]: {
      gapFree: true,
      count: before[channelA].count + 12,
      lastSeq: before[channelA].lastSeq + 12,
    },
    [channelB]: {
      gapFree: true,
      count: before[channelB].count + 12,
      lastSeq: before[channelB].lastSeq + 12,
    },
  });
  // The operator still owns A with the same session after deleting C.
  expect((await h.call(`${tenant(a)}/me`, { cookie: operator.cookie })).status).toBe(200);
  expect(await crossTenantRows()).toEqual([]);
  expect(await deadlocks()).toBe(deadlocksBefore);
}, 60_000);

it('settles racing owner claims per community while active tenants are busy and cannot be claimed', async () => {
  const deadlocksBefore = await deadlocks();
  const d = await createPendingCommunity(h, operator.cookie, 'Pending D');
  const e = await createPendingCommunity(h, operator.cookie, 'Pending E');
  // Two new accounts race for D's one claim; a third claims E alone.
  const dRacers = await Promise.all(
    ['first', 'second'].map(async (label) => {
      const grant = await preflightOwnerClaim(h, d.token);
      const signup = await expectStatus(
        await h.call('/api/auth/sign-up/email', {
          cookie: grant,
          body: {
            name: `D ${label}`,
            email: `d-${label}@concurrency.test`,
            password: TENANCY_PASSWORD,
          },
        }),
        200,
        `D ${label} sign-up`
      );
      const session = signup.headers
        .getSetCookie()
        .map((value) => value.split(';')[0])
        .join('; ');
      return `${grant}; ${session}`;
    })
  );
  const eGrant = await preflightOwnerClaim(h, e.token);
  const eSignup = await expectStatus(
    await h.call('/api/auth/sign-up/email', {
      cookie: eGrant,
      body: { name: 'E owner', email: 'e-owner@concurrency.test', password: TENANCY_PASSWORD },
    }),
    200,
    'E sign-up'
  );
  const eCookie = `${eGrant}; ${eSignup.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .join('; ')}`;

  const claim = (cookie: string) => h.call('/api/v1/owner-claims/claim', { cookie, body: {} });
  // Force D's two claimants to overlap: hold D's row until both are waiting (one
  // on the row, the other behind the claim lock), then let them go.
  const claims = await holdingLock(
    h,
    'SELECT id FROM communities WHERE id=$1 FOR UPDATE',
    [d.communityId],
    async (release) => {
      const racing = Promise.all(dRacers.map(claim));
      await waitForLockWaiters(h, 2);
      await release();
      return racing;
    }
  );
  const [eClaim, activeReissues, busy] = await Promise.all([
    claim(eCookie),
    Promise.all(
      [a, b].map((communityId) =>
        h.call(`/api/v1/host/communities/${communityId}/owner-claims/reissue`, {
          cookie: operator.cookie,
          body: {},
        })
      )
    ),
    Promise.all([
      ...Array.from({ length: 8 }, (_, index) =>
        post(a, channelA, onlyA.cookie, `a-during-claims-${index}`)
      ),
      ...Array.from({ length: 8 }, (_, index) =>
        post(b, channelB, onlyB.cookie, `b-during-claims-${index}`)
      ),
    ]),
  ]);

  expect(claims.map((response) => response.status).sort()).toEqual([200, 403]);
  expect(eClaim.status).toBe(200);
  // A host operator cannot mint a claim for an active community, even mid-burst.
  expect(activeReissues.map((response) => response.status)).toEqual([409, 409]);
  expect(busy.map((response) => response.status)).toEqual(busy.map(() => 201));

  const owners = await h.pool.query<{ community_id: string; owners: number; lifecycle: string }>(
    `SELECT c.id AS community_id, c.lifecycle,
            count(m.id) FILTER (WHERE m.role='owner' AND m.active)::int AS owners
     FROM communities c LEFT JOIN members m ON m.community_id=c.id
     WHERE c.id=ANY($1::uuid[]) GROUP BY c.id`,
    [[a, b, d.communityId, e.communityId]]
  );
  expect(Object.fromEntries(owners.rows.map((row) => [row.community_id, row]))).toEqual({
    [a]: { community_id: a, lifecycle: 'active', owners: 1 },
    [b]: { community_id: b, lifecycle: 'active', owners: 1 },
    [d.communityId]: { community_id: d.communityId, lifecycle: 'active', owners: 1 },
    [e.communityId]: { community_id: e.communityId, lifecycle: 'active', owners: 1 },
  });
  // A and B keep their original owners; D's winner owns only D, E's claimant only E.
  const ownerUsers = await h.pool.query<{ community_id: string; user_id: string }>(
    `SELECT community_id, user_id FROM members WHERE role='owner' AND active
     AND community_id=ANY($1::uuid[])`,
    [[a, b, d.communityId, e.communityId]]
  );
  const ownerOf = Object.fromEntries(ownerUsers.rows.map((row) => [row.community_id, row.user_id]));
  const userOf = async (memberId: string) =>
    (await h.pool.query('SELECT user_id FROM members WHERE id=$1', [memberId])).rows[0].user_id;
  expect(ownerOf[a]).toBe(await userOf(operator.memberId));
  expect(ownerOf[b]).toBe(await userOf(bOwner.memberId));
  expect(new Set(Object.values(ownerOf)).size).toBe(4);
  const memberships = await h.pool.query<{ user_id: string; count: number }>(
    'SELECT user_id, count(*)::int AS count FROM members WHERE user_id=ANY($1) GROUP BY user_id',
    [[ownerOf[d.communityId], ownerOf[e.communityId]]]
  );
  expect(memberships.rows.map((row) => row.count)).toEqual([1, 1]);
  expect(await sequenceReport([channelA, channelB])).toEqual({
    [channelA]: expect.objectContaining({ gapFree: true }),
    [channelB]: expect.objectContaining({ gapFree: true }),
  });
  expect(await crossTenantRows()).toEqual([]);
  expect(await deadlocks()).toBe(deadlocksBefore);
}, 60_000);

it('refuses a pairing approval whose member is removed after the request passed its membership check', async () => {
  const approver = await admit(h, a, operator.cookie, {
    name: 'Approver',
    email: 'approver@concurrency.test',
  });
  const verifier = randomBytes(32).toString('base64url');
  const started = await expectStatus(
    await h.call(`${tenant(a)}/pairings/start`, {
      headers: { origin: '' },
      body: {
        installName: 'Held approval',
        challenge: createHash('sha256').update(verifier).digest('base64url'),
        scopes: ['read'],
      },
    }),
    201,
    'start pairing'
  );
  const { pairingId } = await started.json();

  // Hold the pairing row. The approval passes its pre-transaction membership
  // check, then waits on this row inside its transaction; the member is removed
  // while it waits, and only then does the approval continue.
  const approval = await holdingLock(
    h,
    'SELECT id FROM connection_pairings WHERE id=$1 FOR UPDATE',
    [pairingId],
    async (release) => {
      const pending = h.call(`${tenant(a)}/pairings/approve`, {
        cookie: approver.cookie,
        body: { pairingId },
      });
      await waitForLockWaiters(h, 1, 'FROM connection_pairings WHERE id=$1 AND community_id=$2');
      await expectStatus(
        await h.call(`${tenant(a)}/members/${approver.memberId}`, {
          method: 'DELETE',
          cookie: operator.cookie,
        }),
        204,
        'remove the approver while its approval waits'
      );
      await release();
      return pending;
    }
  );

  expect(approval.status).toBe(403);
  expect(
    (
      await h.pool.query('SELECT member_id, approved_at FROM connection_pairings WHERE id=$1', [
        pairingId,
      ])
    ).rows
  ).toEqual([{ member_id: null, approved_at: null }]);
});
