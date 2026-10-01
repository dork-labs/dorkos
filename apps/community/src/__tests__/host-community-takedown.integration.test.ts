/**
 * A host takes down a whole community (specs/community-host-takedown, task 2.1: AC-8 to AC-13b,
 * community parts). Real PostgreSQL through the tenancy harness, filesystem primary storage and
 * a filesystem evidence store.
 *
 * Two hosts: `h` has an evidence store and an injected clock; `bare` has none. Every community
 * takedown here is made by its own freshly issued key (or, where a person matters, by the host
 * operator), because the per-actor daily limit would otherwise leak between tests.
 */
import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  CommunityAdminDeletionStatusSchema,
  CommunityAdminHostProjectionSchema,
  CommunityAdminTakedownResponseSchema,
  CommunityEvidenceRecordV1Schema,
} from '@dorkos/shared/community-admin-wire';
import { CommunityWireMembershipListResponseSchema } from '@dorkos/shared/community-wire';
import { sweepCommunityDeletions } from '../deletion-worker.js';
import { sweepErasures } from '../erasure/worker.js';
import { sweepExpiredExports } from '../exports/sweep.js';
import { transaction } from '../data.js';
import { createCommunityTakedown } from '../takedown/community.js';
import { FileSystemEvidenceSink } from '../takedown/evidence/sink.js';
import { copyDueTakedownEvidence, EVIDENCE_MAX_FAILURES } from '../takedown/worker.js';
import {
  TENANCY_PASSWORD,
  admit,
  bootstrapHost,
  createPendingCommunity,
  startTenancyHarness,
  type TenancyHarness,
} from './tenancy-test-harness.js';
import { body } from './member-erasure-fixture.js';
import { communityDigest, makeScene, requestErasure, type Scene } from './member-erasure-scenes.js';
import { drainExports, openArchive } from './export-test-helpers.js';

const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;
const EVIDENCE_ROOT = fileURLToPath(new URL('../../.test-evidence/', import.meta.url));
const evidenceDirectory = join(EVIDENCE_ROOT, randomUUID());
let h: TenancyHarness;
let bare: TenancyHarness;
let clockOffsetMs = 0;
const clock = () => new Date(Date.now() + clockOffsetMs);
let operator: { cookie: string; communityId: string };
let bareOperator: { cookie: string; communityId: string };
/** Runs inside a takedown on `h`, after the community lock. */
let lockHook: (() => Promise<void>) | null = null;
let counter = 0;

beforeAll(async () => {
  await mkdir(evidenceDirectory, { recursive: true });
  h = await startTenancyHarness('ctakedown', {
    now: clock,
    env: { COMMUNITY_EVIDENCE_DRIVER: 'filesystem', COMMUNITY_EVIDENCE_PATH: evidenceDirectory },
    hooks: { afterTakedownCommunityLock: async () => lockHook?.() },
  });
  operator = await bootstrapHost(h, 'Hana Host', 'hana@ctakedown.test');
  bare = await startTenancyHarness('ctakedownbare');
  bareOperator = await bootstrapHost(bare, 'Bo Host', 'bo@ctakedown.test');
}, 120_000);

afterEach(() => {
  clockOffsetMs = 0;
  lockHook = null;
  vi.restoreAllMocks();
});

afterAll(async () => {
  await h?.close();
  await bare?.close();
  await rm(evidenceDirectory, { recursive: true, force: true });
});

type Auth = { cookie?: string; bearer?: string };

/** Issue a host key with `scopes`, as the host operator. */
async function issueKey(
  harness: TenancyHarness,
  cookie: string,
  scopes: string[] = ['communities:takedown']
) {
  const issued = await body<{ key: { id: string }; secret: string }>(
    await harness.call('/api/v1/host/api-keys', {
      cookie,
      body: { label: `Key ${++counter}`, scopes, expiresInDays: null, password: TENANCY_PASSWORD },
    }),
    201,
    'issue key'
  );
  return { id: issued.key.id, secret: issued.secret };
}

async function lifecycleVersion(harness: TenancyHarness, communityId: string) {
  return (
    await harness.pool.query<{ lifecycle_version: number }>(
      'SELECT lifecycle_version FROM communities WHERE id=$1',
      [communityId]
    )
  ).rows[0].lifecycle_version;
}

/** Every response body a test read, for the no-content scan. */
const seen: { label: string; text: string }[] = [];

async function read(label: string, response: Response): Promise<Response> {
  seen.push({ label, text: await response.clone().text() });
  return response;
}

/** Ask for a whole-community takedown; the version and suffix are the community's own. */
async function takeDown(
  harness: TenancyHarness,
  communityId: string,
  auth: Auth,
  request: Record<string, unknown> = {}
) {
  const target = {
    kind: 'community',
    lifecycleVersion: await lifecycleVersion(harness, communityId),
    confirmIdSuffix: communityId.slice(-8),
  };
  return read(
    `community takedown ${communityId}`,
    await harness.call(`/api/v1/host/communities/${communityId}/takedowns`, {
      ...auth,
      body: {
        idempotencyKey: `community-${++counter}`,
        target,
        category: 'illegal_content',
        reference: 'CASE-7',
        ...(auth.cookie ? { password: TENANCY_PASSWORD } : {}),
        ...request,
      },
    })
  );
}

async function created(response: Response, status = 201) {
  return CommunityAdminTakedownResponseSchema.parse(await body(response, status, 'takedown'))
    .takedown;
}

async function reverse(
  harness: TenancyHarness,
  takedownId: string,
  communityId: string,
  auth: Auth
) {
  return read(
    `reverse ${takedownId}`,
    await harness.call(`/api/v1/host/takedowns/${takedownId}/reverse`, {
      ...auth,
      body: {
        lifecycleVersion: await lifecycleVersion(harness, communityId),
        ...(auth.cookie ? { password: TENANCY_PASSWORD } : {}),
      },
    })
  );
}

/** Every body read so far that contains one of `needles`, by label. */
function leaks(needles: readonly string[]): string[] {
  return seen
    .filter(({ text }) =>
      needles.some((needle) => text.toLowerCase().includes(needle.toLowerCase()))
    )
    .map(({ label }) => label);
}

/** What the scene's content and people are: nothing a takedown response may carry. */
async function needlesOf(harness: TenancyHarness, s: Scene): Promise<string[]> {
  const people = await harness.pool.query<{ email: string }>(
    `SELECT u.email FROM members m JOIN "user" u ON u.id=m.user_id WHERE m.community_id=$1`,
    [s.communityId]
  );
  return [`hello from ${s.p.handle}`, 'agent note', s.p.handle, ...people.rows.map((r) => r.email)];
}

async function community(harness: TenancyHarness, communityId: string) {
  return (
    await harness.pool.query<{
      lifecycle: string;
      suspended_from_state: string | null;
      held_from_state: string | null;
      takedown_id: string | null;
      delete_requested_at: Date | null;
      delete_after: Date | null;
      delete_requested_by: string | null;
      delete_requested_by_host_actor: string | null;
    }>(
      `SELECT lifecycle,suspended_from_state,held_from_state,takedown_id,delete_requested_at,
              delete_after,delete_requested_by,delete_requested_by_host_actor
       FROM communities WHERE id=$1`,
      [communityId]
    )
  ).rows[0];
}

