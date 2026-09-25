/**
 * Holding a suspended community in one call, and the host legal hold (spec
 * `community-host-operator-api`, "Holding a suspended community" and "Legal hold"; ADR
 * `260924-215422`; DOR-2299).
 *
 * Every test builds its own community and can run alone. The host operator's session is shared.
 * After each test every deletion job is parked far in the future, so one test's deletion never
 * reaches another test's worker pass.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import { sweepCommunityDeletions } from '../deletion-worker.js';
import { drainExports } from './export-test-helpers.js';
import { runHostKeyCommand } from '../host-keys.js';
import type { BlobStore } from '../storage/index.js';
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
  waitForLockWaiters,
  type TenancyHarness,
  type TenancyMember,
} from './tenancy-test-harness.js';

const DAY = 24 * 60 * 60_000;
const REFERENCE = 'Case 2026-0042 preservation order';
let h: TenancyHarness;
let operator: TenancyMember;

const tenant = (communityId: string) => `/api/v1/communities/${communityId}`;
const inDays = (days: number) => new Date(Date.now() + days * DAY).toISOString();

/** A claimed community of its own, with an owner and a channel the owner can upload to. */
interface Community {
  id: string;
  name: string;
  owner: TenancyMember;
  channelId: string;
}

async function community(): Promise<Community> {
  const name = `Place ${randomUUID().slice(0, 8)}`;
  const pending = await createPendingCommunity(h, operator.cookie, name);
  const owner = await claimAsNewAccount(
    h,
    pending.token,
    `${name} Owner`,
    `${randomUUID()}@legal.test`
  );
  const channelId = await createChannel(h, pending.communityId, owner.cookie, 'files');
  return { id: pending.communityId, name, owner, channelId };
}

