/**
 * Two-community isolation rows of the adversarial matrix (spec
 * `community-tenancy-contract`, task 4.1) that no other fixture proves on its
 * own: API mentions across tenants, tenant-bound approvals and redemptions
 * under concurrency, per-tenant idempotency keys, removal that ends only one
 * tenant's streams and credentials, role and ownership changes that stay in
 * one tenant, and a host operator with no membership at all.
 *
 * Tests run in order and share one host. Every burst uses `Promise.all` over
 * real HTTP; assertions hold under any interleaving.
 */
import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  TENANCY_PASSWORD,
  admit,
  bootstrapHost,
  claimAsNewAccount,
  createChannel,
  createPendingCommunity,
  expectStatus,
  holdingLock,
  pairInstall,
  startTenancyHarness,
  type TenancyHarness,
  type TenancyMember,
  waitForLockWaiters,
} from './tenancy-test-harness.js';
import { hashSecret } from '../security.js';
import { responseCookies } from './bootstrap-test-helper.js';

let h: TenancyHarness;
let a = '';
let b = '';
/** First-install account: host operator and, until the ownership test, owner of A. */
let operator: TenancyMember;
let bOwner: TenancyMember;
/** Belongs to both A and B. */
let sharedInA: TenancyMember;
let sharedInB: TenancyMember;
/** Belongs to both A and B, and is removed from A. */
let leaverInA: TenancyMember;
let leaverInB: TenancyMember;
let channelA = '';
let channelB = '';

const tenant = (communityId: string) => `/api/v1/communities/${communityId}`;

function post(communityId: string, channelId: string, cookie: string, body: object) {
  return h.call(`${tenant(communityId)}/channels/${channelId}/entries`, { cookie, body });
}

async function count(sql: string, params: unknown[] = []): Promise<number> {
  return (
    await h.pool.query<{ count: number }>(`SELECT count(*)::int AS count FROM (${sql}) t`, params)
  ).rows[0].count;
}