async function takedownRow(harness: TenancyHarness, id: string) {
  return (
    await harness.pool.query<{
      state: string;
      evidence_state: string;
      evidence_export_id: string | null;
      evidence_failures: number;
      last_error_class: string | null;
      evidence_location: string | null;
      evidence_record_sha256: string | null;
      prior_state: Record<string, unknown>;
    }>(
      `SELECT state,evidence_state,evidence_export_id,evidence_failures,last_error_class,
              evidence_location,evidence_record_sha256,prior_state
       FROM community_takedowns WHERE id=$1`,
      [id]
    )
  ).rows[0];
}

/** Credentials still live in a community: every kind a takedown must revoke. */
async function liveCredentials(harness: TenancyHarness, communityId: string) {
  return (
    await harness.pool.query<{ count: number }>(
      `SELECT (
         (SELECT count(*) FROM connection_grants WHERE community_id=$1 AND revoked_at IS NULL)
         + (SELECT count(*) FROM agent_credentials WHERE community_id=$1 AND revoked_at IS NULL)
         + (SELECT count(*) FROM invites WHERE community_id=$1 AND revoked_at IS NULL)
         + (SELECT count(*) FROM connection_pairings
              WHERE community_id=$1 AND cancelled_at IS NULL AND consumed_at IS NULL)
         + (SELECT count(*) FROM agents WHERE community_id=$1 AND active)
       )::int AS count`,
      [communityId]
    )
  ).rows[0].count;
}

/** Make only this takedown due, so the worker cannot pick one an earlier test left pending. */
async function onlyDue(harness: TenancyHarness, id: string) {
  await harness.pool.query(
    `UPDATE community_takedowns SET next_attempt_at=now()+interval '1 day'
     WHERE id<>$1 AND evidence_state IN ('pending','retrying')`,
    [id]
  );
  await harness.pool.query(
    "UPDATE community_takedowns SET next_attempt_at=now()-interval '1 second' WHERE id=$1",
    [id]
  );
}

/**
 * Run only this community's export jobs. Every takedown in this file queues an evidence export,
 * and most tests never build theirs, so an unscoped drain builds every one an earlier test left
 * queued. That once cost 17 builds in a single test and, under the full suite's load, its whole
 * 30-second budget. Deferring the others by a day keeps each drain to the test's own work.
 */
async function drainExportsOf(harness: TenancyHarness, communityId: string) {
  await harness.pool.query(
    `UPDATE export_archives SET next_attempt_at=now()+interval '1 day'
     WHERE community_id<>$1 AND state IN ('queued','building')`,
    [communityId]
  );
  return drainExports(harness.pool, harness.blobStore);
}

async function copyEvidence(harness: TenancyHarness, id: string) {
  await onlyDue(harness, id);
  return copyDueTakedownEvidence(
    harness.pool,
    harness.blobStore,
    new FileSystemEvidenceSink(evidenceDirectory),
    { warn: () => {} }
  );
}

/** Move a pending deletion's window into the past, so only a gate can stop the worker. */
async function deletionDue(harness: TenancyHarness, communityId: string) {
  await harness.pool.query(
    `UPDATE communities SET delete_requested_at=now()-interval '8 days',
       delete_after=now()-interval '1 day' WHERE id=$1`,
    [communityId]
  );
  await harness.pool.query(
    `UPDATE community_deletion_jobs SET delete_after=now()-interval '1 day',next_attempt_at=now()
     WHERE community_id=$1`,
    [communityId]
  );
}

/** Run the tenant deletion worker until it has nothing left to do; true once it is gone. */
async function runDeletion(harness: TenancyHarness, communityId: string): Promise<boolean> {
  for (let pass = 0; pass < 10; pass++) {
    await harness.pool.query(
      'UPDATE community_deletion_jobs SET next_attempt_at=now() WHERE community_id=$1',
      [communityId]
    );
    await harness.pool.query(
      'UPDATE community_deletion_blob_progress SET next_attempt_at=now() WHERE community_id=$1',
      [communityId]
    );
    const result = await sweepCommunityDeletions(harness.pool, harness.blobStore, 100);
    if (result.completed || !result.claimed) break;
  }
  return !(await harness.pool.query('SELECT 1 FROM communities WHERE id=$1', [communityId]))
    .rowCount;
}

async function evidenceBytes(path: string) {
  return readFile(join(evidenceDirectory, ...path.split('/')));
}

