/**
 * Holding a suspended community in one call, and the host legal hold (spec
 * `community-host-operator-api`, "Holding a suspended community" and "Legal hold"; ADR
 * `260924-215422`; DOR-2299).
 *
 * Tests run in order on one host with an injected clock. A is the operator's own community; P is
 * an unclaimed one used for abandon.
 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import { sweepCommunityDeletions } from '../deletion-worker.js';
import { runHostKeyCommand } from '../host-keys.js';
import type { BlobStore } from '../storage/index.js';
import {
  TENANCY_PASSWORD,
  bootstrapHost,
  claimAsNewAccount,
  createPendingCommunity,
  expectStatus,
  pairInstall,
  admit,
  startTenancyHarness,
  waitForLockWaiters,
  type TenancyHarness,
  type TenancyMember,
} from './tenancy-test-harness.js';

const DAY = 24 * 60 * 60_000;
const REFERENCE = 'Case 2026-0042 preservation order';
let h: TenancyHarness;
let clockOffsetMs = 0;
const clock = () => new Date(Date.now() + clockOffsetMs);
let operator: TenancyMember;
let a = '';
let channelA = '';
let p = '';

const tenant = (communityId: string) => `/api/v1/communities/${communityId}`;
const inDays = (days: number) => new Date(clock().getTime() + days * DAY).toISOString();

async function state(communityId = a) {
  return (
    await h.pool.query<{
      lifecycle: string;
      lifecycle_version: number;
      held_from_state: string | null;
      held_at: Date | null;
      suspended_from_state: string | null;
      suspended_at: Date | null;
      deletion_notice_at: Date | null;
      legal_hold_at: Date | null;
    }>(
      `SELECT lifecycle,lifecycle_version,held_from_state,held_at,suspended_from_state,
              suspended_at,deletion_notice_at,legal_hold_at
       FROM communities WHERE id=$1`,
      [communityId]
    )
  ).rows[0];
}

async function host(action: string, extra: Record<string, unknown> = {}, communityId = a) {
  return h.call(`/api/v1/host/communities/${communityId}/lifecycle`, {
    method: 'PATCH',
    cookie: operator.cookie,
    body: { action, lifecycleVersion: (await state(communityId)).lifecycle_version, ...extra },
  });
}

async function audit(action: string, communityId = a) {
  return (
    await h.pool.query<{
      prior_state: string | null;
      next_state: string | null;
      changed_fields: string[];
    }>(
      `SELECT prior_state,next_state,changed_fields FROM host_audit_events
       WHERE community_id=$1 AND action=$2 ORDER BY created_at`,
      [communityId, action]
    )
  ).rows;
}

async function issueKey(scopes: string[]): Promise<string> {
  const issued = await runHostKeyCommand(h.pool, {
    kind: 'issue',
    label: scopes.join(' '),
    scopes: scopes as never,
    expiresInDays: null,
  });
  if (issued.kind !== 'issue') throw new Error('expected a key');
  return issued.secret;
}

function legalHold(
  method: 'PUT' | 'DELETE',
  auth: { bearer?: string; cookie?: string },
  communityId = a,
  reference: string | null = REFERENCE
) {
  return h.call(`/api/v1/host/communities/${communityId}/legal-hold`, {
    method,
    ...auth,
    ...(method === 'PUT' ? { body: { reference } } : {}),
  });
}

function upload(key: string) {
  return h.call(`${tenant(a)}/channels/${channelA}/attachments`, {
    method: 'POST',
    cookie: operator.cookie,
    headers: {
      'content-type': 'text/plain',
      'x-file-name': `${key}.txt`,
      'x-file-size': '4',
      'idempotency-key': key,
    },
    raw: Buffer.from('file'),
  });
}

async function blobKeys(communityId = a): Promise<string[]> {
  return (
    await h.pool.query<{ blob_key: string }>(
      'SELECT blob_key FROM managed_blobs WHERE community_id=$1 ORDER BY blob_key',
      [communityId]
    )
  ).rows.map((row) => row.blob_key);
}

async function storedKeys(keys: string[]): Promise<string[]> {
  const present: string[] = [];
  for (const key of keys) {
    try {
      (await h.blobStore.get(key)).body.destroy();
      present.push(key);
    } catch {
      // Gone from storage.
    }
  }
  return present;
}

beforeAll(async () => {
  h = await startTenancyHarness('host_legal_hold', { now: clock });
  const first = await bootstrapHost(h, 'Operator', 'operator@legal.test');
  operator = { cookie: first.cookie, memberId: first.memberId };
  a = first.communityId;
  channelA = first.channelId;
  p = (await createPendingCommunity(h, operator.cookie, 'Unclaimed P')).communityId;
}, 60_000);

afterAll(async () => {
  await h?.close();
});

it('holds a suspended active community in one call, reviving nothing', async () => {
  // Purpose: before DOR-2299 a suspended community had to be resumed (made live) and then held,
  // two calls with a live window between them; hold now refuses nothing and never resumes.
  const member = await admit(h, a, operator.cookie, { name: 'Member', email: 'member@legal.test' });
  const grant = await pairInstall(h, a, member.cookie);
  await expectStatus(await host('suspend'), 200, 'suspend');
  const held = await expectStatus(
    await host('hold', { deletionNoticeAt: null }),
    200,
    'hold from suspended'
  );
  expect(await held.json()).toMatchObject({ lifecycle: 'held' });
  expect(await state()).toMatchObject({
    lifecycle: 'held',
    held_from_state: 'active',
    suspended_from_state: null,
    suspended_at: null,
  });
  expect((await state()).held_at).not.toBeNull();
  expect(await audit('community.hold')).toEqual([
    {
      prior_state: 'suspended',
      next_state: 'held',
      changed_fields: ['lifecycle', 'suspended_from_state'],
    },
  ]);
  // No resume happened on the way, and the grant the suspension revoked stays revoked.
  expect(await audit('community.resume')).toEqual([]);
  expect((await h.call(`${tenant(a)}/channels`, { bearer: grant })).status).toBe(401);
  await expectStatus(await host('release'), 200, 'release');
  expect(await state()).toMatchObject({ lifecycle: 'active', held_from_state: null });
});

it('holds a suspended archived community, returning to archived on release', async () => {
  // Purpose: fails if the hold records the wrong state to return to.
  await expectStatus(
    await h.call(`${tenant(a)}/owner/lifecycle`, {
      cookie: operator.cookie,
      body: {
        action: 'archive',
        lifecycleVersion: (await state()).lifecycle_version,
        password: TENANCY_PASSWORD,
        confirmName: 'Operator Community',
      },
    }),
    200,
    'owner archives'
  );
  await expectStatus(await host('suspend'), 200, 'suspend archived');
  await expectStatus(await host('hold', { deletionNoticeAt: null }), 200, 'hold from suspended');
  expect(await state()).toMatchObject({ lifecycle: 'held', held_from_state: 'archived' });
  await expectStatus(await host('release'), 200, 'release');
  expect(await state()).toMatchObject({ lifecycle: 'archived' });
  await expectStatus(
    await h.call(`${tenant(a)}/owner/lifecycle`, {
      cookie: operator.cookie,
      body: {
        action: 'restore',
        lifecycleVersion: (await state()).lifecycle_version,
        password: TENANCY_PASSWORD,
      },
    }),
    200,
    'owner restores'
  );
});

it('holds a community suspended from a hold, keeping the original hold and taking a new notice', async () => {
  // Purpose: fails if holding from a suspended hold forgets where the hold began or restarts it,
  // or cannot publish the notice the suspension withdrew.
  await expectStatus(await host('hold', { deletionNoticeAt: null }), 200, 'hold');
  const heldAt = (await state()).held_at;
  clockOffsetMs += DAY;
  await expectStatus(await host('suspend'), 200, 'suspend the hold');
  expect(await state()).toMatchObject({ lifecycle: 'suspended', suspended_from_state: 'held' });
  const notice = inDays(20);
  await expectStatus(await host('hold', { deletionNoticeAt: notice }), 200, 'hold again');
  const after = await state();
  expect(after).toMatchObject({
    lifecycle: 'held',
    held_from_state: 'active',
    suspended_from_state: null,
  });
  expect(after.held_at).toEqual(heldAt);
  expect(after.deletion_notice_at?.toISOString()).toBe(notice);
  // Too short a notice is still refused on this path.
  await expectStatus(await host('suspend'), 200, 'suspend again');
  expect((await host('hold', { deletionNoticeAt: inDays(1) })).status).toBe(409);
  expect(await state()).toMatchObject({ lifecycle: 'suspended' });
  await expectStatus(await host('hold', { deletionNoticeAt: null }), 200, 'hold without notice');
  await expectStatus(await host('release'), 200, 'release');
  expect(await state()).toMatchObject({ lifecycle: 'active' });
});

it('lets only communities:legal_hold (or a host person) place and release a legal hold, audited without the reference', async () => {
  // Purpose: fails if any other scope, including lifecycle, can lift the preservation that
  // stops a deletion, or if the host's reference leaks into the audit.
  const everythingElse = await issueKey([
    'communities:read',
    'communities:write',
    'communities:lifecycle',
    'communities:import',
  ]);
  expect((await legalHold('PUT', { bearer: everythingElse })).status).toBe(403);
  const legalKey = await issueKey(['communities:legal_hold']);
  const placed = await expectStatus(await legalHold('PUT', { bearer: legalKey }), 200, 'place');
  const projection = await placed.json();
  expect(projection.legalHold).toMatchObject({ reference: REFERENCE });
  expect(Date.parse(projection.legalHold.since)).not.toBeNaN();
  await expectStatus(
    await legalHold('PUT', { bearer: legalKey }, a, 'Updated reference'),
    200,
    'update'
  );
  expect((await state()).legal_hold_at?.toISOString()).toBe(projection.legalHold.since);
  expect((await legalHold('DELETE', { bearer: everythingElse })).status).toBe(403);
  await expectStatus(
    await legalHold('DELETE', { cookie: operator.cookie }),
    200,
    'person releases'
  );
  expect((await legalHold('DELETE', { bearer: legalKey })).status).toBe(409);
  expect((await state()).legal_hold_at).toBeNull();
  expect((await audit('community.legal_hold.set'))[0].changed_fields).toEqual([
    'legal_hold_at',
    'legal_hold_by_host_actor',
    'legal_hold_reference',
  ]);
  expect(await audit('community.legal_hold.update')).toHaveLength(1);
  expect(await audit('community.legal_hold.release')).toHaveLength(1);
  const rows = await h.pool.query<{ row: string }>(
    `SELECT to_jsonb(e)::text AS row FROM host_audit_events e WHERE action LIKE 'community.legal_hold.%'`
  );
  expect(rows.rows).toHaveLength(3);
  for (const { row } of rows.rows) {
    expect(row).not.toContain('Case 2026');
    expect(row).not.toContain('Updated reference');
  }
});

it('refuses to abandon an unclaimed community under a legal hold', async () => {
  // Purpose: abandon deletes a community outright; a legal hold must stop it too.
  // Revoke P's owner claim first, so the legal hold is the only thing that stops the abandon.
  const grant = await h.pool.query<{ id: string }>(
    'SELECT id FROM bootstrap_grants WHERE community_id=$1 AND revoked_at IS NULL',
    [p]
  );
  await expectStatus(
    await h.call(`/api/v1/host/communities/${p}/owner-claims/${grant.rows[0].id}/revoke`, {
      cookie: operator.cookie,
      body: {},
    }),
    204,
    'revoke the owner claim'
  );
  await expectStatus(await legalHold('PUT', { cookie: operator.cookie }, p), 200, 'hold P');
  const refused = await h.call(`/api/v1/host/communities/${p}`, {
    method: 'DELETE',
    cookie: operator.cookie,
  });
  expect(refused.status).toBe(409);
  expect((await refused.json()).code).toBe('LEGAL_HOLD_ACTIVE');
  expect(await state(p)).toBeDefined();
  await expectStatus(await legalHold('DELETE', { cookie: operator.cookie }, p), 200, 'release P');
  await expectStatus(
    await h.call(`/api/v1/host/communities/${p}`, { method: 'DELETE', cookie: operator.cookie }),
    204,
    'abandon after release'
  );
});

it('refuses host-started deletion under a legal hold, even after the notice date', async () => {
  // Purpose: fails if the host's own deletion path ignores its legal hold.
  await expectStatus(await host('hold', { deletionNoticeAt: inDays(15) }), 200, 'hold with notice');
  clockOffsetMs += 16 * DAY;
  await expectStatus(await legalHold('PUT', { cookie: operator.cookie }), 200, 'legal hold');
  const refused = await h.call(`/api/v1/host/communities/${a}/deletion`, {
    cookie: operator.cookie,
    body: { lifecycleVersion: (await state()).lifecycle_version, confirmIdSuffix: a.slice(-8) },
  });
  expect(refused.status).toBe(409);
  expect((await refused.json()).code).toBe('LEGAL_HOLD_ACTIVE');
  expect(await state()).toMatchObject({ lifecycle: 'held' });
  await expectStatus(await host('release'), 200, 'release the lifecycle hold');
});

it('accepts the owner’s deletion under a legal hold without telling them, and the worker purges nothing', async () => {
  // Purpose: the owner must not learn of the hold (no tenant response mentions it), people lose
  // access as the owner asked, and no byte or row is removed while it stands.
  for (const key of ['one', 'two', 'three'])
    await expectStatus(await upload(key), 201, `upload ${key}`);
  const before = await blobKeys();
  expect(before.length).toBeGreaterThanOrEqual(3);
  const tenantBodies: string[] = [];
  tenantBodies.push(
    await (await h.call(`${tenant(a)}/community`, { cookie: operator.cookie })).text()
  );
  const deletion = await expectStatus(
    await h.call(`${tenant(a)}/owner/deletion`, {
      cookie: operator.cookie,
      body: {
        lifecycleVersion: (await state()).lifecycle_version,
        password: TENANCY_PASSWORD,
        confirmName: 'Operator Community',
        confirmIdSuffix: a.slice(-8),
      },
    }),
    200,
    'owner requests deletion'
  );
  tenantBodies.push(await deletion.text());
  tenantBodies.push(
    await (await h.call(`${tenant(a)}/owner/deletion`, { cookie: operator.cookie })).text()
  );
  expect(await state()).toMatchObject({ lifecycle: 'deletion_pending' });
  for (const body of tenantBodies) {
    expect(body.toLowerCase()).not.toContain('legal');
    expect(body).not.toContain('Case 2026');
  }
  await h.pool.query(
    `UPDATE communities SET delete_requested_at=now()-interval '8 days',
       delete_after=now()-interval '1 day' WHERE id=$1`,
    [a]
  );
  await h.pool.query(
    `UPDATE community_deletion_jobs SET delete_after=now()-interval '1 day',next_attempt_at=now()
     WHERE community_id=$1`,
    [a]
  );
  expect(await sweepCommunityDeletions(h.pool, h.blobStore, 100)).toMatchObject({
    claimed: 0,
    deletedBlobs: 0,
    completed: 0,
  });
  expect(await storedKeys(before)).toEqual(before);
  expect(await state()).toMatchObject({ lifecycle: 'deletion_pending' });
});

it('never lets a held deletion stall the queue for other communities', async () => {
  // Purpose: the worker takes one due job at a time. If it picked the held one and gave up,
  // every other community's deletion would wait behind it for as long as the hold lasts.
  const pending = await createPendingCommunity(h, operator.cookie, 'Tenant Q');
  const owner = await claimAsNewAccount(h, pending.token, 'Q Owner', 'q-owner@legal.test');
  await expectStatus(
    await h.call(`${tenant(pending.communityId)}/owner/deletion`, {
      cookie: owner.cookie,
      body: {
        lifecycleVersion: (await state(pending.communityId)).lifecycle_version,
        password: TENANCY_PASSWORD,
        confirmName: 'Tenant Q',
        confirmIdSuffix: pending.communityId.slice(-8),
      },
    }),
    200,
    'Q owner requests deletion'
  );
  await h.pool.query(
    `UPDATE communities SET delete_requested_at=now()-interval '8 days',
       delete_after=now()-interval '1 day' WHERE id=$1`,
    [pending.communityId]
  );
  // A's job is due first, so a worker that picked it would never reach Q's.
  await h.pool.query(
    `UPDATE community_deletion_jobs SET delete_after=now()-interval '1 day',
       next_attempt_at=CASE WHEN community_id=$1 THEN now()-interval '1 hour' ELSE now() END
     WHERE community_id IN ($1,$2)`,
    [a, pending.communityId]
  );
  expect(await sweepCommunityDeletions(h.pool, h.blobStore, 100)).toMatchObject({ claimed: 1 });
  const jobs = await h.pool.query<{ community_id: string; state: string }>(
    'SELECT community_id,state FROM community_deletion_jobs WHERE community_id IN ($1,$2)',
    [a, pending.communityId]
  );
  expect(jobs.rows.find((job) => job.community_id === a)?.state).toBe('waiting');
  expect(await state()).toMatchObject({ lifecycle: 'deletion_pending' });
});

it('stops a purge already under way before its next blob when a legal hold is placed', async () => {
  // Purpose: the worker deletes blobs outside any long transaction; a hold placed mid-purge
  // must still stop it. A barrier holds the worker inside its first blob deletion.
  await expectStatus(await legalHold('DELETE', { cookie: operator.cookie }), 200, 'release');
  const before = await blobKeys();
  let entered!: () => void;
  let release!: () => void;
  const inFirstDelete = new Promise<void>((resolve) => (entered = resolve));
  const gate = new Promise<void>((resolve) => (release = resolve));
  let deletes = 0;
  const barrier: BlobStore = {
    put: (input) => h.blobStore.put(input),
    get: (key, options) => h.blobStore.get(key, options),
    listNamespace: (options) => h.blobStore.listNamespace(options),
    delete: async (key, options) => {
      if (deletes++ === 0) {
        entered();
        await gate;
      }
      return h.blobStore.delete(key, options);
    },
  };
  const sweeping = sweepCommunityDeletions(h.pool, barrier, 100);
  await inFirstDelete;
  const placing = legalHold('PUT', { cookie: operator.cookie });
  // The hold waits for the blob deletion in progress, which holds the row FOR SHARE.
  await waitForLockWaiters(h, 1, 'legal_hold_at');
  release();
  const [swept, placed] = await Promise.all([sweeping, placing]);
  expect(placed.status).toBe(200);
  expect(swept).toMatchObject({ claimed: 1, deletedBlobs: 1, completed: 0 });
  expect(deletes).toBe(1);
  expect(await storedKeys(before)).toHaveLength(before.length - 1);
  expect(await state()).toMatchObject({ lifecycle: 'deletion_pending' });
  // Later passes, however many, touch nothing while it stands.
  await h.pool.query(
    'UPDATE community_deletion_jobs SET next_attempt_at=now() WHERE community_id=$1',
    [a]
  );
  expect(await sweepCommunityDeletions(h.pool, h.blobStore, 100)).toMatchObject({ claimed: 0 });
  expect(await storedKeys(before)).toHaveLength(before.length - 1);
});

it('keeps the community’s rows when a hold lands during the last blob deletion', async () => {
  // Purpose: once the last blob is gone the worker deletes the tenant's rows in one final step.
  // A hold placed while that last blob was being deleted must stop the final step too.
  await expectStatus(await legalHold('DELETE', { cookie: operator.cookie }), 200, 'release');
  const remaining = await storedKeys(await blobKeys());
  expect(remaining.length).toBeGreaterThan(0);
  let entered!: () => void;
  let release!: () => void;
  const inLastDelete = new Promise<void>((resolve) => (entered = resolve));
  const gate = new Promise<void>((resolve) => (release = resolve));
  let deletes = 0;
  const barrier: BlobStore = {
    put: (input) => h.blobStore.put(input),
    get: (key, options) => h.blobStore.get(key, options),
    listNamespace: (options) => h.blobStore.listNamespace(options),
    delete: async (key, options) => {
      if (++deletes === remaining.length) {
        entered();
        await gate;
      }
      return h.blobStore.delete(key, options);
    },
  };
  await h.pool.query(
    'UPDATE community_deletion_jobs SET next_attempt_at=now() WHERE community_id=$1',
    [a]
  );
  const sweeping = sweepCommunityDeletions(h.pool, barrier, 100);
  await inLastDelete;
  const placing = legalHold('PUT', { cookie: operator.cookie });
  await waitForLockWaiters(h, 1, 'legal_hold_at');
  release();
  const [swept, placed] = await Promise.all([sweeping, placing]);
  expect(placed.status).toBe(200);
  expect(swept).toMatchObject({ completed: 0 });
  expect(await storedKeys(remaining)).toEqual([]);
  expect(await state()).toMatchObject({ lifecycle: 'deletion_pending' });
  expect(
    (await h.pool.query('SELECT 1 FROM members WHERE community_id=$1', [a])).rowCount
  ).toBeGreaterThan(0);
});

it('finishes the owner’s deletion once the legal hold is released', async () => {
  // Purpose: a release must let the deletion the owner asked for proceed, not drop it.
  await expectStatus(await legalHold('DELETE', { cookie: operator.cookie }), 200, 'release');
  for (let pass = 0; pass < 10; pass++) {
    await h.pool.query(
      'UPDATE community_deletion_jobs SET next_attempt_at=now() WHERE community_id=$1',
      [a]
    );
    const result = await sweepCommunityDeletions(h.pool, h.blobStore, 100);
    if (result.completed) break;
  }
  expect(await state()).toBeUndefined();
});