async function state(communityId: string) {
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

async function host(communityId: string, action: string, extra: Record<string, unknown> = {}) {
  return h.call(`/api/v1/host/communities/${communityId}/lifecycle`, {
    method: 'PATCH',
    cookie: operator.cookie,
    body: { action, lifecycleVersion: (await state(communityId)).lifecycle_version, ...extra },
  });
}

async function audit(communityId: string, action: string) {
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
  communityId: string,
  auth: { bearer?: string; cookie?: string } = { cookie: operator.cookie },
  reference: string | null = REFERENCE
) {
  return h.call(`/api/v1/host/communities/${communityId}/legal-hold`, {
    method,
    ...auth,
    ...(method === 'PUT' ? { body: { reference } } : {}),
  });
}

async function upload(c: Community, key: string) {
  await expectStatus(
    await h.call(`${tenant(c.id)}/channels/${c.channelId}/attachments`, {
      method: 'POST',
      cookie: c.owner.cookie,
      headers: {
        'content-type': 'text/plain',
        'x-file-name': `${key}.txt`,
        'x-file-size': '4',
        'idempotency-key': key,
      },
      raw: Buffer.from('file'),
    }),
    201,
    `upload ${key}`
  );
}

/** The owner asks to delete their community, and the deletion is made due at once. */
async function ownerDeletesAndItIsDue(c: Community): Promise<Response> {
  const response = await expectStatus(
    await h.call(`${tenant(c.id)}/owner/deletion`, {
      cookie: c.owner.cookie,
      body: {
        lifecycleVersion: (await state(c.id)).lifecycle_version,
        password: TENANCY_PASSWORD,
        confirmName: c.name,
        confirmIdSuffix: c.id.slice(-8),
      },
    }),
    200,
    'owner requests deletion'
  );
  await h.pool.query(
    `UPDATE communities SET delete_requested_at=now()-interval '8 days',
       delete_after=now()-interval '1 day' WHERE id=$1`,
    [c.id]
  );
  await h.pool.query(
    `UPDATE community_deletion_jobs SET delete_after=now()-interval '1 day',next_attempt_at=now()
     WHERE community_id=$1`,
    [c.id]
  );
  return response;
}

async function blobKeys(communityId: string): Promise<string[]> {
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

/** A blob store that stops inside the `nth` delete until released, and records each delete. */
function barrierStore(nth: number) {
  let entered!: () => void;
  let release!: () => void;
  const inside = new Promise<void>((resolve) => (entered = resolve));
  const gate = new Promise<void>((resolve) => (release = resolve));
  const signals: (AbortSignal | undefined)[] = [];
  const store: BlobStore = {
    put: (input) => h.blobStore.put(input),
    get: (key, options) => h.blobStore.get(key, options),
    listNamespace: (options) => h.blobStore.listNamespace(options),
    delete: async (key, options) => {
      signals.push(options?.signal);
      if (signals.length === nth) {
        entered();
        await gate;
      }
      return h.blobStore.delete(key, options);
    },
  };
  return { store, inside, release: () => release(), signals };
}

beforeAll(async () => {
  h = await startTenancyHarness('host_legal_hold');
  const first = await bootstrapHost(h, 'Operator', 'operator@legal.test');
  operator = { cookie: first.cookie, memberId: first.memberId };
}, 60_000);

afterEach(async () => {
  await h.pool.query(
    "UPDATE community_deletion_jobs SET next_attempt_at=now()+interval '100 years'"
  );
});

afterAll(async () => {
  await h?.close();
});

it('holds a suspended active community in one call, reviving nothing', async () => {
  // Purpose: before DOR-2299 a suspended community had to be resumed (made live) and then held,
  // two calls with a live window between them. Fails if hold refuses a suspended community or
  // goes through a resume.
  const c = await community();
  const member = await admit(h, c.id, c.owner.cookie, {
    name: 'Member',
    email: `${randomUUID()}@legal.test`,
  });
  const grant = await pairInstall(h, c.id, member.cookie);
  await expectStatus(await host(c.id, 'suspend'), 200, 'suspend');
  const held = await expectStatus(
    await host(c.id, 'hold', { deletionNoticeAt: null }),
    200,
    'hold from suspended'
  );
  expect(await held.json()).toMatchObject({ lifecycle: 'held' });
  const after = await state(c.id);
  expect(after).toMatchObject({
    lifecycle: 'held',
    held_from_state: 'active',
    suspended_from_state: null,
    suspended_at: null,
  });
  expect(after.held_at).not.toBeNull();
  expect(await audit(c.id, 'community.hold')).toEqual([
    {
      prior_state: 'suspended',
      next_state: 'held',
      changed_fields: ['lifecycle', 'suspended_from_state'],
    },
  ]);
  expect(await audit(c.id, 'community.resume')).toEqual([]);
  expect((await h.call(`${tenant(c.id)}/channels`, { bearer: grant })).status).toBe(401);
  await expectStatus(await host(c.id, 'release'), 200, 'release');
  expect(await state(c.id)).toMatchObject({ lifecycle: 'active', held_from_state: null });
});

it('revokes again on hold from suspended, so a credential that slipped through never survives', async () => {
  // Purpose: suspension revokes everything; if anything were left live, the hold must end it.
  const c = await community();
  const member = await admit(h, c.id, c.owner.cookie, {
    name: 'Member',
    email: `${randomUUID()}@legal.test`,
  });
  await pairInstall(h, c.id, member.cookie);
  await expectStatus(await host(c.id, 'suspend'), 200, 'suspend');
  await h.pool.query('UPDATE connection_grants SET revoked_at=NULL WHERE community_id=$1', [c.id]);
  await expectStatus(await host(c.id, 'hold', { deletionNoticeAt: null }), 200, 'hold');
  const live = await h.pool.query(
    'SELECT 1 FROM connection_grants WHERE community_id=$1 AND revoked_at IS NULL',
    [c.id]
  );
  expect(live.rowCount).toBe(0);
});

it('holds a suspended archived community, returning to archived on release', async () => {
  // Purpose: fails if the hold records the wrong state to return to.
  const c = await community();
  await expectStatus(
    await h.call(`${tenant(c.id)}/owner/lifecycle`, {
      cookie: c.owner.cookie,
      body: {
        action: 'archive',
        lifecycleVersion: (await state(c.id)).lifecycle_version,
        password: TENANCY_PASSWORD,
        confirmName: c.name,
      },
    }),
    200,
    'owner archives'
  );
  await expectStatus(await host(c.id, 'suspend'), 200, 'suspend archived');
  await expectStatus(await host(c.id, 'hold', { deletionNoticeAt: null }), 200, 'hold');
  expect(await state(c.id)).toMatchObject({ lifecycle: 'held', held_from_state: 'archived' });
  await expectStatus(await host(c.id, 'release'), 200, 'release');
  expect(await state(c.id)).toMatchObject({ lifecycle: 'archived' });
});

it('holds a community suspended from a hold, keeping the original hold and taking a new notice', async () => {
  // Purpose: fails if holding from a suspended hold forgets where the hold began, restarts it,
  // or cannot publish the notice the suspension withdrew; a too-short notice is still refused.
  const c = await community();
  await expectStatus(await host(c.id, 'hold', { deletionNoticeAt: null }), 200, 'hold');
  const heldAt = (await state(c.id)).held_at;
  await expectStatus(await host(c.id, 'suspend'), 200, 'suspend the hold');
  expect(await state(c.id)).toMatchObject({ lifecycle: 'suspended', suspended_from_state: 'held' });
  expect((await host(c.id, 'hold', { deletionNoticeAt: inDays(1) })).status).toBe(409);
  expect(await state(c.id)).toMatchObject({ lifecycle: 'suspended' });
  const notice = inDays(20);
  await expectStatus(await host(c.id, 'hold', { deletionNoticeAt: notice }), 200, 'hold again');
  const after = await state(c.id);
  expect(after).toMatchObject({
    lifecycle: 'held',
    held_from_state: 'active',
    suspended_from_state: null,
  });
  expect(after.held_at).toEqual(heldAt);
  expect(after.deletion_notice_at?.toISOString()).toBe(notice);
});

it('lets only communities:legal_hold (or a host person) place and release a legal hold, audited without the reference', async () => {
  // Purpose: fails if any other scope, including lifecycle, can lift the preservation that
  // stops a deletion, or if the host's reference leaks into the audit.
  const c = await community();
  const everythingElse = await issueKey([
    'communities:read',
    'communities:write',
    'communities:lifecycle',
    'communities:import',
  ]);
  expect((await legalHold('PUT', c.id, { bearer: everythingElse })).status).toBe(403);
  const legalKey = await issueKey(['communities:legal_hold']);
  const placed = await expectStatus(
    await legalHold('PUT', c.id, { bearer: legalKey }),
    200,
    'place'
  );
  const projection = await placed.json();
  expect(projection.legalHold).toMatchObject({ reference: REFERENCE });
  await expectStatus(
    await legalHold('PUT', c.id, { bearer: legalKey }, 'Updated reference'),
    200,
    'update'
  );
  expect((await state(c.id)).legal_hold_at?.toISOString()).toBe(projection.legalHold.since);
  expect((await legalHold('DELETE', c.id, { bearer: everythingElse })).status).toBe(403);
  await expectStatus(await legalHold('DELETE', c.id), 200, 'person releases');
  expect((await legalHold('DELETE', c.id, { bearer: legalKey })).status).toBe(409);
  expect((await state(c.id)).legal_hold_at).toBeNull();
  expect((await audit(c.id, 'community.legal_hold.set'))[0].changed_fields).toEqual([
    'legal_hold_at',
    'legal_hold_by_host_actor',
    'legal_hold_reference',
  ]);
  expect(await audit(c.id, 'community.legal_hold.update')).toHaveLength(1);
  expect(await audit(c.id, 'community.legal_hold.release')).toHaveLength(1);
  const rows = await h.pool.query<{ row: string }>(
    `SELECT to_jsonb(e)::text AS row FROM host_audit_events e
     WHERE community_id=$1 AND action LIKE 'community.legal_hold.%'`,
    [c.id]
  );
  expect(rows.rows).toHaveLength(3);
  for (const { row } of rows.rows) {
    expect(row).not.toContain('Case 2026');
    expect(row).not.toContain('Updated reference');
  }
});

it('shows the reference only to a host person and a key with communities:legal_hold', async () => {
  // Purpose: a reference may name a case. A read-only provisioning key learns only that a hold
  // exists and since when, which explains a paused deletion.
  const c = await community();
  await expectStatus(await legalHold('PUT', c.id), 200, 'place');
  const read = async (auth: { bearer?: string; cookie?: string }) =>
    (
      await (
        await expectStatus(await h.call(`/api/v1/host/communities/${c.id}`, auth), 200, 'read')
      ).json()
    ).legalHold;
  const readOnly = await issueKey(['communities:read']);
  const readAndLegal = await issueKey(['communities:read', 'communities:legal_hold']);
  expect(await read({ bearer: readOnly })).toMatchObject({ reference: null });
  expect((await read({ bearer: readOnly })).since).toEqual(expect.any(String));
  expect(await read({ bearer: readAndLegal })).toMatchObject({ reference: REFERENCE });
  expect(await read({ cookie: operator.cookie })).toMatchObject({ reference: REFERENCE });
  const list = await (
    await expectStatus(await h.call('/api/v1/host/communities', { bearer: readOnly }), 200, 'list')
  ).json();
  expect(
    (list.communities as { id: string; legalHold: unknown }[]).find((row) => row.id === c.id)
      ?.legalHold
  ).toMatchObject({ reference: null });
});

it('refuses to abandon an unclaimed community under a legal hold', async () => {
  // Purpose: abandon deletes a community outright; a legal hold must stop it too.
  const pending = await createPendingCommunity(h, operator.cookie, 'Unclaimed');
  const grant = await h.pool.query<{ id: string }>(
    'SELECT id FROM bootstrap_grants WHERE community_id=$1 AND revoked_at IS NULL',
    [pending.communityId]
  );
  await expectStatus(
    await h.call(
      `/api/v1/host/communities/${pending.communityId}/owner-claims/${grant.rows[0].id}/revoke`,
      { cookie: operator.cookie, body: {} }
    ),
    204,
    'revoke the owner claim, so only the legal hold can stop the abandon'
  );
  await expectStatus(await legalHold('PUT', pending.communityId), 200, 'hold');
  const abandon = () =>
    h.call(`/api/v1/host/communities/${pending.communityId}`, {
      method: 'DELETE',
      cookie: operator.cookie,
    });
  const refused = await abandon();
  expect(refused.status).toBe(409);
  expect((await refused.json()).code).toBe('LEGAL_HOLD_ACTIVE');
  await expectStatus(await legalHold('DELETE', pending.communityId), 200, 'release');
  await expectStatus(await abandon(), 204, 'abandon after release');
});

it('refuses host-started deletion under a legal hold, even after the notice date', async () => {
  // Purpose: fails if the host's own deletion path ignores its legal hold.
  const c = await community();
  await expectStatus(await host(c.id, 'hold', { deletionNoticeAt: inDays(15) }), 200, 'hold');
  await h.pool.query(
    "UPDATE communities SET deletion_notice_at=now()-interval '1 minute' WHERE id=$1",
    [c.id]
  );
  await expectStatus(await legalHold('PUT', c.id), 200, 'legal hold');
  const refused = await h.call(`/api/v1/host/communities/${c.id}/deletion`, {
    cookie: operator.cookie,
    body: {
      lifecycleVersion: (await state(c.id)).lifecycle_version,
      confirmIdSuffix: c.id.slice(-8),
    },
  });
  expect(refused.status).toBe(409);
  expect((await refused.json()).code).toBe('LEGAL_HOLD_ACTIVE');
  expect(await state(c.id)).toMatchObject({ lifecycle: 'held' });
});

it('refuses, in the database itself, to delete a legally held community’s rows', async () => {
  // Purpose: the trigger is the last line of defence, including for code older than the
  // migration after a rollback. A purge that ends by deleting the community row rolls back
  // whole, so none of the tenant's rows go.
  const c = await community();
  await expectStatus(await legalHold('PUT', c.id), 200, 'place');
  const client = await h.pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM channel_members WHERE community_id=$1', [c.id]);
    await expect(client.query('DELETE FROM communities WHERE id=$1', [c.id])).rejects.toMatchObject(
      { code: '23514', message: expect.stringContaining('legal hold') }
    );
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
  const members = await h.pool.query('SELECT 1 FROM channel_members WHERE community_id=$1', [c.id]);
  expect(members.rowCount).toBeGreaterThan(0);
  expect(await state(c.id)).toBeDefined();
});

it('accepts the owner’s deletion under a legal hold without telling them, and the worker purges nothing', async () => {
  // Purpose: the owner must not learn of the hold (no tenant response mentions it), people lose
  // access as the owner asked, and no byte or row is removed while it stands.
  const c = await community();
  for (const key of ['one', 'two', 'three']) await upload(c, key);
  const before = await blobKeys(c.id);
  await expectStatus(await legalHold('PUT', c.id), 200, 'place');
  const bodies = [
    await (await h.call(`${tenant(c.id)}/community`, { cookie: c.owner.cookie })).text(),
    await (await ownerDeletesAndItIsDue(c)).text(),
    await (await h.call(`${tenant(c.id)}/owner/deletion`, { cookie: c.owner.cookie })).text(),
  ];
  expect(await state(c.id)).toMatchObject({ lifecycle: 'deletion_pending' });
  for (const body of bodies) {
    expect(body.toLowerCase()).not.toContain('legal');
    expect(body).not.toContain('Case 2026');
  }
  expect(await sweepCommunityDeletions(h.pool, h.blobStore, 100)).toMatchObject({
    claimed: 0,
    deletedBlobs: 0,
    completed: 0,
  });
  expect(await storedKeys(before)).toEqual(before);
  expect(await state(c.id)).toMatchObject({ lifecycle: 'deletion_pending' });
});

it('never lets a held deletion stall the queue for other communities', async () => {
  // Purpose: the worker takes one due job at a time. If it picked the held one and gave up,
  // every other community's deletion would wait behind it for as long as the hold lasts.
  const held = await community();
  const other = await community();
  await expectStatus(await legalHold('PUT', held.id), 200, 'place');
  await ownerDeletesAndItIsDue(held);
  await ownerDeletesAndItIsDue(other);
  // The held job is due first, so a worker that picked it would never reach the other.
  await h.pool.query(
    "UPDATE community_deletion_jobs SET next_attempt_at=now()-interval '1 hour' WHERE community_id=$1",
    [held.id]
  );
  expect(await sweepCommunityDeletions(h.pool, h.blobStore, 100)).toMatchObject({ claimed: 1 });
  const jobs = await h.pool.query<{ community_id: string; state: string }>(
    'SELECT community_id,state FROM community_deletion_jobs WHERE community_id IN ($1,$2)',
    [held.id, other.id]
  );
  expect(jobs.rows.find((job) => job.community_id === held.id)?.state).toBe('waiting');
  expect(await state(held.id)).toMatchObject({ lifecycle: 'deletion_pending' });
});

it('stops a purge already under way before its next file when a legal hold is placed', async () => {
  // Purpose: the worker deletes files outside any long transaction; a hold placed mid-purge must
  // still stop it. Each storage delete also carries a timeout signal, so one slow file cannot
  // hold the community row (and a hold being placed) for long.
  const c = await community();
  for (const key of ['one', 'two', 'three']) await upload(c, key);
  const before = await storedKeys(await blobKeys(c.id));
  await ownerDeletesAndItIsDue(c);
  const barrier = barrierStore(1);
  const sweeping = sweepCommunityDeletions(h.pool, barrier.store, 100);
  await barrier.inside;
  const placing = legalHold('PUT', c.id);
  // The hold waits for the file deletion in progress, which holds the row FOR SHARE.
  await waitForLockWaiters(h, 1, 'legal_hold_at');
  barrier.release();
  const [swept, placed] = await Promise.all([sweeping, placing]);
  expect(placed.status).toBe(200);
  expect(swept).toMatchObject({ claimed: 1, deletedBlobs: 1, completed: 0 });
  expect(barrier.signals).toHaveLength(1);
  expect(barrier.signals[0]).toBeInstanceOf(AbortSignal);
  expect(await storedKeys(before)).toHaveLength(before.length - 1);
  await h.pool.query(
    'UPDATE community_deletion_jobs SET next_attempt_at=now() WHERE community_id=$1',
    [c.id]
  );
  expect(await sweepCommunityDeletions(h.pool, h.blobStore, 100)).toMatchObject({ claimed: 0 });
  expect(await storedKeys(before)).toHaveLength(before.length - 1);
});

it('keeps the community’s rows when a hold lands during the last file deletion', async () => {
  // Purpose: once the last file is gone the worker deletes the tenant's rows in one final step.
  // A hold placed while that last file was being deleted must stop the final step too.
  const c = await community();
  for (const key of ['one', 'two']) await upload(c, key);
  const files = await storedKeys(await blobKeys(c.id));
  await ownerDeletesAndItIsDue(c);
  const barrier = barrierStore(files.length);
  const sweeping = sweepCommunityDeletions(h.pool, barrier.store, 100);
  await barrier.inside;
  const placing = legalHold('PUT', c.id);
  await waitForLockWaiters(h, 1, 'legal_hold_at');
  barrier.release();
  const [swept, placed] = await Promise.all([sweeping, placing]);
  expect(placed.status).toBe(200);
  expect(swept).toMatchObject({ completed: 0 });
  expect(await storedKeys(files)).toEqual([]);
  expect(await state(c.id)).toMatchObject({ lifecycle: 'deletion_pending' });
  expect(
    (await h.pool.query('SELECT 1 FROM members WHERE community_id=$1', [c.id])).rowCount
  ).toBeGreaterThan(0);
});

it('lets an owner export finish under a legal hold, with or without a lifecycle hold', async () => {
  // Purpose: a legal hold only stops deletion. An owner export is not a deletion, so a job
  // started before the legal hold, and one started while the community is also on hold, must
  // still reach ready.
  const exportState = async (communityId: string) =>
    (
      await h.pool.query<{ state: string }>(
        `SELECT state FROM export_archives WHERE community_id=$1 AND scope='owner'
         ORDER BY created_at DESC LIMIT 1`,
        [communityId]
      )
    ).rows[0]?.state;
  const startExport = async (c: Community) =>
    expect(
      (
        await h.call(`${tenant(c.id)}/owner/export`, {
          cookie: c.owner.cookie,
          body: { password: TENANCY_PASSWORD },
        })
      ).status
    ).toBeLessThan(300);

  const before = await community();
  await upload(before, 'one');
  await startExport(before);
  await expectStatus(await legalHold('PUT', before.id), 200, 'legal hold after the export began');

  const both = await community();
  await upload(both, 'one');
  await expectStatus(await legalHold('PUT', both.id), 200, 'legal hold');
  await expectStatus(await host(both.id, 'hold', { deletionNoticeAt: null }), 200, 'hold');
  await startExport(both);

  await drainExports(h.pool, h.blobStore);
  expect(await exportState(before.id)).toBe('ready');
  expect(await exportState(both.id)).toBe('ready');
});

it('finishes the owner’s deletion once the legal hold is released', async () => {
  // Purpose: a release must let the deletion the owner asked for proceed, not drop it.
  const c = await community();
  await upload(c, 'one');
  await expectStatus(await legalHold('PUT', c.id), 200, 'place');
  await ownerDeletesAndItIsDue(c);
  expect(await sweepCommunityDeletions(h.pool, h.blobStore, 100)).toMatchObject({ claimed: 0 });
  await expectStatus(await legalHold('DELETE', c.id), 200, 'release');
  for (let pass = 0; pass < 10 && (await state(c.id)); pass++) {
    await h.pool.query(
      'UPDATE community_deletion_jobs SET next_attempt_at=now() WHERE community_id=$1',
      [c.id]
    );
    await sweepCommunityDeletions(h.pool, h.blobStore, 100);
  }
  expect(await state(c.id)).toBeUndefined();
});