/** Open an event stream and return a reader that yields event names, bounded per event. */
async function openStream(path: string, init: { cookie?: string; bearer?: string }) {
  const response = await expectStatus(await h.call(path, init), 200, `stream ${path}`);
  const reader = response.body!.getReader();
  let buffer = '';
  return {
    async next(): Promise<{ event: string; data: Record<string, unknown> } | 'ended'> {
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
            timer = setTimeout(() => reject(new Error(`No event on ${path}`)), 5_000);
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
  h = await startTenancyHarness('tenancy_isolation');
  const host = await bootstrapHost(h, 'Operator', 'operator@isolation.test');
  operator = { cookie: host.cookie, memberId: host.memberId };
  a = host.communityId;
  const pending = await createPendingCommunity(h, operator.cookie, 'Tenant B');
  b = pending.communityId;
  bOwner = await claimAsNewAccount(h, pending.token, 'B Owner', 'b-owner@isolation.test');
  sharedInA = await admit(h, a, operator.cookie, {
    name: 'Shared',
    email: 'shared@isolation.test',
  });
  sharedInB = await admit(h, b, bOwner.cookie, { cookie: sharedInA.cookie });
  leaverInA = await admit(h, a, operator.cookie, {
    name: 'Leaver',
    email: 'leaver@isolation.test',
  });
  leaverInB = await admit(h, b, bOwner.cookie, { cookie: leaverInA.cookie });
  channelA = await createChannel(h, a, operator.cookie, 'iso-a', [
    sharedInA.cookie,
    leaverInA.cookie,
  ]);
  channelB = await createChannel(h, b, bOwner.cookie, 'iso-b', [
    sharedInB.cookie,
    leaverInB.cookie,
  ]);
}, 60_000);

afterAll(async () => {
  await h?.close();
});

it('refuses an A post that mentions a B person or a B agent, and writes nothing', async () => {
  const bGrant = await pairInstall(h, b, bOwner.cookie);
  const enrolled = await expectStatus(
    await h.call(`${tenant(b)}/agents`, {
      bearer: bGrant,
      body: { localAgentId: 'b-agent', displayName: 'B Agent' },
    }),
    201,
    'enroll B agent'
  );
  const bAgent = (await enrolled.json()).agent.memberId as string;
  await expectStatus(
    await h.call(`${tenant(b)}/channels/${channelB}/agents`, {
      cookie: bOwner.cookie,
      body: { agentId: bAgent },
    }),
    200,
    'B agent joins B channel'
  );
  const handles = await h.pool.query<{ handle: string }>('SELECT handle FROM members WHERE id=$1', [
    bOwner.memberId,
  ]);
  const entriesBefore = await count('SELECT 1 FROM entries WHERE community_id=$1', [a]);

  // Positive control: the same shapes succeed inside B.
  const inB = await post(b, channelB, sharedInB.cookie, {
    text: 'mentions inside B',
    idempotencyKey: 'mention-control',
    mentions: [bOwner.memberId, bAgent],
  });
  expect(inB.status).toBe(201);
  expect((await inB.json()).entry.mentions).toEqual([bOwner.memberId, bAgent]);

  const [human, agent, mixed] = await Promise.all(
    [[bOwner.memberId], [bAgent], [sharedInA.memberId, bAgent]].map((mentions, index) =>
      post(a, channelA, sharedInA.cookie, {
        text: `cross mention ${index}`,
        idempotencyKey: `cross-mention-${index}`,
        mentions,
      })
    )
  );
  expect([human.status, agent.status, mixed.status]).toEqual([404, 404, 404]);
  // A B handle typed in A text resolves to nobody in A.
  const typed = await post(a, channelA, sharedInA.cookie, {
    text: `hello @${handles.rows[0].handle}`,
    idempotencyKey: 'typed-b-handle',
  });
  expect(typed.status).toBe(201);
  const typedEntry = (await typed.json()).entry;
  expect(typedEntry.mentions).toEqual([]);
  // Below the API, the schema itself refuses both cross-tenant mention targets.
  for (const [column, target] of [
    ['mentioned_member_id', bOwner.memberId],
    ['mentioned_agent_id', bAgent],
  ] as const) {
    await expect(
      h.pool.query(
        `INSERT INTO entry_mentions(entry_id,position,community_id,${column}) VALUES($1,1,$2,$3)`,
        [typedEntry.id, a, target]
      ),
      column
    ).rejects.toMatchObject({ code: '23503' });
  }
  expect(await count('SELECT 1 FROM entries WHERE community_id=$1', [a])).toBe(entriesBefore + 1);
  expect(
    await count(
      `SELECT 1 FROM entry_mentions WHERE community_id=$1
       AND (mentioned_member_id=ANY($2::uuid[]) OR mentioned_agent_id=ANY($2::uuid[]))`,
      [a, [bOwner.memberId, bAgent]]
    )
  ).toBe(0);
});

it('lands pairing approvals, invite redemptions, and reused idempotency keys sent through both tenants only in their own tenant', async () => {
  // One pairing started for B; the shared account approves it through both paths
  // together. The A path fails its tenant-qualified lookup whatever the order.
  const verifier = 'v'.repeat(43);
  const started = await expectStatus(
    await h.call(`${tenant(b)}/pairings/start`, {
      headers: { origin: '' },
      body: {
        installName: 'Race install',
        challenge: createHash('sha256').update(verifier).digest('base64url'),
        scopes: ['read'],
      },
    }),
    201,
    'start B pairing'
  );
  const { pairingId } = await started.json();
  const approvals = await Promise.all(
    [
      [a, sharedInA.cookie],
      [b, sharedInB.cookie],
    ].map(([communityId, cookie]) =>
      h.call(`${tenant(communityId)}/pairings/approve`, { cookie, body: { pairingId } })
    )
  );
  // The A path answers exactly as it does for a pairing that exists nowhere.
  const unknown = await h.call(`${tenant(a)}/pairings/approve`, {
    cookie: sharedInA.cookie,
    body: { pairingId: randomUUID() },
  });
  expect(approvals[1].status).toBe(200);
  expect([approvals[0].status, await approvals[0].json()]).toEqual([
    unknown.status,
    await unknown.json(),
  ]);
  expect(
    (
      await h.pool.query('SELECT community_id, member_id FROM connection_pairings WHERE id=$1', [
        pairingId,
      ])
    ).rows
  ).toEqual([{ community_id: b, member_id: sharedInB.memberId }]);

  // One B invitation; a new account binds and redeems it through both paths together.
  const issued = await expectStatus(
    await h.call(`${tenant(b)}/invites`, { cookie: bOwner.cookie, body: { seats: 1 } }),
    201,
    'B invite'
  );
  const { token } = await issued.json();
  const preflight = await expectStatus(
    await h.call(`${tenant(b)}/invites/preflight`, { body: { token } }),
    200,
    'B preflight'
  );
  const admission = responseCookies(preflight);
  const signup = await expectStatus(
    await h.call('/api/auth/sign-up/email', {
      cookie: admission,
      body: { name: 'Racer', email: 'racer@isolation.test', password: TENANCY_PASSWORD },
    }),
    200,
    'racer sign-up'
  );
  const racer = `${admission}; ${responseCookies(signup)}`;
  const binds = await Promise.all(
    [a, b].map((communityId) =>
      h.call(`${tenant(communityId)}/invites/bind`, { cookie: racer, body: {} })
    )
  );
  expect(binds.map((response) => response.status)).toEqual([403, 200]);
  const redemptions = await Promise.all(
    [a, b].map((communityId) =>
      h.call(`${tenant(communityId)}/invites/redeem`, { cookie: racer, body: {} })
    )
  );
  expect(redemptions.map((response) => response.status)).toEqual([403, 200]);
  expect(
    (
      await h.pool.query(
        `SELECT m.community_id FROM members m JOIN "user" u ON u.id=m.user_id
         WHERE u.email='racer@isolation.test'`
      )
    ).rows
  ).toEqual([{ community_id: b }]);

  // The same idempotency key, used in both tenants, is two independent posts.
  const first = await Promise.all([
    post(a, channelA, sharedInA.cookie, { text: 'key in A', idempotencyKey: 'shared-key' }),
    post(b, channelB, sharedInB.cookie, { text: 'key in B', idempotencyKey: 'shared-key' }),
  ]);
  expect(first.map((response) => response.status)).toEqual([201, 201]);
  const replays = await Promise.all([
    post(a, channelA, sharedInA.cookie, { text: 'key in A', idempotencyKey: 'shared-key' }),
    post(b, channelB, sharedInB.cookie, { text: 'key in B', idempotencyKey: 'shared-key' }),
  ]);
  expect(replays.map((response) => response.status)).toEqual([200, 200]);
  const [firstA, firstB, replayA, replayB] = await Promise.all(
    [...first, ...replays].map((response) => response.json())
  );
  expect(replayA.entry.id).toBe(firstA.entry.id);
  expect(replayB.entry.id).toBe(firstB.entry.id);
  expect(firstA.entry.id).not.toBe(firstB.entry.id);
  expect([firstA.entry.text, firstB.entry.text]).toEqual(['key in A', 'key in B']);
});

it('ends only A streams and credentials when a member is removed from A', async () => {
  const aGrant = await pairInstall(h, a, leaverInA.cookie, ['read', 'post']);
  const bGrant = await pairInstall(h, b, leaverInB.cookie, ['read', 'post']);
  const streams = {
    aCookie: await openStream(`${tenant(a)}/channels/${channelA}/events`, {
      cookie: leaverInA.cookie,
    }),
    aGrant: await openStream(`${tenant(a)}/channels/${channelA}/events`, { bearer: aGrant }),
    bCookie: await openStream(`${tenant(b)}/channels/${channelB}/events`, {
      cookie: leaverInB.cookie,
    }),
    bGrant: await openStream(`${tenant(b)}/channels/${channelB}/events`, { bearer: bGrant }),
  };
  try {
    for (const stream of Object.values(streams)) {
      expect(await stream.next()).toMatchObject({ event: 'snapshot' });
      expect(await stream.next()).toMatchObject({ event: 'replay_complete' });
    }
    await expectStatus(
      await h.call(`${tenant(a)}/members/${leaverInA.memberId}`, {
        method: 'DELETE',
        cookie: operator.cookie,
      }),
      204,
      'remove from A'
    );
    // Observed, not inferred: both A streams announce the removal and end.
    for (const stream of [streams.aCookie, streams.aGrant]) {
      expect(await stream.next()).toMatchObject({ event: 'closed', data: { reason: 'removed' } });
      expect(await stream.next()).toBe('ended');
    }
    // B streams still deliver the next B entry to the same account.
    await expectStatus(
      await post(b, channelB, bOwner.cookie, { text: 'after A removal', idempotencyKey: 'after' }),
      201,
      'B post after removal'
    );
    for (const stream of [streams.bCookie, streams.bGrant]) {
      expect(await stream.next()).toMatchObject({
        event: 'entry',
        data: { entry: { text: 'after A removal' } },
      });
    }
  } finally {
    await Promise.all(Object.values(streams).map((stream) => stream.cancel()));
  }
  // Credentials: the A grant is revoked, the B grant and the host session work.
  expect((await h.call(`${tenant(a)}/me/connection-access`, { bearer: aGrant })).status).toBe(401);
  // Revoked at rest too, not only unusable because the membership ended.
  const grants = await h.pool.query<{ community_id: string; revoked: boolean }>(
    `SELECT community_id, revoked_at IS NOT NULL AS revoked FROM connection_grants
     WHERE member_id=ANY($1::uuid[]) ORDER BY community_id=$2 DESC`,
    [[leaverInA.memberId, leaverInB.memberId], a]
  );
  expect(grants.rows).toEqual([
    { community_id: a, revoked: true },
    { community_id: b, revoked: false },
  ]);
  expect((await h.call(`${tenant(b)}/me/connection-access`, { bearer: bGrant })).status).toBe(200);
  expect((await h.call(`${tenant(a)}/me`, { cookie: leaverInA.cookie })).status).toBe(403);
  expect((await h.call(`${tenant(b)}/me`, { cookie: leaverInB.cookie })).status).toBe(200);
  const memberships = await expectStatus(
    await h.call('/api/v1/memberships', { cookie: leaverInB.cookie }),
    200,
    'memberships'
  );
  expect(
    (await memberships.json()).memberships.map((row: { communityId: string }) => row.communityId)
  ).toEqual([b]);
});

it('keeps role and ownership changes in A out of B, even when both tenants transfer at once', async () => {
  await expectStatus(
    await h.call(`${tenant(a)}/members/${sharedInA.memberId}/role`, {
      method: 'PATCH',
      cookie: operator.cookie,
      body: { role: 'admin' },
    }),
    200,
    'promote in A'
  );
  const version = async (communityId: string) =>
    (
      await h.pool.query<{ lifecycle_version: number }>(
        'SELECT lifecycle_version FROM communities WHERE id=$1',
        [communityId]
      )
    ).rows[0].lifecycle_version;
  // A passes to the shared account while B passes to the account removed from A.
  const versions = { a: await version(a), b: await version(b) };
  // Hold both community rows so the two transfers are provably in flight
  // together, each waiting on its own tenant's row, before either proceeds.
  const transfers = await holdingLock(
    h,
    'SELECT id FROM communities WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE',
    [[a, b]],
    async (release) => {
      const pending = Promise.all([
        h.call(`${tenant(a)}/owner/transfer`, {
          cookie: operator.cookie,
          body: {
            successorMemberId: sharedInA.memberId,
            password: TENANCY_PASSWORD,
            lifecycleVersion: versions.a,
          },
        }),
        h.call(`${tenant(b)}/owner/transfer`, {
          cookie: bOwner.cookie,
          body: {
            successorMemberId: leaverInB.memberId,
            password: TENANCY_PASSWORD,
            lifecycleVersion: versions.b,
          },
        }),
      ]);
      await waitForLockWaiters(h, 2, 'FROM communities WHERE id=$1 FOR UPDATE');
      await release();
      return pending;
    }
  );
  expect(transfers.map((response) => response.status)).toEqual([200, 200]);
  const roles = await h.pool.query<{ id: string; role: string; active: boolean }>(
    'SELECT id, role, active FROM members WHERE id=ANY($1::uuid[])',
    [
      [
        operator.memberId,
        bOwner.memberId,
        sharedInA.memberId,
        sharedInB.memberId,
        leaverInA.memberId,
        leaverInB.memberId,
      ],
    ]
  );
  const byId = Object.fromEntries(roles.rows.map((row) => [row.id, [row.role, row.active]]));
  expect(byId).toEqual({
    [operator.memberId]: ['member', true],
    [sharedInA.memberId]: ['owner', true],
    // The same account's B membership kept its own role through the A promotion and transfer.
    [sharedInB.memberId]: ['member', true],
    [bOwner.memberId]: ['member', true],
    [leaverInB.memberId]: ['owner', true],
    // Owning B did not revive the ended A membership.
    [leaverInA.memberId]: ['member', false],
  });
  // Authority follows the path: the new A owner cannot administer B.
  expect(
    (await h.call(`${tenant(a)}/invites`, { cookie: sharedInA.cookie, body: { seats: 1 } })).status
  ).toBe(201);
  expect(
    (await h.call(`${tenant(b)}/invites`, { cookie: sharedInB.cookie, body: { seats: 1 } })).status
  ).toBe(403);
  expect(
    await count(
      "SELECT 1 FROM members WHERE role='owner' AND active AND community_id=ANY($1::uuid[]) GROUP BY community_id HAVING count(*)=1",
      [[a, b]]
    )
  ).toBe(2);
});

it('gives a host operator with no membership host metadata, but no content in either community', async () => {
  // After the transfer above the operator is an ordinary A member; leaving
  // leaves a host operator with no membership anywhere.
  await expectStatus(
    await h.call(`${tenant(a)}/me/leave`, {
      cookie: operator.cookie,
      body: { password: TENANCY_PASSWORD, communityName: 'Operator Community' },
    }),
    204,
    'operator leaves A'
  );
  expect(
    await count(
      'SELECT 1 FROM members m JOIN members o ON o.user_id=m.user_id WHERE o.id=$1 AND m.active',
      [operator.memberId]
    )
  ).toBe(0);
  const memberships = await expectStatus(
    await h.call('/api/v1/memberships', { cookie: operator.cookie }),
    200,
    'memberships'
  );
  expect((await memberships.json()).memberships).toEqual([]);

  // Host authority remains: metadata for both, and creating a pending community.
  const listed = await expectStatus(
    await h.call('/api/v1/host/communities', { cookie: operator.cookie }),
    200,
    'host list'
  );
  const listing = JSON.stringify(await listed.json());
  expect(listing).toContain(a);
  expect(listing).toContain(b);
  // Metadata only: no channel, entry, or member content leaks into the listing.
  for (const secret of ['iso-a', 'iso-b', 'key in A', 'key in B', 'Shared']) {
    expect(listing).not.toContain(secret);
  }
  await createPendingCommunity(h, operator.cookie, 'Operator pending');

  // Content in both tenants stays closed.
  const attachmentUpload = await expectStatus(
    await h.call(`${tenant(b)}/channels/${channelB}/attachments`, {
      method: 'POST',
      cookie: sharedInB.cookie,
      headers: {
        'content-type': 'text/plain',
        'x-file-name': 'b.txt',
        'x-file-size': '1',
        'idempotency-key': 'b-file',
      },
      raw: 'b',
    }),
    201,
    'B upload'
  );
  const bAttachment = (await attachmentUpload.json()).attachment.id;
  for (const [communityId, channelId, attachment] of [
    [a, channelA, null],
    [b, channelB, bAttachment],
  ] as const) {
    const paths = [
      '/me',
      '/channels',
      `/channels/${channelId}`,
      `/channels/${channelId}/entries`,
      `/channels/${channelId}/members`,
      `/channels/${channelId}/events`,
      '/members',
      '/invites',
      '/agents',
      '/settings',
      ...(attachment ? [`/attachments/${attachment}`] : []),
    ];
    for (const path of paths) {
      const response = await h.call(`${tenant(communityId)}${path}`, { cookie: operator.cookie });
      expect(response.status, `${communityId === a ? 'A' : 'B'} ${path}`).toBe(403);
    }
    for (const [path, body] of [
      [`/channels/${channelId}/entries`, { text: 'operator', idempotencyKey: 'operator' }],
      ['/invites', { seats: 1 }],
      [`/channels/${channelId}/join`, {}],
      ['/me/export', {}],
    ] as const) {
      const response = await h.call(`${tenant(communityId)}${path}`, {
        cookie: operator.cookie,
        body,
      });
      expect(response.status, `${communityId === a ? 'A' : 'B'} POST ${path}`).toBe(403);
    }
    // Nor can it mint an owner claim into an active tenant.
    expect(
      (
        await h.call(`/api/v1/host/communities/${communityId}/owner-claims/reissue`, {
          cookie: operator.cookie,
          body: {},
        })
      ).status
    ).toBe(409);
  }
  expect(
    await count(
      `SELECT 1 FROM entries e JOIN members m ON m.id=e.author_member_id
       JOIN members o ON o.user_id=m.user_id WHERE o.id=$1 AND e.text='operator'`,
      [operator.memberId]
    )
  ).toBe(0);

  // Suspended B: the operator may suspend it, but still cannot mint a claim into
  // it, and a claim grant planted directly in the database does not redeem.
  const lifecycle = async (communityId: string) =>
    (
      await h.pool.query<{ lifecycle_version: number }>(
        'SELECT lifecycle_version FROM communities WHERE id=$1',
        [communityId]
      )
    ).rows[0].lifecycle_version;
  await expectStatus(
    await h.call(`/api/v1/host/communities/${b}/lifecycle`, {
      method: 'PATCH',
      cookie: operator.cookie,
      body: { action: 'suspend', lifecycleVersion: await lifecycle(b) },
    }),
    200,
    'suspend B'
  );
  expect(
    (
      await h.call(`/api/v1/host/communities/${b}/owner-claims/reissue`, {
        cookie: operator.cookie,
        body: {},
      })
    ).status
  ).toBe(409);
  const planted = randomUUID() + randomUUID();
  await h.pool.query(
    `INSERT INTO bootstrap_grants(token_hash,purpose,community_id,expires_at)
     VALUES($1,'owner_claim',$2,now()+interval '10 minutes')`,
    [hashSecret(planted), b]
  );
  expect(
    (await h.call('/api/v1/owner-claims/preflight', { body: { token: planted } })).status
  ).toBe(403);
  const ownersOfB = await count(
    "SELECT 1 FROM members WHERE community_id=$1 AND role='owner' AND active",
    [b]
  );
  expect(ownersOfB).toBe(1);
  await expectStatus(
    await h.call(`/api/v1/host/communities/${b}/lifecycle`, {
      method: 'PATCH',
      cookie: operator.cookie,
      body: { action: 'resume', lifecycleVersion: await lifecycle(b) },
    }),
    200,
    'resume B'
  );
  expect((await h.call(`${tenant(b)}/me`, { cookie: operator.cookie })).status).toBe(403);
});