/** Open an event stream and read its named events, bounded per event. */
async function openStream(harness: TenancyHarness, path: string, init: Auth) {
  const response = await harness.call(path, init);
  expect(response.status).toBe(200);
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

async function hostHold(
  harness: TenancyHarness,
  key: string,
  communityId: string,
  notice: Date | null
) {
  await body(
    await harness.call(`/api/v1/host/communities/${communityId}/lifecycle`, {
      bearer: key,
      method: 'PATCH',
      body: {
        action: 'hold',
        lifecycleVersion: await lifecycleVersion(harness, communityId),
        deletionNoticeAt: notice?.toISOString() ?? null,
      },
    }),
    200,
    'hold'
  );
}

async function hostSuspend(harness: TenancyHarness, key: string, communityId: string) {
  await body(
    await harness.call(`/api/v1/host/communities/${communityId}/lifecycle`, {
      bearer: key,
      method: 'PATCH',
      body: { action: 'suspend', lifecycleVersion: await lifecycleVersion(harness, communityId) },
    }),
    200,
    'suspend'
  );
}

describe('a whole-community takedown with an evidence store', () => {
  // Purpose (AC-8, AC-11, AC-12, AC-1): fails if anything stays reachable after the takedown, if
  // a credential survives, if a downloadable export survives, if DorkOS cannot tell a takedown
  // from an ordinary deletion or a suspension, if the evidence is incomplete, if the deletion
  // runs before the evidence is stored, if another community changes, or if any response
  // carries content.
  it('closes everything at once, preserves the whole community, then deletes it', async () => {
    const s = await makeScene(h, operator.cookie, 'whole');
    const other = await makeScene(h, operator.cookie, 'bystander');
    const otherBefore = await communityDigest(h.pool, other.communityId);
    const needles = await needlesOf(h, s);
    // A session the evidence must carry verbatim.
    await h.pool.query(
      `UPDATE session SET "ipAddress"='198.51.100.9',"userAgent"='whole-agent/2.0' WHERE "userId"=$1`,
      [s.p.userId]
    );
    // A ready owner export and one still queued: neither may survive.
    const ready = await body<{ export: { id: string } }>(
      await h.call(`${s.base}/owner/export`, {
        cookie: s.owner.cookie,
        body: { password: TENANCY_PASSWORD },
      }),
      202,
      'owner export'
    );
    await drainExportsOf(h, s.communityId);
    const queued = await body<{ export: { id: string } }>(
      await h.call(`${s.base}/me/export`, { cookie: s.p.cookie, body: {} }),
      202,
      'personal export'
    );
    const counts = (
      await h.pool.query<{ entries: number; members: number; channels: number }>(
        `SELECT (SELECT count(*) FROM entries WHERE community_id=$1)::int AS entries,
                (SELECT count(*) FROM members WHERE community_id=$1)::int AS members,
                (SELECT count(*) FROM channels WHERE community_id=$1)::int AS channels`,
        [s.communityId]
      )
    ).rows[0];
    const stream = await openStream(h, `${s.base}/channels/${s.channelId}/events`, {
      cookie: s.p.cookie,
    });
    expect(await stream.next()).toMatchObject({ event: 'snapshot' });
    expect(await stream.next()).toMatchObject({ event: 'replay_complete' });
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const key = await issueKey(h, operator.cookie);
    const before = Date.now();
    const takedown = await created(await takeDown(h, s.communityId, { bearer: key.secret }));
    expect(takedown).toMatchObject({
      communityId: s.communityId,
      target: { kind: 'community' },
      notify: true,
      state: 'active',
      evidence: { state: 'pending' },
    });
    const window = new Date(takedown.deleteAfter!).getTime() - before;
    expect(window).toBeGreaterThan(72 * HOUR - 60_000);
    expect(window).toBeLessThan(72 * HOUR + 60_000);
    // One warning line for the host's alerting, with ids and no name.
    const lines = warned.mock.calls.map(([line]) => String(line));
    expect(lines.filter((line) => line.includes('community.takedown.community'))).toEqual([
      JSON.stringify({
        event: 'community.takedown.community',
        outcome: 'created',
        communityId: s.communityId,
        actorKind: 'api_key',
        actorId: key.id,
        takedownId: takedown.id,
      }),
    ]);

    // Closed at once, as a pending deletion whose only requester is the host.
    const row = await community(h, s.communityId);
    expect(row).toMatchObject({
      lifecycle: 'deletion_pending',
      takedown_id: takedown.id,
      delete_requested_by: null,
      delete_requested_by_host_actor: `api_key:${key.id}`,
    });
    expect(row.delete_after!.getTime() - row.delete_requested_at!.getTime()).toBe(72 * HOUR);
    expect(await liveCredentials(h, s.communityId)).toBe(0);
    const job = await h.pool.query(
      'SELECT requested_by_member_id,requested_by_host_actor,takedown_id,state FROM community_deletion_jobs WHERE community_id=$1',
      [s.communityId]
    );
    expect(job.rows[0]).toEqual({
      requested_by_member_id: null,
      requested_by_host_actor: `api_key:${key.id}`,
      takedown_id: takedown.id,
      state: 'waiting',
    });
    const exports = await h.pool.query<{ id: string; scope: string; state: string }>(
      'SELECT id,scope,state FROM export_archives WHERE community_id=$1 ORDER BY created_at',
      [s.communityId]
    );
    expect(exports.rows.find((e) => e.id === ready.export.id)).toBeUndefined();
    expect(exports.rows.find((e) => e.id === queued.export.id)?.state).toBe('cancelled');
    const evidenceExport = exports.rows.find((e) => e.scope === 'evidence');
    expect(evidenceExport?.state).toBe('queued');
    expect((await takedownRow(h, takedown.id)).evidence_export_id).toBe(evidenceExport!.id);

    // What DorkOS reads: a distinct refusal on every community route, whatever the credential
    // (the revoked grant and agent answer it before their credential is checked), and a stream closed as
    // taken down.
    for (const [label, path, auth] of [
      ['member', `${s.base}/channels/${s.channelId}/entries`, { cookie: s.p.cookie }],
      ['installation', `${s.base}/me/connection-access`, { bearer: s.grant }],
      ['agent', `${s.base}/channels`, { bearer: s.agent.token }],
      ['stream', `${s.base}/channels/${s.channelId}/events`, { bearer: s.grant }],
    ] as const) {
      const response = await h.call(path, auth);
      expect(response.status, label).toBe(423);
      expect(await response.json(), label).toEqual({
        code: 'COMMUNITY_TAKEN_DOWN',
        message: 'This community was removed by its host.',
      });
    }
    expect(await stream.next()).toMatchObject({
      event: 'closed',
      data: { reason: 'taken_down' },
    });
    await stream.cancel();
    const memberships = CommunityWireMembershipListResponseSchema.parse(
      await body(await h.call('/api/v1/memberships', { cookie: s.p.cookie }), 200, 'memberships')
    ).memberships;
    expect(memberships.find((m) => m.communityId === s.communityId)).toMatchObject({
      lifecycle: 'deletion_pending',
      removedByHost: true,
    });

    // The owner sees who and why, cannot export, and cannot cancel.
    const status = CommunityAdminDeletionStatusSchema.parse(
      await body(
        await h.call(`${s.base}/owner/deletion`, { cookie: s.owner.cookie }),
        200,
        'status'
      )
    );
    expect(status).toMatchObject({
      requestedBy: 'host',
      takedown: { category: 'illegal_content', reference: 'CASE-7', createdAt: takedown.createdAt },
    });
    expect(
      (
        await h.call(`${s.base}/owner/export`, {
          cookie: s.owner.cookie,
          body: { password: TENANCY_PASSWORD },
        })
      ).status
    ).toBe(423);
    const cancel = await h.call(`${s.base}/owner/deletion/cancel`, {
      cookie: s.owner.cookie,
      body: {
        lifecycleVersion: await lifecycleVersion(h, s.communityId),
        password: TENANCY_PASSWORD,
      },
    });
    expect(cancel.status).toBe(409);
    // Nor can the host cancel it as an ordinary deletion: only a reversal undoes a takedown.
    const lifecycleKey = await issueKey(h, operator.cookie, [
      'communities:lifecycle',
      'communities:read',
    ]);
    expect(
      (
        await h.call(`/api/v1/host/communities/${s.communityId}/deletion`, {
          bearer: lifecycleKey.secret,
          method: 'DELETE',
        })
      ).status
    ).toBe(409);
    const projection = CommunityAdminHostProjectionSchema.parse(
      await body(
        await h.call(`/api/v1/host/communities/${s.communityId}`, { bearer: lifecycleKey.secret }),
        200,
        'host projection'
      )
    );
    expect(projection.takedownId).toBe(takedown.id);

    // Not deleted while the evidence is pending, even once the window has passed.
    await deletionDue(h, s.communityId);
    expect(await runDeletion(h, s.communityId)).toBe(false);

    // The evidence export runs in deletion_pending and lands in the store with record.json.
    await drainExportsOf(h, s.communityId);
    expect(await copyEvidence(h, takedown.id)).toEqual({ claimed: true, stored: true });
    const stored = await takedownRow(h, takedown.id);
    expect(stored).toMatchObject({ evidence_state: 'stored', evidence_export_id: null });
    const record = CommunityEvidenceRecordV1Schema.parse(
      JSON.parse((await evidenceBytes(`${stored.evidence_location}record.json`)).toString('utf8'))
    );
    expect(record.community).toEqual({
      id: s.communityId,
      name: `Scene ${s.slug}`,
      lifecycle: 'active',
    });
    expect(record.accounts?.map((a) => a.memberId).sort()).toEqual(
      [s.owner.memberId, s.p.memberId, s.q.memberId].sort()
    );
    const pAccount = record.accounts!.find((a) => a.memberId === s.p.memberId)!.account;
    expect(pAccount.email).toBe(`pat-${s.slug}@x.test`);
    expect(pAccount.sessions).toContainEqual(
      expect.objectContaining({ ipAddress: '198.51.100.9', userAgent: 'whole-agent/2.0' })
    );
    const segments = record.archive!.segments;
    expect(segments.map((segment) => segment.path)).toEqual(
      segments.map((_, index) => `archive.zip.${String(index + 1).padStart(6, '0')}`)
    );
    const archive = await openArchive(
      Buffer.concat(
        await Promise.all(
          segments.map((segment) => evidenceBytes(`${stored.evidence_location}${segment.path}`))
        )
      )
    );
    expect(archive.manifest).toMatchObject({
      version: 2,
      scope: 'evidence',
      requesterMemberId: null,
      community: { id: s.communityId, lifecycle: 'active' },
      counts: { entries: counts.entries, members: counts.members, channels: counts.channels },
    });
    const texts = archive.rows<{ text: string }>('entries').map((entry) => entry.text);
    expect(texts).toContain(`hello from ${s.p.handle}`);
    // The evidence export is gone from primary storage once copied.
    expect(
      (
        await h.pool.query(
          "SELECT 1 FROM export_archives WHERE community_id=$1 AND scope='evidence'",
          [s.communityId]
        )
      ).rowCount
    ).toBe(0);

    // Now the deletion runs, and afterwards the id says deleted.
    expect(await runDeletion(h, s.communityId)).toBe(true);
    const gone = await h.call(`${s.base}/me/connection-access`, { bearer: s.grant });
    expect(gone.status).toBe(410);
    expect((await gone.json()).code).toBe('COMMUNITY_DELETED');
    // The takedown record outlives the community.
    expect((await takedownRow(h, takedown.id)).state).toBe('active');

    expect(await communityDigest(h.pool, other.communityId)).toEqual(otherBefore);
    expect(leaks(needles)).toEqual([]);
  });
});

describe('what a takedown may start from', () => {
  // Purpose (AC-8): fails if a takedown of an unclaimed community, a stale version, a wrong
  // suffix, or a second takedown changes anything, or if a replay repeats the takedown.
  it('refuses a mismatch or an unclaimed community, and replays one key once', async () => {
    const s = await makeScene(h, operator.cookie, 'guard');
    const before = await communityDigest(h.pool, s.communityId);
    const key = await issueKey(h, operator.cookie);
    const pending = await createPendingCommunity(h, operator.cookie, 'Unclaimed whole');
    expect((await takeDown(h, pending.communityId, { bearer: key.secret })).status).toBe(409);
    const version = await lifecycleVersion(h, s.communityId);
    for (const target of [
      {
        kind: 'community',
        lifecycleVersion: version + 1,
        confirmIdSuffix: s.communityId.slice(-8),
      },
      { kind: 'community', lifecycleVersion: version, confirmIdSuffix: 'deadbeef' },
    ]) {
      const refused = await takeDown(h, s.communityId, { bearer: key.secret }, { target });
      expect(refused.status).toBe(409);
    }
    expect(await communityDigest(h.pool, s.communityId)).toEqual(before);

    // AC-13: the same key and body is the same takedown; a different body under it conflicts.
    const request = { idempotencyKey: 'whole-once' };
    const first = await created(await takeDown(h, s.communityId, { bearer: key.secret }, request));
    const replayed = await h.call(`/api/v1/host/communities/${s.communityId}/takedowns`, {
      bearer: key.secret,
      body: {
        idempotencyKey: 'whole-once',
        target: {
          kind: 'community',
          lifecycleVersion: version,
          confirmIdSuffix: s.communityId.slice(-8),
        },
        category: 'illegal_content',
        reference: 'CASE-7',
      },
    });
    expect((await created(replayed, 200)).id).toBe(first.id);
    const conflict = await h.call(`/api/v1/host/communities/${s.communityId}/takedowns`, {
      bearer: key.secret,
      body: {
        idempotencyKey: 'whole-once',
        target: {
          kind: 'community',
          lifecycleVersion: version,
          confirmIdSuffix: s.communityId.slice(-8),
        },
        category: 'terms_violation',
        reference: 'CASE-7',
      },
    });
    expect(conflict.status).toBe(409);
    expect((await conflict.json()).code).toBe('IDEMPOTENCY_CONFLICT');
    const rows = await h.pool.query(
      "SELECT 1 FROM community_takedowns WHERE community_id=$1 AND target_kind='community'",
      [s.communityId]
    );
    expect(rows.rowCount).toBe(1);
    const audits = await h.pool.query(
      "SELECT 1 FROM host_audit_events WHERE community_id=$1 AND action='takedown.create'",
      [s.communityId]
    );
    expect(audits.rowCount).toBe(1);
    expect(
      (
        await h.pool.query(
          "SELECT 1 FROM export_archives WHERE community_id=$1 AND scope='evidence'",
          [s.communityId]
        )
      ).rowCount
    ).toBe(1);
    // A second takedown of a community already taken down, by anyone, is refused.
    const other = await issueKey(h, operator.cookie);
    expect((await takeDown(h, s.communityId, { bearer: other.secret })).status).toBe(409);
  });
});

describe('authority', () => {
  // Purpose (AC-2): fails if a key without the scope, a person without their password, or a key
  // revoked while the takedown waits on the lock could take a community down.
  it('refuses every actor that may not take a community down, and changes nothing', async () => {
    const s = await makeScene(h, operator.cookie, 'wauth');
    const before = await communityDigest(h.pool, s.communityId);
    const reader = await issueKey(h, operator.cookie, [
      'communities:read',
      'communities:lifecycle',
    ]);
    const refusedKey = await takeDown(h, s.communityId, { bearer: reader.secret });
    expect(refusedKey.status).toBe(403);
    const noPassword = await takeDown(
      h,
      s.communityId,
      { cookie: operator.cookie },
      { password: undefined }
    );
    expect(noPassword.status).toBe(403);
    expect((await noPassword.json()).code).toBe('REAUTH_REQUIRED');
    const doomed = await issueKey(h, operator.cookie);
    lockHook = async () => {
      lockHook = null;
      await h.pool.query('UPDATE host_api_keys SET revoked_at=now() WHERE id=$1', [doomed.id]);
    };
    expect((await takeDown(h, s.communityId, { bearer: doomed.secret })).status).toBe(401);
    expect(await communityDigest(h.pool, s.communityId)).toEqual(before);
    expect(
      (
        await h.pool.query('SELECT 1 FROM community_takedowns WHERE community_id=$1', [
          s.communityId,
        ])
      ).rowCount
    ).toBe(0);
  });

  // Purpose (AC-13): fails if a leaked key can take down more communities a day than the
  // limit, if the refused one changes anything, or if a refusal is not logged.
  it('limits one actor to three community takedowns a day, and logs the refusal', async () => {
    const key = await issueKey(h, operator.cookie);
    const scenes: Scene[] = [];
    for (const n of [1, 2, 3, 4]) scenes.push(await makeScene(h, operator.cookie, `rate${n}`));
    for (const s of scenes.slice(0, 3))
      expect((await takeDown(h, s.communityId, { bearer: key.secret })).status).toBe(201);
    const fourth = scenes[3];
    const before = await communityDigest(h.pool, fourth.communityId);
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const refused = await takeDown(h, fourth.communityId, { bearer: key.secret });
    expect(refused.status).toBe(429);
    expect((await refused.json()).code).toBe('RATE_LIMITED');
    expect(Number(refused.headers.get('retry-after'))).toBeGreaterThan(23 * 3600);
    expect(await communityDigest(h.pool, fourth.communityId)).toEqual(before);
    expect(
      warned.mock.calls
        .map(([line]) => String(line))
        .filter((line) => line.includes('community.takedown.community'))
        .map((line) => JSON.parse(line))
    ).toEqual([
      {
        event: 'community.takedown.community',
        outcome: 'rate_limited',
        communityId: fourth.communityId,
        actorKind: 'api_key',
        actorId: key.id,
      },
    ]);
    // Another actor is not limited by this one's takedowns, and a day later this one may again.
    const other = await issueKey(h, operator.cookie);
    expect((await takeDown(h, fourth.communityId, { bearer: other.secret })).status).toBe(201);
    const fifth = await makeScene(h, operator.cookie, 'rate5');
    clockOffsetMs = DAY + 60_000;
    expect((await takeDown(h, fifth.communityId, { bearer: key.secret })).status).toBe(201);
  });
});

describe('the daily limit under parallel requests', () => {
  // Purpose (review): fails if one actor can pass the daily limit by sending its takedowns at
  // the same moment, each counting before any other has committed.
  it('accepts exactly three of four simultaneous takedowns by one key', async () => {
    const key = await issueKey(h, operator.cookie);
    const scenes: Scene[] = [];
    for (const n of [1, 2, 3, 4]) scenes.push(await makeScene(h, operator.cookie, `burst${n}`));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const statuses = await Promise.all(
      scenes.map(async (s) => (await takeDown(h, s.communityId, { bearer: key.secret })).status)
    );
    expect(statuses.sort()).toEqual([201, 201, 201, 429]);
    const made = await h.pool.query(
      "SELECT 1 FROM community_takedowns WHERE actor_api_key_id=$1 AND target_kind='community'",
      [key.id]
    );
    expect(made.rowCount).toBe(3);
  });
});

describe('reversal', () => {
  /** A scene put into `state` before its takedown, by the host or its owner. */
  async function sceneIn(
    label: string,
    state: 'active' | 'archived' | 'held' | 'suspended-held' | 'host-deletion'
  ) {
    const s = await makeScene(h, operator.cookie, label);
    const hostKey = await issueKey(h, operator.cookie, ['communities:lifecycle']);
    if (state === 'archived') {
      await body(
        await h.call(`${s.base}/owner/lifecycle`, {
          cookie: s.owner.cookie,
          body: {
            action: 'archive',
            lifecycleVersion: await lifecycleVersion(h, s.communityId),
            password: TENANCY_PASSWORD,
            confirmName: `Scene ${s.slug}`,
          },
        }),
        200,
        'archive'
      );
    }
    if (state === 'held') await hostHold(h, hostKey.secret, s.communityId, null);
    if (state === 'suspended-held') {
      await hostHold(h, hostKey.secret, s.communityId, null);
      await hostSuspend(h, hostKey.secret, s.communityId);
    }
    if (state === 'host-deletion') {
      await hostHold(h, hostKey.secret, s.communityId, new Date(Date.now() + 15 * DAY));
      clockOffsetMs = 16 * DAY;
      await body(
        await h.call(`/api/v1/host/communities/${s.communityId}/deletion`, {
          bearer: hostKey.secret,
          body: {
            lifecycleVersion: await lifecycleVersion(h, s.communityId),
            confirmIdSuffix: s.communityId.slice(-8),
          },
        }),
        200,
        'host deletion'
      );
    }
    return s;
  }

  // Purpose (AC-9): fails if a reversal returns any starting state to the wrong suspension,
  // drops a hold's origin, reopens the community in one step, restores a credential, leaves the
  // deletion job, or reads as a takedown afterwards. A host suspension is not a takedown.
  it.each([
    ['active', 'active', null],
    ['archived', 'archived', null],
    ['held', 'held', 'active'],
    ['suspended-held', 'held', 'active'],
    ['host-deletion', 'held', 'active'],
  ] as const)(
    'returns a community taken down from %s to suspended from %s',
    async (from, suspendedFrom, heldFrom) => {
      const s = await sceneIn(`rev${from.replace('-', '')}`, from);
      const key = await issueKey(h, operator.cookie);
      const takedown = await created(await takeDown(h, s.communityId, { bearer: key.secret }));
      expect((await takedownRow(h, takedown.id)).prior_state).toMatchObject({
        lifecycle:
          from === 'suspended-held'
            ? 'suspended'
            : from === 'host-deletion'
              ? 'deletion_pending'
              : from,
      });
      const reversed = CommunityAdminTakedownResponseSchema.parse(
        await body(
          await reverse(h, takedown.id, s.communityId, { bearer: key.secret }),
          200,
          'reverse'
        )
      ).takedown;
      expect(reversed).toMatchObject({ id: takedown.id, state: 'reversed' });
      expect(await community(h, s.communityId)).toMatchObject({
        lifecycle: 'suspended',
        suspended_from_state: suspendedFrom,
        held_from_state: heldFrom,
        takedown_id: null,
        delete_after: null,
        delete_requested_by_host_actor: null,
      });
      expect(
        (
          await h.pool.query('SELECT 1 FROM community_deletion_jobs WHERE community_id=$1', [
            s.communityId,
          ])
        ).rowCount
      ).toBe(0);
      expect(await liveCredentials(h, s.communityId)).toBe(0);
      // Suspended now, which DorkOS reads as a pause, not a takedown.
      const suspended = await h.call(`${s.base}/channels`, { bearer: s.grant });
      expect(suspended.status).toBe(503);
      expect((await suspended.json()).code).toBe('COMMUNITY_SUSPENDED');
      const memberships = CommunityWireMembershipListResponseSchema.parse(
        await body(await h.call('/api/v1/memberships', { cookie: s.p.cookie }), 200, 'memberships')
      ).memberships;
      expect(memberships.find((m) => m.communityId === s.communityId)?.removedByHost).toBe(false);
      // A second reversal is refused.
      expect((await reverse(h, takedown.id, s.communityId, { bearer: key.secret })).status).toBe(
        409
      );
    }
  );

  // Purpose (AC-9): fails if a takedown can be reversed after its window, with a stale
  // version, without the scope or the password, or when it took over the owner's own deletion;
  // or if the owner can still cancel that deletion.
  it('refuses a reversal outside its window or its rules', async () => {
    const late = await makeScene(h, operator.cookie, 'late');
    const key = await issueKey(h, operator.cookie);
    const lateDown = await created(await takeDown(h, late.communityId, { bearer: key.secret }));
    const reader = await issueKey(h, operator.cookie, ['communities:read']);
    expect(
      (await reverse(h, lateDown.id, late.communityId, { bearer: reader.secret })).status
    ).toBe(403);
    const noPassword = await h.call(`/api/v1/host/takedowns/${lateDown.id}/reverse`, {
      cookie: operator.cookie,
      body: { lifecycleVersion: await lifecycleVersion(h, late.communityId) },
    });
    expect(noPassword.status).toBe(403);
    expect((await noPassword.json()).code).toBe('REAUTH_REQUIRED');
    const stale = await h.call(`/api/v1/host/takedowns/${lateDown.id}/reverse`, {
      bearer: key.secret,
      body: { lifecycleVersion: (await lifecycleVersion(h, late.communityId)) - 1 },
    });
    expect(stale.status).toBe(409);
    clockOffsetMs = 73 * HOUR;
    expect((await reverse(h, lateDown.id, late.communityId, { bearer: key.secret })).status).toBe(
      409
    );
    expect((await community(h, late.communityId)).lifecycle).toBe('deletion_pending');

    // The owner's own deletion, taken over by a takedown: the owner can no longer cancel it,
    // and the host cannot reverse it into a live community.
    clockOffsetMs = 0;
    const owned = await makeScene(h, operator.cookie, 'owned');
    await body(
      await h.call(`${owned.base}/owner/deletion`, {
        cookie: owned.owner.cookie,
        body: {
          lifecycleVersion: await lifecycleVersion(h, owned.communityId),
          password: TENANCY_PASSWORD,
          confirmName: `Scene ${owned.slug}`,
          confirmIdSuffix: owned.communityId.slice(-8),
        },
      }),
      200,
      'owner deletion'
    );
    const ownedKey = await issueKey(h, operator.cookie);
    const ownedDown = await created(
      await takeDown(h, owned.communityId, { bearer: ownedKey.secret })
    );
    expect(await community(h, owned.communityId)).toMatchObject({
      lifecycle: 'deletion_pending',
      delete_requested_by: null,
      delete_requested_by_host_actor: `api_key:${ownedKey.id}`,
    });
    const cancel = await h.call(`${owned.base}/owner/deletion/cancel`, {
      cookie: owned.owner.cookie,
      body: {
        lifecycleVersion: await lifecycleVersion(h, owned.communityId),
        password: TENANCY_PASSWORD,
      },
    });
    expect(cancel.status).toBe(409);
    expect(
      (await reverse(h, ownedDown.id, owned.communityId, { bearer: ownedKey.secret })).status
    ).toBe(409);
    expect((await community(h, owned.communityId)).takedown_id).toBe(ownedDown.id);
  });

  // Purpose (AC-9): fails if a reversal stops the evidence: an evidence export still being built
  // must finish and be stored on the reversed takedown.
  it('keeps building the evidence after a reversal', async () => {
    const s = await makeScene(h, operator.cookie, 'revev');
    const key = await issueKey(h, operator.cookie);
    const takedown = await created(await takeDown(h, s.communityId, { bearer: key.secret }));
    await body(
      await reverse(h, takedown.id, s.communityId, { bearer: key.secret }),
      200,
      'reverse'
    );
    await drainExportsOf(h, s.communityId);
    expect(await copyEvidence(h, takedown.id)).toEqual({ claimed: true, stored: true });
    expect(await takedownRow(h, takedown.id)).toMatchObject({
      state: 'reversed',
      evidence_state: 'stored',
    });
  });
});

describe('the evidence copy', () => {
  // Purpose (AC-13b, AC-8): fails if a failed evidence export is not replaced, if it is
  // replaced forever, if a retry does not start a new one, or if the relaxed deletion check
  // accepts a window shorter than a day.
  it('replaces a failed evidence export up to five times, then waits for a retry', async () => {
    const s = await makeScene(h, operator.cookie, 'fails');
    const key = await issueKey(h, operator.cookie);
    const takedown = await created(await takeDown(h, s.communityId, { bearer: key.secret }));
    const exportIds = new Set<string>();
    for (let attempt = 1; attempt <= EVIDENCE_MAX_FAILURES; attempt++) {
      const current = (await takedownRow(h, takedown.id)).evidence_export_id!;
      exportIds.add(current);
      await h.pool.query(
        `UPDATE export_archives SET state='failed',failure_code='EXPORT_TIMED_OUT',ended_at=now()
         WHERE id=$1`,
        [current]
      );
      expect(await copyEvidence(h, takedown.id)).toEqual({ claimed: true, stored: false });
      const row = await takedownRow(h, takedown.id);
      expect(row.last_error_class).toBe('EVIDENCE_EXPORT_FAILED');
      expect(row.evidence_state).toBe(attempt < EVIDENCE_MAX_FAILURES ? 'retrying' : 'failed');
    }
    expect(exportIds.size).toBe(EVIDENCE_MAX_FAILURES);
    const open = await h.pool.query(
      "SELECT 1 FROM export_archives WHERE evidence_takedown_id=$1 AND state IN ('queued','building')",
      [takedown.id]
    );
    expect(open.rowCount).toBe(0);
    const retried = CommunityAdminTakedownResponseSchema.parse(
      await body(
        await h.call(`/api/v1/host/takedowns/${takedown.id}/evidence/retry`, {
          bearer: key.secret,
          body: {},
        }),
        200,
        'retry'
      )
    ).takedown;
    expect(retried.evidence.state).toBe('pending');
    await drainExportsOf(h, s.communityId);
    expect(await copyEvidence(h, takedown.id)).toEqual({ claimed: true, stored: true });

    // AC-8: the relaxed check still refuses a takedown window under a day.
    await expect(
      h.pool.query(
        `UPDATE communities SET delete_after=delete_requested_at+interval '23 hours' WHERE id=$1`,
        [s.communityId]
      )
    ).rejects.toThrow(/communities_deletion_state/);
  });

  // Purpose (review): fails if the copy stores an archive with a segment whose blob is gone,
  // which would look complete and not be. The copy fails, a new export is built, and that one
  // is stored.
  it('refuses to copy an evidence export missing a segment', async () => {
    const s = await makeScene(h, operator.cookie, 'gap');
    const key = await issueKey(h, operator.cookie);
    const takedown = await created(await takeDown(h, s.communityId, { bearer: key.secret }));
    await drainExportsOf(h, s.communityId);
    const first = (await takedownRow(h, takedown.id)).evidence_export_id!;
    await h.pool.query(
      `DELETE FROM managed_blobs WHERE blob_key=(
         SELECT blob_key FROM export_segments WHERE export_id=$1 ORDER BY segment_no LIMIT 1)`,
      [first]
    );
    expect(await copyEvidence(h, takedown.id)).toEqual({ claimed: true, stored: false });
    const failed = await takedownRow(h, takedown.id);
    expect(failed).toMatchObject({
      evidence_state: 'retrying',
      last_error_class: 'EVIDENCE_EXPORT_FAILED',
    });
    expect(failed.evidence_export_id).not.toBe(first);
    const attempt = join(evidenceDirectory, 'takedowns', takedown.id, 'attempt-1');
    expect(await readdir(attempt).catch(() => [])).not.toContain('record.json');
    await drainExportsOf(h, s.communityId);
    expect(await copyEvidence(h, takedown.id)).toEqual({ claimed: true, stored: true });
  });

  // Purpose (review, data minimisation): fails if the record keeps a former member who left
  // nothing behind, or keeps a former member's sessions, or drops an active member's.
  it('keeps active members with sessions and former authors without, and nobody else', async () => {
    const s = await makeScene(h, operator.cookie, 'minimal');
    const quiet = await admit(h, s.communityId, s.owner.cookie, {
      name: 'Quiet Former',
      email: `quiet-${s.slug}@x.test`,
    });
    for (const memberId of [s.q.memberId, quiet.memberId])
      expect(
        (
          await h.call(`${s.base}/members/${memberId}`, {
            cookie: s.owner.cookie,
            method: 'DELETE',
          })
        ).status
      ).toBe(204);
    const key = await issueKey(h, operator.cookie);
    const takedown = await created(await takeDown(h, s.communityId, { bearer: key.secret }));
    await drainExportsOf(h, s.communityId);
    expect(await copyEvidence(h, takedown.id)).toEqual({ claimed: true, stored: true });
    const location = (await takedownRow(h, takedown.id)).evidence_location!;
    const record = CommunityEvidenceRecordV1Schema.parse(
      JSON.parse((await evidenceBytes(`${location}record.json`)).toString('utf8'))
    );
    const byMember = new Map(record.accounts!.map((entry) => [entry.memberId, entry.account]));
    expect([...byMember.keys()].sort()).toEqual(
      [s.owner.memberId, s.p.memberId, s.q.memberId].sort()
    );
    expect(byMember.get(s.p.memberId)!.sessions.length).toBeGreaterThan(0);
    expect(byMember.get(s.q.memberId)).toMatchObject({
      email: `quin-${s.slug}@x.test`,
      sessions: [],
    });
  });

  // Purpose (AC-8): fails if a takedown lets an item takedown delete its evidence export, or
  // lets the expiry sweep delete a finished one before it is copied.
  it('keeps the evidence export from every other way exports are deleted', async () => {
    const s = await makeScene(h, operator.cookie, 'keep');
    const key = await issueKey(h, operator.cookie);
    const takedown = await created(await takeDown(h, s.communityId, { bearer: key.secret }));
    await drainExportsOf(h, s.communityId);
    const evidenceId = (await takedownRow(h, takedown.id)).evidence_export_id!;
    await h.pool.query(
      "UPDATE export_archives SET expires_at=now()-interval '1 hour' WHERE id=$1",
      [evidenceId]
    );
    await sweepExpiredExports(h.pool, h.blobStore);
    // An item takedown in the taken-down community deletes every ready export but this one.
    await created(
      await h.call(`/api/v1/host/communities/${s.communityId}/takedowns`, {
        bearer: key.secret,
        body: {
          idempotencyKey: `item-${++counter}`,
          target: { kind: 'entry', entryId: s.pEntryId },
          category: 'illegal_content',
          reference: null,
        },
      })
    );
    const kept = await h.pool.query<{ state: string; deleted_at: Date | null }>(
      'SELECT state,deleted_at FROM export_archives WHERE id=$1',
      [evidenceId]
    );
    expect(kept.rows[0]).toEqual({ state: 'ready', deleted_at: null });
    expect(await copyEvidence(h, takedown.id)).toEqual({ claimed: true, stored: true });
  });
});

describe('a legal hold', () => {
  // Purpose: fails if a legal hold stops a takedown (removal must never wait), or if a
  // takedown's deletion outruns a legal hold once its evidence is stored.
  it('lets a takedown through and still stops its deletion until released', async () => {
    const s = await makeScene(h, operator.cookie, 'legal');
    const holdKey = await issueKey(h, operator.cookie, ['communities:legal_hold']);
    const place = (method: 'PUT' | 'DELETE') =>
      h.call(`/api/v1/host/communities/${s.communityId}/legal-hold`, {
        bearer: holdKey.secret,
        method,
        ...(method === 'PUT' ? { body: { reference: 'LH-1' } } : {}),
      });
    await body(await place('PUT'), 200, 'legal hold');
    const key = await issueKey(h, operator.cookie);
    const takedown = await created(await takeDown(h, s.communityId, { bearer: key.secret }));
    await drainExportsOf(h, s.communityId);
    expect(await copyEvidence(h, takedown.id)).toEqual({ claimed: true, stored: true });
    await deletionDue(h, s.communityId);
    expect(await runDeletion(h, s.communityId)).toBe(false);
    await body(await place('DELETE'), 200, 'release legal hold');
    expect(await runDeletion(h, s.communityId)).toBe(true);
  });
});

describe('erasures wait for a community takedown’s evidence', () => {
  // Purpose (AC-10): fails if a membership erasure in the community, or an account erasure of
  // one of its members, runs while the evidence is not stored, or if the archive misses what
  // the erased member posted.
  it('holds both kinds of erasure until the evidence is stored', async () => {
    const s = await makeScene(h, operator.cookie, 'erase');
    const membership = await requestErasure(h, s.p.cookie, s.communityId);
    const account = await body<{ erasure: { id: string } }>(
      await h.call('/api/v1/account/erasures', {
        cookie: s.q.cookie,
        body: {
          kind: 'account',
          confirmEmail: `quin-${s.slug}@x.test`,
          password: TENANCY_PASSWORD,
        },
      }),
      201,
      'account erasure'
    );
    const key = await issueKey(h, operator.cookie);
    const takedown = await created(await takeDown(h, s.communityId, { bearer: key.secret }));
    const ids = [membership.erasure.id, account.erasure.id];
    // Only these two are due: the worker's clock is past their delay, and any other erasure a
    // test left behind waits a year.
    await h.pool.query(
      `UPDATE erasure_requests SET execute_after=now()+interval '365 days'
       WHERE state IN ('scheduled','running') AND NOT (id=ANY($1::uuid[]))`,
      [ids]
    );
    const later = new Date(Date.now() + 60 * DAY);
    expect((await sweepErasures(h.pool, { now: later })).claimed).toBe(0);
    // P's erasure is due now, and P is told it waits on the host, never why.
    await h.pool.query(
      `UPDATE erasure_requests SET created_at=now()-interval '2 hours',
         execute_after=now()-interval '1 hour' WHERE id=$1`,
      [membership.erasure.id]
    );
    const waiting = async () => {
      const response = await h.call('/api/v1/account/erasures', { cookie: s.p.cookie });
      const text = await response.clone().text();
      expect(text).not.toMatch(/illegal|CASE-7|takedown/i);
      return (
        await body<{ erasures: { id: string; waitingOnHost?: boolean }[] }>(
          response,
          200,
          'erasures'
        )
      ).erasures.find((erasure) => erasure.id === membership.erasure.id);
    };
    expect((await waiting())?.waitingOnHost).toBe(true);
    expect(
      (
        await h.pool.query(
          'SELECT 1 FROM erasure_requests WHERE id=ANY($1::uuid[]) AND started_at IS NOT NULL',
          [ids]
        )
      ).rowCount
    ).toBe(0);
    // DOR-2566: the erasure journal names who was erased only once each erasure finishes.
    const journaled = async () =>
      (
        await h.pool.query<{ kind: string }>(
          `SELECT kind FROM erasure_journal
           WHERE (kind='member' AND community_id=$1 AND member_id=$2)
              OR (kind='member' AND community_id=$1 AND member_id=$3)
              OR (kind='account' AND user_id=$4)
           ORDER BY kind`,
          [s.communityId, s.p.memberId, s.q.memberId, s.q.userId]
        )
      ).rows.map((row) => row.kind);
    expect(await journaled()).toEqual([]);
    await drainExportsOf(h, s.communityId);
    expect(await copyEvidence(h, takedown.id)).toEqual({ claimed: true, stored: true });
    expect((await waiting())?.waitingOnHost).toBe(false);
    const location = (await takedownRow(h, takedown.id)).evidence_location!;
    const record = CommunityEvidenceRecordV1Schema.parse(
      JSON.parse((await evidenceBytes(`${location}record.json`)).toString('utf8'))
    );
    const archive = await openArchive(
      Buffer.concat(
        await Promise.all(
          record.archive!.segments.map((segment) => evidenceBytes(`${location}${segment.path}`))
        )
      )
    );
    expect(archive.rows<{ text: string }>('entries').map((entry) => entry.text)).toContain(
      `hello from ${s.p.handle}`
    );
    for (let pass = 0; pass < 2; pass++) await sweepErasures(h.pool, { now: later });
    const started = await h.pool.query<{ id: string }>(
      'SELECT id FROM erasure_requests WHERE id=ANY($1::uuid[]) AND started_at IS NOT NULL',
      [ids]
    );
    expect(started.rows.map((row) => row.id).sort()).toEqual([...ids].sort());
    // Once they finish, each erasure the takedown held is journaled like any other: P's
    // membership, and Q's account with Q's membership in it.
    for (let pass = 0; pass < 10; pass++) await sweepErasures(h.pool, { now: later });
    expect(
      (
        await h.pool.query<{ state: string }>(
          'SELECT state FROM erasure_requests WHERE id=ANY($1::uuid[])',
          [ids]
        )
      ).rows.map((row) => row.state)
    ).toEqual(['completed', 'completed']);
    expect(await journaled()).toEqual(['account', 'member', 'member']);
  });
});

describe('a whole-community takedown with no evidence store', () => {
  // Purpose (AC-8b, AC-11): fails if child_safety material is deleted without a copy or a
  // person's release, if a key or a person without a password can release it, if the owner is
  // told of a withheld takedown, or if another category waits for a copy that will never come.
  it('holds child_safety until a person releases it; other categories delete after the window', async () => {
    const held = await makeScene(bare, bareOperator.cookie, 'bareheld');
    const key = await issueKey(bare, bareOperator.cookie);
    const takedown = await created(
      await takeDown(
        bare,
        held.communityId,
        { bearer: key.secret },
        { category: 'child_safety', reference: null }
      )
    );
    expect(takedown).toMatchObject({ notify: false, evidence: { state: 'held_on_primary' } });
    expect(
      (
        await bare.pool.query('SELECT 1 FROM export_archives WHERE community_id=$1', [
          held.communityId,
        ])
      ).rowCount
    ).toBe(0);
    const staged = await bare.pool.query<{ record: { accounts: { memberId: string }[] } }>(
      'SELECT record FROM takedown_evidence_staging WHERE takedown_id=$1',
      [takedown.id]
    );
    expect(staged.rows[0].record.accounts.map((a) => a.memberId)).toContain(held.p.memberId);
    // Withheld: the owner sees a host deletion, and not why.
    const status = CommunityAdminDeletionStatusSchema.parse(
      await body(
        await bare.call(`${held.base}/owner/deletion`, { cookie: held.owner.cookie }),
        200,
        'status'
      )
    );
    expect(status).toMatchObject({ requestedBy: 'host', takedown: null });
    // The window passes; the community stays.
    await deletionDue(bare, held.communityId);
    expect(await runDeletion(bare, held.communityId)).toBe(false);
    const release = (auth: Auth, requestBody: Record<string, unknown>) =>
      bare.call(`/api/v1/host/takedowns/${takedown.id}/release-held`, {
        ...auth,
        body: requestBody,
      });
    expect((await release({ bearer: key.secret }, {})).status).toBe(403);
    const noPassword = await release({ cookie: bareOperator.cookie }, {});
    expect(noPassword.status).toBe(403);
    expect((await noPassword.json()).code).toBe('REAUTH_REQUIRED');
    // A legal hold keeps the material even from a person with their password.
    const holdKey = await issueKey(bare, bareOperator.cookie, ['communities:legal_hold']);
    await body(
      await bare.call(`/api/v1/host/communities/${held.communityId}/legal-hold`, {
        bearer: holdKey.secret,
        method: 'PUT',
        body: { reference: null },
      }),
      200,
      'legal hold'
    );
    const underHold = await release(
      { cookie: bareOperator.cookie },
      { password: TENANCY_PASSWORD }
    );
    expect(underHold.status).toBe(409);
    expect((await underHold.json()).code).toBe('LEGAL_HOLD_ACTIVE');
    await body(
      await bare.call(`/api/v1/host/communities/${held.communityId}/legal-hold`, {
        bearer: holdKey.secret,
        method: 'DELETE',
      }),
      200,
      'release legal hold'
    );
    const released = CommunityAdminTakedownResponseSchema.parse(
      await body(
        await release({ cookie: bareOperator.cookie }, { password: TENANCY_PASSWORD }),
        200,
        'release'
      )
    ).takedown;
    expect(released.evidence.state).toBe('not_configured');
    expect(await runDeletion(bare, held.communityId)).toBe(true);

    const terms = await makeScene(bare, bareOperator.cookie, 'bareterms');
    const termsDown = await created(
      await takeDown(
        bare,
        terms.communityId,
        { bearer: key.secret },
        { category: 'terms_violation' }
      )
    );
    expect(termsDown).toMatchObject({ notify: true, evidence: { state: 'not_configured' } });
    expect(
      (
        await bare.pool.query('SELECT 1 FROM takedown_evidence_staging WHERE takedown_id=$1', [
          termsDown.id,
        ])
      ).rowCount
    ).toBe(0);
    expect(await runDeletion(bare, terms.communityId)).toBe(false);
    await deletionDue(bare, terms.communityId);
    expect(await runDeletion(bare, terms.communityId)).toBe(true);
  });

  // Purpose (AC-8b): fails if configuring a store and retrying does not preserve a community
  // held without one, or lets its deletion run before the copy is stored.
  it('copies a held community once a store exists and it is retried', async () => {
    const s = await makeScene(h, operator.cookie, 'latestore');
    const operatorActor = await h.pool.query<{ id: string; name: string }>(
      `SELECT u.id,u.name FROM host_operators o JOIN "user" u ON u.id=o.user_id LIMIT 1`
    );
    // Made as a host with no store would make it: then the host sets one up.
    const version = await lifecycleVersion(h, s.communityId);
    const { row } = await transaction(h.pool, (client) =>
      createCommunityTakedown(client, {
        communityId: s.communityId,
        actor: {
          kind: 'person',
          userId: operatorActor.rows[0].id,
          name: operatorActor.rows[0].name,
        },
        target: {
          kind: 'community',
          lifecycleVersion: version,
          confirmIdSuffix: s.communityId.slice(-8),
        },
        idempotencyKey: `late-store-${++counter}`,
        category: 'legal_order',
        reference: null,
        notify: true,
        evidenceStore: false,
        publicUrl: h.config.publicUrl,
        now: new Date(),
        reversalHours: 72,
        communitiesPerDay: 3,
        warn: () => {},
      })
    );
    expect(row.evidence_state).toBe('held_on_primary');
    await deletionDue(h, s.communityId);
    const key = await issueKey(h, operator.cookie);
    await body(
      await h.call(`/api/v1/host/takedowns/${row.id}/evidence/retry`, {
        bearer: key.secret,
        body: {},
      }),
      200,
      'retry'
    );
    expect(await runDeletion(h, s.communityId)).toBe(false);
    await drainExportsOf(h, s.communityId);
    expect(await copyEvidence(h, row.id)).toEqual({ claimed: true, stored: true });
    const location = (await takedownRow(h, row.id)).evidence_location!;
    const names = await readdir(join(evidenceDirectory, ...location.split('/').filter(Boolean)));
    expect(names).toContain('record.json');
    expect(names).toContain('archive.zip.000001');
    expect(await runDeletion(h, s.communityId)).toBe(true);
  });
});

describe('a host suspension is not a takedown', () => {
  // Purpose: fails if DorkOS could mistake a suspension for a takedown: a suspended community
  // must answer COMMUNITY_SUSPENDED, never COMMUNITY_TAKEN_DOWN, and never read as removed.
  it('answers COMMUNITY_SUSPENDED and is not removed by its host', async () => {
    const s = await makeScene(h, operator.cookie, 'pause');
    const key = await issueKey(h, operator.cookie, ['communities:lifecycle']);
    await hostSuspend(h, key.secret, s.communityId);
    const response = await h.call(`${s.base}/channels`, { cookie: s.p.cookie });
    expect(response.status).toBe(503);
    expect((await response.json()).code).toBe('COMMUNITY_SUSPENDED');
    const memberships = CommunityWireMembershipListResponseSchema.parse(
      await body(await h.call('/api/v1/memberships', { cookie: s.p.cookie }), 200, 'memberships')
    ).memberships;
    expect(memberships.find((m) => m.communityId === s.communityId)?.removedByHost).toBe(false);
  });
});
