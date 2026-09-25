/**
 * A host takes down one message, one file, or a community's icon (specs/community-host-takedown,
 * task 1.1, AC-1 to AC-7, AC-6b to AC-6d, AC-11 to AC-15). Real PostgreSQL through the tenancy
 * harness, filesystem primary storage, a filesystem evidence store, and an S3 evidence sink whose
 * client is a stub that records every call and accepts only `PutObject`.
 *
 * Two hosts: `h` has an evidence store and an injected clock; `bare` has none.
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { strFromU8, unzipSync } from 'fflate';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CommunityAdminTakedownListSchema,
  CommunityAdminTakedownResponseSchema,
  CommunityEvidenceRecordV1Schema,
} from '@dorkos/shared/community-admin-wire';
import {
  CommunityWireEntrySchema,
  CommunityWireTakedownNoticeListResponseSchema,
  type CommunityWireEntry,
} from '@dorkos/shared/community-wire';
import { REMOVED_ENTRY_TEXT } from '../content-removal.js';
import { sweepCommunityDeletions } from '../deletion-worker.js';
import { ERASED_ENTRY_TEXT, eraseMembership } from '../erasure/erasure.js';
import {
  FileSystemEvidenceSink,
  S3EvidenceSink,
  type EvidenceSink,
} from '../takedown/evidence/sink.js';
import { sweepPendingBlobDeletions } from '../storage/pending-deletions.js';
import { runTakedownCommand } from '../takedown/commands.js';
import {
  copyDueTakedownEvidence,
  EVIDENCE_MAX_FAILURES,
  warnOverdueTakedownEvidence,
} from '../takedown/worker.js';
import {
  TENANCY_PASSWORD,
  bootstrapHost,
  createPendingCommunity,
  expectStatus,
  holdingLock,
  startTenancyHarness,
  waitForLockWaiters,
  type TenancyHarness,
} from './tenancy-test-harness.js';
import {
  body,
  drainCleanup,
  hoursFromNow,
  post,
  runErasures,
  scanBlobs,
  scanDatabase,
  sha256,
  storageDirectory,
  upload,
} from './member-erasure-fixture.js';
import { communityDigest, makeScene, requestErasure, type Scene } from './member-erasure-scenes.js';

const DAY = 24 * 60 * 60_000;
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
const keys = {} as Record<'takedown' | 'read' | 'all' | 'other', { id: string; secret: string }>;
let bareKey: { id: string; secret: string };
let counter = 0;

beforeAll(async () => {
  await mkdir(evidenceDirectory, { recursive: true });
  h = await startTenancyHarness('takedown', {
    now: clock,
    env: { COMMUNITY_EVIDENCE_DRIVER: 'filesystem', COMMUNITY_EVIDENCE_PATH: evidenceDirectory },
    hooks: { afterTakedownCommunityLock: async () => lockHook?.() },
  });
  operator = await bootstrapHost(h, 'Hana Host', 'hana@host.test');
  bare = await startTenancyHarness('takedownbare');
  bareOperator = await bootstrapHost(bare, 'Bo Host', 'bo@host.test');
  keys.takedown = await issueKey(h, operator.cookie, ['communities:takedown']);
  keys.other = await issueKey(h, operator.cookie, ['communities:takedown']);
  keys.read = await issueKey(h, operator.cookie, ['communities:read']);
  keys.all = await issueKey(h, operator.cookie, [
    'communities:read',
    'communities:write',
    'communities:lifecycle',
    'communities:import',
    'communities:takedown',
  ]);
  bareKey = await issueKey(bare, bareOperator.cookie, ['communities:takedown', 'communities:read']);
}, 120_000);

afterAll(async () => {
  await h?.close();
  await bare?.close();
  await rm(evidenceDirectory, { recursive: true, force: true });
});

async function issueKey(harness: TenancyHarness, cookie: string, scopes: string[]) {
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

type Auth = { cookie?: string; bearer?: string };
type TakedownBody = {
  idempotencyKey?: string;
  target: Record<string, unknown>;
  category?: string;
  reference?: string | null;
  notify?: boolean;
  password?: string;
};

/** Every response body a test read, for the no-content scan. */
const seen: { label: string; text: string }[] = [];

async function read(label: string, response: Response): Promise<Response> {
  seen.push({ label, text: await response.clone().text() });
  return response;
}

function takedown(harness: TenancyHarness, communityId: string, auth: Auth, request: TakedownBody) {
  const withPassword = auth.cookie && !('password' in request);
  return harness
    .call(`/api/v1/host/communities/${communityId}/takedowns`, {
      ...auth,
      body: {
        idempotencyKey: `takedown-${++counter}`,
        category: 'illegal_content',
        reference: null,
        ...request,
        ...(withPassword ? { password: TENANCY_PASSWORD } : {}),
      },
    })
    .then((response) => read(`takedown ${JSON.stringify(request.target)}`, response));
}

async function created(response: Response, status = 201) {
  return CommunityAdminTakedownResponseSchema.parse(await body(response, status, 'takedown'))
    .takedown;
}

async function hostCall(
  harness: TenancyHarness,
  path: string,
  auth: Auth,
  requestBody?: Record<string, unknown>
) {
  return read(path, await harness.call(`/api/v1/host${path}`, { ...auth, body: requestBody }));
}

/** A scene with P's canary message, which carries one canary file. */
interface Canary {
  s: Scene;
  entryId: string;
  attachmentId: string;
  text: string;
  fileName: string;
  bytes: string;
  checksum: string;
  /** Everything that says what was removed or who posted it. */
  needles: string[];
  /** Only what the content itself was, which primary storage must lose. */
  content: string[];
  email: string;
  name: string;
}

async function canary(harness: TenancyHarness, cookie: string, label: string): Promise<Canary> {
  const s = await makeScene(harness, cookie, label);
  const text = `canary-text-${s.slug}`;
  const fileName = `canary-${s.slug}.txt`;
  const bytes = `canary-bytes-${s.slug}`;
  const attachmentId = await upload(
    harness,
    s.communityId,
    s.channelId,
    s.p.cookie,
    fileName,
    bytes
  );
  const entry = await post(
    harness,
    s.communityId,
    s.channelId,
    { cookie: s.p.cookie },
    {
      text,
      idempotencyKey: `canary-${s.slug}`,
      attachmentIds: [attachmentId],
    }
  );
  const account = await harness.pool.query<{ name: string; email: string }>(
    'SELECT u.name,u.email FROM "user" u WHERE u.id=$1',
    [s.p.userId]
  );
  // What a sign-in stores, set to values the record must carry verbatim.
  await harness.pool.query(
    `UPDATE session SET "ipAddress"='203.0.113.7',"userAgent"='canary-agent/1.0 ${s.slug}'
     WHERE "userId"=$1`,
    [s.p.userId]
  );
  const checksum = sha256(bytes);
  return {
    s,
    entryId: entry.id,
    attachmentId,
    text,
    fileName,
    bytes,
    checksum,
    needles: [
      text,
      fileName,
      bytes,
      checksum,
      account.rows[0].name,
      s.p.handle,
      account.rows[0].email,
    ],
    content: [text, fileName, bytes, checksum],
    email: account.rows[0].email,
    name: account.rows[0].name,
  };
}

/** Every body read so far that contains one of `needles`, by label. */
function leaks(needles: readonly string[]): string[] {
  return seen
    .filter(({ text }) =>
      needles.some((needle) => text.toLowerCase().includes(needle.toLowerCase()))
    )
    .map(({ label }) => label);
}

async function history(harness: TenancyHarness, s: Scene, cookie: string) {
  return (
    await body<{ entries: CommunityWireEntry[] }>(
      await harness.call(`${s.base}/channels/${s.channelId}/entries`, { cookie }),
      200,
      'history'
    )
  ).entries;
}

async function blobState(harness: TenancyHarness, key: string) {
  return (
    await harness.pool.query<{ state: string; committed_at: Date | null }>(
      'SELECT state,committed_at FROM managed_blobs WHERE blob_key=$1',
      [key]
    )
  ).rows[0];
}

async function takedownRow(harness: TenancyHarness, id: string) {
  return (
    await harness.pool.query<{
      evidence_state: string;
      evidence_attempts: number;
      evidence_failures: number;
      last_error_class: string | null;
      evidence_record_sha256: string | null;
      evidence_location: string | null;
    }>(
      `SELECT evidence_state,evidence_attempts,evidence_failures,last_error_class,
              evidence_record_sha256,evidence_location FROM community_takedowns WHERE id=$1`,
      [id]
    )
  ).rows[0];
}

/** Make a takedown's next evidence attempt due now. */
async function due(harness: TenancyHarness, id: string) {
  await harness.pool.query(
    "UPDATE community_takedowns SET next_attempt_at=now()-interval '1 second' WHERE id=$1",
    [id]
  );
}

/** Make only this takedown due, so the worker cannot pick one an earlier test left pending. */
async function onlyDue(harness: TenancyHarness, id: string) {
  await harness.pool.query(
    `UPDATE community_takedowns SET next_attempt_at=now()+interval '1 day'
     WHERE id<>$1 AND evidence_state IN ('pending','retrying')`,
    [id]
  );
  await due(harness, id);
}

const fsSink = () => new FileSystemEvidenceSink(evidenceDirectory);

async function copyEvidence(harness: TenancyHarness, sink: EvidenceSink = fsSink()) {
  return copyDueTakedownEvidence(harness.pool, harness.blobStore, sink, { warn: () => {} });
}

/** A sink that fails every write, as a store that is down would. */
const downSink: EvidenceSink = {
  put: async () => {
    throw new Error('store down');
  },
};

async function evidenceFile(path: string) {
  return readFile(join(evidenceDirectory, ...path.split('/')));
}

async function ownerExport(harness: TenancyHarness, s: Scene) {
  return (
    await body<{ archiveId: string }>(
      await harness.call(`${s.base}/owner/export`, {
        cookie: s.owner.cookie,
        body: { password: TENANCY_PASSWORD },
      }),
      201,
      'owner export'
    )
  ).archiveId;
}

async function lifecycleVersion(harness: TenancyHarness, communityId: string) {
  return (
    await harness.pool.query<{ lifecycle_version: number }>(
      'SELECT lifecycle_version FROM communities WHERE id=$1',
      [communityId]
    )
  ).rows[0].lifecycle_version;
}

/** Ask for the owner's own deletion and move it seven days on, so only a gate could stop it. */
async function ownerDeletionDue(harness: TenancyHarness, s: Scene) {
  const name = (
    await harness.pool.query<{ name: string }>('SELECT name FROM communities WHERE id=$1', [
      s.communityId,
    ])
  ).rows[0].name;
  await body(
    await harness.call(`${s.base}/owner/deletion`, {
      cookie: s.owner.cookie,
      body: {
        lifecycleVersion: await lifecycleVersion(harness, s.communityId),
        password: TENANCY_PASSWORD,
        confirmName: name,
        confirmIdSuffix: s.communityId.slice(-8),
      },
    }),
    200,
    'owner deletion'
  );
  await deletionDue(harness, s.communityId);
}

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

/** Run the tenant deletion worker until it has nothing left to do; true once A is gone. */
async function runDeletion(harness: TenancyHarness, communityId: string): Promise<boolean> {
  for (let pass = 0; pass < 10; pass++) {
    await harness.pool.query(
      `UPDATE community_deletion_jobs SET next_attempt_at=now() WHERE community_id=$1`,
      [communityId]
    );
    await harness.pool.query(
      `UPDATE community_deletion_blob_progress SET next_attempt_at=now() WHERE community_id=$1`,
      [communityId]
    );
    const result = await sweepCommunityDeletions(harness.pool, harness.blobStore, 100);
    if (result.completed) break;
    if (!result.claimed) break;
  }
  return !(await harness.pool.query('SELECT 1 FROM communities WHERE id=$1', [communityId]))
    .rowCount;
}

describe('authority', () => {
  // Purpose: fails if a key without the scope, a person without their password, a revoked key,
  // or a key trying to mint the scope could take anything down or change any row.
  it('refuses every actor that may not take down, and changes nothing', async () => {
    const c = await canary(h, operator.cookie, 'auth');
    const target = { kind: 'entry', entryId: c.entryId };
    const before = await communityDigest(h.pool, c.s.communityId);
    const refusals: [Auth, TakedownBody, number, string][] = [
      [{ bearer: keys.read.secret }, { target }, 403, 'FORBIDDEN'],
      [{ cookie: operator.cookie }, { target, password: undefined }, 403, 'REAUTH_REQUIRED'],
      [{ cookie: operator.cookie }, { target, password: 'not-the-password' }, 403, 'REAUTH_FAILED'],
      [
        { bearer: keys.takedown.secret },
        { target, password: TENANCY_PASSWORD },
        400,
        'STATE_CONFLICT',
      ],
      [{ cookie: c.s.owner.cookie }, { target, password: TENANCY_PASSWORD }, 403, 'FORBIDDEN'],
      [{}, { target }, 401, 'UNAUTHENTICATED'],
    ];
    for (const [auth, request, status, code] of refusals) {
      const response = await takedown(h, c.s.communityId, auth, request);
      expect({ status: response.status, code: (await response.json()).code }).toEqual({
        status,
        code,
      });
    }
    // A key revoked while the takedown waits on the community lock loses.
    const doomed = await issueKey(h, operator.cookie, ['communities:takedown']);
    lockHook = async () => {
      lockHook = null;
      await h.pool.query('UPDATE host_api_keys SET revoked_at=now() WHERE id=$1', [doomed.id]);
    };
    expect((await takedown(h, c.s.communityId, { bearer: doomed.secret }, { target })).status).toBe(
      401
    );
    // Keys still never issue keys, with this scope or any other.
    const minted = await h.call('/api/v1/host/api-keys', {
      bearer: keys.all.secret,
      body: {
        label: 'Self',
        scopes: ['communities:takedown'],
        expiresInDays: null,
        password: TENANCY_PASSWORD,
      },
    });
    expect(minted.status).toBe(403);
    expect(await communityDigest(h.pool, c.s.communityId)).toEqual(before);
    expect(
      (
        await h.pool.query('SELECT 1 FROM community_takedowns WHERE community_id=$1', [
          c.s.communityId,
        ])
      ).rowCount
    ).toBe(0);
    // A key with all five scopes still reaches no content route.
    for (const path of [
      `${c.s.base}/channels/${c.s.channelId}/entries`,
      `${c.s.base}/attachments/${c.attachmentId}`,
      `${c.s.base}/takedowns`,
    ])
      expect((await h.call(path, { bearer: keys.all.secret })).status).toBe(401);
    expect(leaks(c.needles)).toEqual([]);
  });

  // Purpose: fails if an id from another community, or a pending community, could be taken down.
  it('answers 404 for another community’s ids and 409 for an unclaimed community', async () => {
    const a = await canary(h, operator.cookie, 'isoa');
    const b = await canary(h, operator.cookie, 'isob');
    const bBefore = await communityDigest(h.pool, b.s.communityId);
    for (const target of [
      { kind: 'entry', entryId: b.entryId },
      { kind: 'attachment', attachmentId: b.attachmentId },
      { kind: 'entry', entryId: randomUUID() },
    ]) {
      const response = await takedown(
        h,
        a.s.communityId,
        { bearer: keys.takedown.secret },
        {
          target,
        }
      );
      expect(response.status).toBe(404);
    }
    const pending = await createPendingCommunity(h, operator.cookie, 'Unclaimed takedown');
    expect(
      (
        await takedown(
          h,
          pending.communityId,
          { bearer: keys.takedown.secret },
          {
            target: { kind: 'icon' },
          }
        )
      ).status
    ).toBe(409);
    expect(
      (
        await takedown(
          h,
          a.s.communityId,
          { bearer: keys.takedown.secret },
          {
            target: { kind: 'community', lifecycleVersion: 1, confirmIdSuffix: 'abcdefgh' },
          }
        )
      ).status
    ).toBe(409);
    expect(await communityDigest(h.pool, b.s.communityId)).toEqual(bBefore);
    expect(leaks([...a.needles, ...b.needles])).toEqual([]);
  });
});

describe('an item takedown with an evidence store', () => {
  // Purpose (AC-1, AC-3, AC-4, AC-12, AC-13, AC-15): fails if the message or file stays
  // readable anywhere, if a ready export survives, if the audits are missing, if the evidence is
  // partial or unverifiable, if primary storage keeps any of the content afterwards, if a replay
  // repeats anything, or if any takedown response carries content.
  it('hides at once, copies everything to the store, then leaves primary clean', async () => {
    const c = await canary(h, operator.cookie, 'main');
    const other = await canary(h, operator.cookie, 'bystander');
    const otherBefore = await communityDigest(h.pool, other.s.communityId);
    const archiveId = await ownerExport(h, c.s);
    const exportKey = (
      await h.pool.query<{ blob_key: string }>('SELECT blob_key FROM export_archives WHERE id=$1', [
        archiveId,
      ])
    ).rows[0].blob_key;
    const fileKey = (
      await h.pool.query<{ blob_key: string }>('SELECT blob_key FROM attachments WHERE id=$1', [
        c.attachmentId,
      ])
    ).rows[0].blob_key;
    const committedAt = (await blobState(h, fileKey)).committed_at;
    const redactionsBefore = (
      await h.pool.query('SELECT 1 FROM entry_redactions WHERE entry_id=$1', [c.entryId])
    ).rowCount;
    const request = {
      idempotencyKey: 'main-case-1',
      target: { kind: 'entry', entryId: c.entryId },
      reference: 'CASE-1',
    };
    const first = await created(
      await takedown(h, c.s.communityId, { bearer: keys.takedown.secret }, request)
    );
    expect(first).toMatchObject({
      communityId: c.s.communityId,
      target: { kind: 'entry', entryId: c.entryId },
      category: 'illegal_content',
      reference: 'CASE-1',
      notify: true,
      actor: { kind: 'api_key', id: keys.takedown.id },
      state: 'active',
      evidence: { state: 'pending', recordSha256: null, location: null, attempts: 0 },
    });

    // Members see the host tombstone, with no mentions and no files, at once.
    for (const cookie of [c.s.q.cookie, c.s.owner.cookie, c.s.p.cookie]) {
      const shown = (await history(h, c.s, cookie)).find((entry) => entry.id === c.entryId)!;
      expect(CommunityWireEntrySchema.parse(shown)).toMatchObject({
        text: REMOVED_ENTRY_TEXT.host,
        mentions: [],
        attachments: [],
      });
    }
    for (const auth of [
      { cookie: c.s.p.cookie },
      { cookie: c.s.owner.cookie },
      { cookie: c.s.q.cookie },
      { bearer: c.s.grant },
    ])
      expect((await h.call(`${c.s.base}/attachments/${c.attachmentId}`, auth)).status).toBe(404);
    expect(
      (await h.call(`${c.s.base}/attachments/${c.attachmentId}`, { bearer: keys.all.secret }))
        .status
    ).toBe(401);
    expect(
      (await h.pool.query('SELECT 1 FROM entry_redactions WHERE entry_id=$1', [c.entryId])).rowCount
    ).toBe(redactionsBefore! + 1);
    // The ready export is gone, and its bytes are queued.
    expect(
      (await h.call(`${c.s.base}/exports/${archiveId}`, { cookie: c.s.owner.cookie })).status
    ).toBe(404);
    expect((await blobState(h, exportKey)).state).toBe('pending_delete');
    // The file's bytes are held, still committed, for the copy.
    expect(await blobState(h, fileKey)).toEqual({
      state: 'evidence_hold',
      committed_at: committedAt,
    });
    // One host audit row and one community audit row, neither with content.
    const hostAudit = await h.pool.query(
      `SELECT actor_kind,actor_api_key_id,action,changed_fields,next_state FROM host_audit_events
       WHERE community_id=$1 AND action LIKE 'takedown.%'`,
      [c.s.communityId]
    );
    expect(hostAudit.rows).toEqual([
      {
        actor_kind: 'api_key',
        actor_api_key_id: keys.takedown.id,
        action: 'takedown.create',
        changed_fields: ['entry', 'notified'],
        next_state: 'pending',
      },
    ]);
    const tenantAudit = await h.pool.query(
      `SELECT actor_kind,actor_member_id,action,subject_id,withheld FROM audit_events
       WHERE community_id=$1 AND action LIKE '%.takedown'`,
      [c.s.communityId]
    );
    expect(tenantAudit.rows).toEqual([
      {
        actor_kind: 'host',
        actor_member_id: null,
        action: 'entry.takedown',
        subject_id: c.entryId,
        withheld: false,
      },
    ]);

    // A replay returns the same takedown with 200 and does nothing again.
    const replay = await created(
      await takedown(h, c.s.communityId, { bearer: keys.takedown.secret }, request),
      200
    );
    expect(replay.id).toBe(first.id);
    expect(
      (
        await h.pool.query(
          "SELECT 1 FROM host_audit_events WHERE action='takedown.create' AND community_id=$1",
          [c.s.communityId]
        )
      ).rowCount
    ).toBe(1);
    const conflict = await takedown(
      h,
      c.s.communityId,
      { bearer: keys.takedown.secret },
      {
        ...request,
        target: { kind: 'attachment', attachmentId: other.attachmentId },
      }
    );
    expect(conflict.status).toBe(409);
    expect((await conflict.json()).code).toBe('IDEMPOTENCY_CONFLICT');
    // The same key from another actor is its own takedown.
    const separate = await created(
      await takedown(h, c.s.communityId, { bearer: keys.other.secret }, request)
    );
    expect(separate.id).not.toBe(first.id);
    expect(separate.evidence.state).toBe('nothing_to_preserve');

    // The worker copies the file, then writes record.json last.
    expect(await copyEvidence(h)).toEqual({ claimed: true, stored: true });
    const folder = `takedowns/${first.id}/attempt-1/`;
    const recordBytes = await evidenceFile(`${folder}record.json`);
    const record = CommunityEvidenceRecordV1Schema.parse(JSON.parse(recordBytes.toString('utf8')));
    const sessions = await h.pool.query<{ createdAt: Date; ipAddress: string; userAgent: string }>(
      `SELECT "createdAt","ipAddress","userAgent" FROM session
       WHERE "userId"=$1 AND "expiresAt">now() ORDER BY "createdAt",id`,
      [c.s.p.userId]
    );
    expect(sessions.rows.length).toBeGreaterThan(0);
    expect(record).toMatchObject({
      takedown: {
        id: first.id,
        actor: { kind: 'api_key', id: keys.takedown.id, name: null },
        category: 'illegal_content',
        reference: 'CASE-1',
        notify: true,
      },
      server: { publicUrl: h.config.publicUrl },
      community: { id: c.s.communityId, lifecycle: 'active' },
      channel: { id: c.s.channelId, name: 'general' },
      entry: { id: c.entryId, text: c.text, contentAlreadyRemoved: false },
      author: {
        memberId: c.s.p.memberId,
        displayName: c.name,
        handle: c.s.p.handle,
        kind: 'human',
        agent: null,
      },
      account: {
        id: c.s.p.userId,
        email: c.email,
        sessions: sessions.rows.map((row) => ({
          createdAt: row.createdAt.toISOString(),
          ipAddress: '203.0.113.7',
          userAgent: row.userAgent,
        })),
      },
      files: [
        {
          id: c.attachmentId,
          name: c.fileName,
          byteSize: Buffer.byteLength(c.bytes),
          path: `files/${c.attachmentId}`,
          sha256: c.checksum,
        },
      ],
      icon: null,
    });
    expect(record.account!.sessions[0].userAgent).toContain('canary-agent/1.0');
    expect(sha256((await evidenceFile(`${folder}files/${c.attachmentId}`)).toString())).toBe(
      c.checksum
    );
    const recordSha = createHash('sha256').update(recordBytes).digest('hex');
    expect(await takedownRow(h, first.id)).toMatchObject({
      evidence_state: 'stored',
      evidence_attempts: 1,
      evidence_record_sha256: recordSha,
      evidence_location: folder,
    });
    expect(
      (
        await h.pool.query(
          `SELECT actor_kind,evidence_record_sha256 FROM host_audit_events
           WHERE action='takedown.evidence_stored' AND community_id=$1`,
          [c.s.communityId]
        )
      ).rows
    ).toEqual([{ actor_kind: 'system', evidence_record_sha256: recordSha }]);
    expect(
      (
        await h.pool.query('SELECT 1 FROM takedown_evidence_staging WHERE takedown_id=$1', [
          first.id,
        ])
      ).rowCount
    ).toBe(0);
    const read = CommunityAdminTakedownResponseSchema.parse(
      await body(
        await hostCall(h, `/takedowns/${first.id}`, { bearer: keys.takedown.secret }),
        200,
        'get'
      )
    ).takedown;
    expect(read.evidence).toEqual({
      state: 'stored',
      recordSha256: recordSha,
      location: folder,
      attempts: 1,
      overdue: false,
    });
    const list = CommunityAdminTakedownListSchema.parse(
      await body(
        await hostCall(h, `/takedowns?communityId=${c.s.communityId}`, {
          bearer: keys.takedown.secret,
        }),
        200,
        'list'
      )
    );
    expect(list.takedowns.map((row) => row.id)).toEqual([separate.id, first.id]);
    expect(list.evidenceStore).toBe(true);
    expect((await hostCall(h, '/takedowns', { bearer: keys.read.secret })).status).toBe(403);
    // An item cannot be reversed: its content is gone.
    const reversed = await hostCall(
      h,
      `/takedowns/${first.id}/reverse`,
      { bearer: keys.takedown.secret },
      {
        lifecycleVersion: 1,
      }
    );
    expect(reversed.status).toBe(409);

    // After the sweep, primary storage and every database column have lost the content.
    await drainCleanup(h);
    expect(await blobState(h, fileKey)).toBeUndefined();
    expect(await scanDatabase(h.pool, c.content)).toEqual([]);
    expect(await scanBlobs(storageDirectory(h), c.content)).toEqual([]);
    const leftovers = (await readdir(tmpdir())).filter((name) =>
      name.startsWith('community-evidence-')
    );
    for (const name of leftovers)
      expect(await scanBlobs(join(tmpdir(), name), c.content).catch(() => [])).toEqual([]);
    expect((await readdir(join(evidenceDirectory, ...folder.split('/')))).sort()).toEqual([
      'files',
      'record.json',
    ]);
    expect(await communityDigest(h.pool, other.s.communityId)).toEqual(otherBefore);
    // Nothing any takedown route answered named the content or who posted it.
    expect(leaks(c.needles)).toEqual([]);
  });

  // Purpose (AC-4, AC-11): fails if an agent's message is preserved without the person
  // responsible for the agent, or if that person is not the one told about it.
  it('names an agent and its owner, with the owner’s account and sessions', async () => {
    const s = await makeScene(h, operator.cookie, 'agent');
    const entry = await post(
      h,
      s.communityId,
      s.channelId,
      { bearer: s.agent.token },
      {
        text: 'agent-canary-text',
        idempotencyKey: 'agent-canary',
      }
    );
    const t = await created(
      await takedown(
        h,
        s.communityId,
        { cookie: operator.cookie },
        {
          target: { kind: 'entry', entryId: entry.id },
          category: 'terms_violation',
        }
      )
    );
    expect(t.actor).toEqual({ kind: 'person', id: expect.any(String) });
    expect(await copyEvidence(h)).toEqual({ claimed: true, stored: true });
    const record = CommunityEvidenceRecordV1Schema.parse(
      JSON.parse((await evidenceFile(`takedowns/${t.id}/attempt-1/record.json`)).toString())
    );
    const email = (
      await h.pool.query<{ email: string }>('SELECT email FROM "user" WHERE id=$1', [s.p.userId])
    ).rows[0].email;
    expect(record.takedown.actor).toEqual({ kind: 'person', id: t.actor.id, name: 'Hana Host' });
    expect(record.author).toMatchObject({
      memberId: s.p.memberId,
      kind: 'agent',
      agent: { id: s.agent.id, handle: s.agent.handle },
    });
    expect(record.account).toMatchObject({ id: s.p.userId, email });
    expect(record.account!.sessions.length).toBeGreaterThan(0);
    expect(record.entry?.text).toBe('agent-canary-text');
    const notices = async (cookie: string) =>
      CommunityWireTakedownNoticeListResponseSchema.parse(
        await body(await h.call(`${s.base}/takedowns`, { cookie }), 200, 'notices')
      ).takedowns.map((notice) => notice.id);
    expect(await notices(s.p.cookie)).toEqual([t.id]);
    expect(await notices(s.q.cookie)).toEqual([]);
  });

  // Purpose (AC-4): fails if the store ever replaces an existing file, or if a failed attempt's
  // folder is written to again.
  it('never overwrites a file already in the store', async () => {
    const c = await canary(h, operator.cookie, 'exists');
    const t = await created(
      await takedown(
        h,
        c.s.communityId,
        { bearer: keys.takedown.secret },
        {
          target: { kind: 'attachment', attachmentId: c.attachmentId },
        }
      )
    );
    expect(t.target).toEqual({
      kind: 'attachment',
      attachmentId: c.attachmentId,
      entryId: c.entryId,
    });
    const planted = join(evidenceDirectory, 'takedowns', t.id, 'attempt-1', 'record.json');
    await mkdir(join(planted, '..'), { recursive: true });
    await writeFile(planted, 'planted');
    expect(await copyEvidence(h)).toEqual({ claimed: true, stored: false });
    expect(await takedownRow(h, t.id)).toMatchObject({
      evidence_state: 'retrying',
      last_error_class: 'EVIDENCE_EXISTS',
      evidence_attempts: 1,
    });
    expect(await readFile(planted, 'utf8')).toBe('planted');
    await due(h, t.id);
    expect(await copyEvidence(h)).toEqual({ claimed: true, stored: true });
    expect(await takedownRow(h, t.id)).toMatchObject({
      evidence_state: 'stored',
      evidence_location: `takedowns/${t.id}/attempt-2/`,
    });
    expect(await readFile(planted, 'utf8')).toBe('planted');
    // The file's message keeps its text; only the file left it.
    const shown = (await history(h, c.s, c.s.q.cookie)).find((entry) => entry.id === c.entryId)!;
    expect(shown).toMatchObject({ text: c.text, attachments: [] });
  });

  // Purpose (AC-5): fails if an outage exposes the content, lets the sweep or a deletion destroy
  // held bytes, or loses the copy; and if the S3 sink ever sends anything but PutObject.
  it('keeps content hidden and bytes held while the store is down, then copies them', async () => {
    const c = await canary(h, operator.cookie, 'down');
    const fileKey = (
      await h.pool.query<{ blob_key: string }>('SELECT blob_key FROM attachments WHERE id=$1', [
        c.attachmentId,
      ])
    ).rows[0].blob_key;
    const t = await created(
      await takedown(
        h,
        c.s.communityId,
        { bearer: keys.takedown.secret },
        {
          target: { kind: 'entry', entryId: c.entryId },
        }
      )
    );
    const calls: { name: string; input: Record<string, unknown>; body?: Buffer }[] = [];
    let failing = true;
    const client = {
      send: async (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
        const call: (typeof calls)[number] = {
          name: command.constructor.name,
          input: command.input,
        };
        calls.push(call);
        if (call.name !== 'PutObjectCommand') throw new Error('Only PutObject is allowed');
        if (failing) throw Object.assign(new Error('unavailable'), { name: 'ServiceUnavailable' });
        const chunks: Buffer[] = [];
        for await (const chunk of command.input.Body as AsyncIterable<Buffer>) chunks.push(chunk);
        call.body = Buffer.concat(chunks);
        return {};
      },
    };
    const s3 = new S3EvidenceSink({
      bucket: 'evidence',
      region: 'us-east-1',
      prefix: 'host-a',
      client: client as never,
    });
    expect(await copyEvidence(h, s3)).toEqual({ claimed: true, stored: false });
    expect(await takedownRow(h, t.id)).toMatchObject({
      evidence_state: 'retrying',
      last_error_class: 'EVIDENCE_WRITE_FAILED',
      evidence_failures: 1,
    });
    // Hidden, held, and swept around.
    expect(
      (await history(h, c.s, c.s.q.cookie)).find((entry) => entry.id === c.entryId)!.text
    ).toBe(REMOVED_ENTRY_TEXT.host);
    await h.pool.query('UPDATE pending_blob_deletions SET next_attempt_at=now()');
    await sweepPendingBlobDeletions(h.pool, h.blobStore, 100);
    expect((await blobState(h, fileKey)).state).toBe('evidence_hold');
    expect((await readdir(storageDirectory(h))).includes(fileKey)).toBe(true);
    // A deletion the owner asked for waits for the evidence.
    await ownerDeletionDue(h, c.s);
    expect(await runDeletion(h, c.s.communityId)).toBe(false);
    // The store recovers: the next attempt lands in its own folder.
    failing = false;
    await due(h, t.id);
    expect(await copyEvidence(h, s3)).toEqual({ claimed: true, stored: true });
    const record = calls.find((call) => String(call.input.Key).endsWith('record.json'))!;
    expect(record.input).toMatchObject({
      Bucket: 'evidence',
      Key: `host-a/takedowns/${t.id}/attempt-2/record.json`,
      IfNoneMatch: '*',
      ChecksumSHA256: createHash('sha256').update(record.body!).digest('base64'),
    });
    expect(
      CommunityEvidenceRecordV1Schema.parse(JSON.parse(record.body!.toString())).entry?.text
    ).toBe(c.text);
    const file = calls.find(
      (call) => String(call.input.Key).endsWith(`files/${c.attachmentId}`) && call.body
    )!;
    expect(file.body!.toString()).toBe(c.bytes);
    expect(new Set(calls.map((call) => call.name))).toEqual(new Set(['PutObjectCommand']));
    expect((await takedownRow(h, t.id)).evidence_record_sha256).toBe(
      createHash('sha256').update(record.body!).digest('hex')
    );
    // Now the bytes go, and the owner's deletion runs.
    expect((await blobState(h, fileKey)).state).toBe('pending_delete');
    expect(await runDeletion(h, c.s.communityId)).toBe(true);
    expect((await readdir(storageDirectory(h))).includes(fileKey)).toBe(false);
  });

  // Purpose (AC-6c, AC-13b): fails if a failed copy stops retrying before five failures, keeps
  // retrying forever after, or if a host-started deletion from a noticed hold outruns the copy.
  it('fails after five attempts, holds every deletion, and retries on request', async () => {
    const c = await canary(h, operator.cookie, 'failed');
    const t = await created(
      await takedown(
        h,
        c.s.communityId,
        { bearer: keys.takedown.secret },
        {
          target: { kind: 'entry', entryId: c.entryId },
        }
      )
    );
    for (let attempt = 1; attempt <= EVIDENCE_MAX_FAILURES; attempt++) {
      await due(h, t.id);
      expect(await copyEvidence(h, downSink)).toEqual({ claimed: true, stored: false });
    }
    expect(await takedownRow(h, t.id)).toMatchObject({
      evidence_state: 'failed',
      evidence_attempts: EVIDENCE_MAX_FAILURES,
    });
    await due(h, t.id);
    expect(await copyEvidence(h, downSink)).toEqual({ claimed: false, stored: false });
    // A host-started deletion after a noticed hold waits too.
    const hold = await h.call(`/api/v1/host/communities/${c.s.communityId}/lifecycle`, {
      method: 'PATCH',
      cookie: operator.cookie,
      body: {
        action: 'hold',
        lifecycleVersion: await lifecycleVersion(h, c.s.communityId),
        deletionNoticeAt: new Date(clock().getTime() + 15 * DAY).toISOString(),
      },
    });
    await expectStatus(hold, 200, 'hold');
    clockOffsetMs += 16 * DAY;
    try {
      await expectStatus(
        await h.call(`/api/v1/host/communities/${c.s.communityId}/deletion`, {
          cookie: operator.cookie,
          body: {
            lifecycleVersion: await lifecycleVersion(h, c.s.communityId),
            confirmIdSuffix: c.s.communityId.slice(-8),
          },
        }),
        200,
        'host deletion'
      );
    } finally {
      clockOffsetMs -= 16 * DAY;
    }
    await deletionDue(h, c.s.communityId);
    expect(await runDeletion(h, c.s.communityId)).toBe(false);
    // Retry sends it back to the worker, which stores it; then the deletion runs.
    const retried = CommunityAdminTakedownResponseSchema.parse(
      await body(
        await hostCall(
          h,
          `/takedowns/${t.id}/evidence/retry`,
          { bearer: keys.takedown.secret },
          {}
        ),
        200,
        'retry'
      )
    ).takedown;
    expect(retried.evidence.state).toBe('pending');
    expect(await copyEvidence(h)).toEqual({ claimed: true, stored: true });
    expect(await takedownRow(h, t.id)).toMatchObject({
      evidence_state: 'stored',
      evidence_location: `takedowns/${t.id}/attempt-${EVIDENCE_MAX_FAILURES + 1}/`,
    });
    expect(
      (await hostCall(h, `/takedowns/${t.id}/evidence/retry`, { bearer: keys.takedown.secret }, {}))
        .status
    ).toBe(409);
    expect(await runDeletion(h, c.s.communityId)).toBe(true);
    expect(leaks(c.needles)).toEqual([]);
  });

  // Purpose (AC-6b): fails if an icon takedown leaves the icon reachable, writes a redaction
  // row, loses the icon's bytes, or if the notify defaults are wrong.
  it('takes down the icon, holds its bytes, and copies them', async () => {
    const s = await makeScene(h, operator.cookie, 'icon');
    const png = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.from('icon-canary')]);
    const settings = await body<{ settingsVersion: number }>(
      await h.call(`${s.base}/settings`, { cookie: s.owner.cookie }),
      200,
      'settings'
    );
    await expectStatus(
      await h.call(`${s.base}/settings/icon`, {
        method: 'PUT',
        cookie: s.owner.cookie,
        headers: { 'if-match': `"${settings.settingsVersion}"` },
        raw: png,
      }),
      200,
      'icon'
    );
    const iconKey = (
      await h.pool.query<{ icon_blob_key: string }>(
        'SELECT icon_blob_key FROM communities WHERE id=$1',
        [s.communityId]
      )
    ).rows[0].icon_blob_key;
    const redactions = async () =>
      (await h.pool.query('SELECT 1 FROM entry_redactions WHERE community_id=$1', [s.communityId]))
        .rowCount;
    const before = await redactions();
    const t = await created(
      await takedown(
        h,
        s.communityId,
        { bearer: keys.takedown.secret },
        {
          target: { kind: 'icon' },
          category: 'child_safety',
        }
      )
    );
    expect(t).toMatchObject({
      target: { kind: 'icon' },
      notify: false,
      evidence: { state: 'pending' },
    });
    expect((await h.call(`${s.base}/icon`, { cookie: s.q.cookie })).status).toBe(404);
    expect(await redactions()).toBe(before);
    expect((await blobState(h, iconKey)).state).toBe('evidence_hold');
    expect(
      (
        await h.pool.query(
          "SELECT withheld FROM audit_events WHERE action='icon.takedown' AND community_id=$1",
          [s.communityId]
        )
      ).rows
    ).toEqual([{ withheld: true }]);
    expect(await copyEvidence(h)).toEqual({ claimed: true, stored: true });
    expect(await evidenceFile(`takedowns/${t.id}/attempt-1/icon`)).toEqual(png);
    const record = CommunityEvidenceRecordV1Schema.parse(
      JSON.parse((await evidenceFile(`takedowns/${t.id}/attempt-1/record.json`)).toString())
    );
    expect(record.icon).toEqual({
      contentType: 'image/png',
      byteSize: png.length,
      path: 'icon',
      sha256: createHash('sha256').update(png).digest('hex'),
    });
    expect((await blobState(h, iconKey)).state).toBe('pending_delete');
    // An explicit notify wins over the default, and other categories default to telling.
    const c = await canary(h, operator.cookie, 'notifydefault');
    const told = await created(
      await takedown(
        h,
        c.s.communityId,
        { bearer: keys.takedown.secret },
        {
          target: { kind: 'attachment', attachmentId: c.attachmentId },
          category: 'legal_order',
        }
      )
    );
    expect(told.notify).toBe(true);
    const quiet = await created(
      await takedown(
        h,
        c.s.communityId,
        { bearer: keys.takedown.secret },
        {
          target: { kind: 'entry', entryId: c.entryId },
          category: 'illegal_content',
          notify: false,
        }
      )
    );
    expect(quiet.notify).toBe(false);
  });

  // Purpose (AC-7): fails if a message its author removed keeps the author's reason, gets a
  // second redaction row, or if an erased message is changed.
  it('relabels an author’s removal to the host’s and leaves an erased message erased', async () => {
    const s = await makeScene(h, operator.cookie, 'already');
    const removedId = (
      await post(
        h,
        s.communityId,
        s.channelId,
        { cookie: s.p.cookie },
        {
          text: 'soon removed',
          idempotencyKey: 'already-removed',
        }
      )
    ).id;
    await expectStatus(
      await h.call(`${s.base}/entries/${removedId}`, { method: 'DELETE', cookie: s.p.cookie }),
      200,
      'author removes'
    );
    const count = async (id: string) =>
      (await h.pool.query('SELECT 1 FROM entry_redactions WHERE entry_id=$1', [id])).rowCount!;
    const before = await count(removedId);
    const t = await created(
      await takedown(
        h,
        s.communityId,
        { bearer: keys.takedown.secret },
        {
          target: { kind: 'entry', entryId: removedId },
        }
      )
    );
    expect(t.evidence.state).toBe('nothing_to_preserve');
    expect(await count(removedId)).toBe(before + 1);
    expect(
      (await h.pool.query('SELECT text,removed_by FROM entries WHERE id=$1', [removedId])).rows[0]
    ).toEqual({ text: REMOVED_ENTRY_TEXT.host, removed_by: 'host' });
    expect(
      (await h.pool.query('SELECT 1 FROM takedown_evidence_staging WHERE takedown_id=$1', [t.id]))
        .rowCount
    ).toBe(0);

    await requestErasure(h, s.p.cookie, s.communityId);
    await runErasures(h.pool, hoursFromNow(73));
    const erasedBefore = await count(s.pEntryId);
    const erased = await created(
      await takedown(
        h,
        s.communityId,
        { bearer: keys.takedown.secret },
        {
          target: { kind: 'entry', entryId: s.pEntryId },
        }
      )
    );
    expect(erased.evidence.state).toBe('nothing_to_preserve');
    expect(await count(s.pEntryId)).toBe(erasedBefore);
    expect(
      (await h.pool.query('SELECT text,removed_by FROM entries WHERE id=$1', [s.pEntryId])).rows[0]
    ).toEqual({ text: ERASED_ENTRY_TEXT, removed_by: null });
  });

  // Purpose (AC-11): fails if the statement of reasons reaches someone it should not, misses
  // someone it should, or if a withheld takedown is undone by a notice or an owner export.
  it('tells the owner and the author, unless the host withholds it', async () => {
    const c = await canary(h, operator.cookie, 'notices');
    const quietEntry = (
      await post(
        h,
        c.s.communityId,
        c.s.channelId,
        { cookie: c.s.p.cookie },
        {
          text: 'quiet-canary',
          idempotencyKey: 'quiet',
        }
      )
    ).id;
    const told = await created(
      await takedown(
        h,
        c.s.communityId,
        { bearer: keys.takedown.secret },
        {
          target: { kind: 'entry', entryId: c.entryId },
          reference: 'REF-11',
        }
      )
    );
    const withheld = await created(
      await takedown(
        h,
        c.s.communityId,
        { bearer: keys.takedown.secret },
        {
          target: { kind: 'entry', entryId: quietEntry },
          notify: false,
        }
      )
    );
    const notices = async (cookie: string) =>
      CommunityWireTakedownNoticeListResponseSchema.parse(
        await body(await h.call(`${c.s.base}/takedowns`, { cookie }), 200, 'notices')
      ).takedowns;
    const expected = {
      id: told.id,
      targetKind: 'entry',
      entryId: c.entryId,
      attachmentId: null,
      channelId: c.s.channelId,
      category: 'illegal_content',
      reference: 'REF-11',
      createdAt: told.createdAt,
    };
    expect(await notices(c.s.owner.cookie)).toEqual([expected]);
    expect(await notices(c.s.p.cookie)).toEqual([expected]);
    expect(await notices(c.s.q.cookie)).toEqual([]);
    // Withheld: nobody is told, but the tombstone still shows.
    expect(
      (await history(h, c.s, c.s.q.cookie)).find((entry) => entry.id === quietEntry)!.text
    ).toBe(REMOVED_ENTRY_TEXT.host);
    expect(
      (
        await h.pool.query(
          `SELECT changed_fields FROM host_audit_events WHERE action='takedown.create'
           AND community_id=$1 ORDER BY created_at,id`,
          [c.s.communityId]
        )
      ).rows.map((row) => row.changed_fields)
    ).toEqual([
      ['entry', 'notified'],
      ['entry', 'withheld'],
    ]);
    const status = await body<{ takedown: unknown }>(
      await h.call(`${c.s.base}/owner/deletion`, { cookie: c.s.owner.cookie }),
      200,
      'deletion status'
    );
    expect(status.takedown).toBeNull();
    // An owner export made afterwards has the told row and not the withheld one.
    const archiveId = await ownerExport(h, c.s);
    const download = await h.call(`${c.s.base}/exports/${archiveId}`, { cookie: c.s.owner.cookie });
    const manifest = JSON.parse(
      strFromU8(unzipSync(new Uint8Array(await download.arrayBuffer()))['manifest.json'])
    ) as { auditEvents: { action: string; subject_id: string }[] };
    const takedowns = manifest.auditEvents.filter((row) => row.action === 'entry.takedown');
    expect(takedowns.map((row) => row.subject_id)).toEqual([c.entryId]);
    expect(withheld.notify).toBe(false);
  });

  // Purpose (AC-13): fails if two identical requests racing each other both remove and audit.
  it('writes exactly one takedown for two identical requests at once', async () => {
    const c = await canary(h, operator.cookie, 'race');
    const request = { idempotencyKey: 'race-1', target: { kind: 'entry', entryId: c.entryId } };
    const [a, b] = await Promise.all([
      takedown(h, c.s.communityId, { bearer: keys.takedown.secret }, request),
      takedown(h, c.s.communityId, { bearer: keys.takedown.secret }, request),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 201]);
    expect((await a.json()).takedown.id).toBe((await b.json()).takedown.id);
    expect(
      (
        await h.pool.query(
          "SELECT 1 FROM audit_events WHERE action='entry.takedown' AND community_id=$1",
          [c.s.communityId]
        )
      ).rowCount
    ).toBe(1);
  });

  // Purpose: fails if a suspended community's content could not be taken down, or if a
  // takedown ran while the deletion worker was already removing bytes.
  it('works while suspended and refuses once a deletion has started', async () => {
    const c = await canary(h, operator.cookie, 'suspended');
    await expectStatus(
      await h.call(`/api/v1/host/communities/${c.s.communityId}/lifecycle`, {
        method: 'PATCH',
        cookie: operator.cookie,
        body: { action: 'suspend', lifecycleVersion: await lifecycleVersion(h, c.s.communityId) },
      }),
      200,
      'suspend'
    );
    await created(
      await takedown(
        h,
        c.s.communityId,
        { bearer: keys.takedown.secret },
        {
          target: { kind: 'attachment', attachmentId: c.attachmentId },
        }
      )
    );
    await h.pool.query(
      `INSERT INTO community_deletion_jobs(community_id,requested_by_host_actor,lifecycle_version,
         delete_after,next_attempt_at,state)
       VALUES($1,'person:x',1,now(),now(),'deleting')`,
      [c.s.communityId]
    );
    expect(
      (
        await takedown(
          h,
          c.s.communityId,
          { bearer: keys.takedown.secret },
          {
            target: { kind: 'entry', entryId: c.entryId },
          }
        )
      ).status
    ).toBe(409);
    await h.pool.query('DELETE FROM community_deletion_jobs WHERE community_id=$1', [
      c.s.communityId,
    ]);
  });
});

describe('an item takedown with no evidence store', () => {
  // Purpose (AC-6): fails if ordinary categories keep bytes they should purge, or if the categories
  // the law protects are purged, left unwatched, or released by anyone but a person with their
  // password.
  it('purges ordinary categories and holds child safety and legal orders until released', async () => {
    const plain = await canary(bare, bareOperator.cookie, 'plain');
    const plainKey = (
      await bare.pool.query<{ blob_key: string }>('SELECT blob_key FROM attachments WHERE id=$1', [
        plain.attachmentId,
      ])
    ).rows[0].blob_key;
    const purged = await created(
      await takedown(
        bare,
        plain.s.communityId,
        { bearer: bareKey.secret },
        {
          target: { kind: 'entry', entryId: plain.entryId },
          category: 'terms_violation',
        }
      )
    );
    expect(purged.evidence.state).toBe('not_configured');
    expect((await blobState(bare, plainKey)).state).toBe('pending_delete');
    const list = CommunityAdminTakedownListSchema.parse(
      await body(await hostCall(bare, '/takedowns', { bearer: bareKey.secret }), 200, 'list')
    );
    expect(list.evidenceStore).toBe(false);

    const held = await canary(bare, bareOperator.cookie, 'held');
    const heldKey = (
      await bare.pool.query<{ blob_key: string }>('SELECT blob_key FROM attachments WHERE id=$1', [
        held.attachmentId,
      ])
    ).rows[0].blob_key;
    const t = await created(
      await takedown(
        bare,
        held.s.communityId,
        { bearer: bareKey.secret },
        {
          target: { kind: 'entry', entryId: held.entryId },
          category: 'child_safety',
        }
      )
    );
    expect(t).toMatchObject({ notify: false, evidence: { state: 'held_on_primary' } });
    expect((await blobState(bare, heldKey)).state).toBe('evidence_hold');
    const staged = await bare.pool.query<{ record: { entry: { text: string } } }>(
      'SELECT record FROM takedown_evidence_staging WHERE takedown_id=$1',
      [t.id]
    );
    expect(staged.rows[0].record.entry.text).toBe(held.text);
    // Held bytes count toward no limit; usage shows them with the bytes waiting for deletion.
    const usage = await body<{ storage: { pendingDeleteBytes: number; countedBytes: number } }>(
      await hostCall(bare, `/communities/${held.s.communityId}/usage`, { bearer: bareKey.secret }),
      200,
      'usage'
    );
    const heldBytes = Buffer.byteLength(held.bytes);
    expect(usage.storage.pendingDeleteBytes).toBeGreaterThanOrEqual(heldBytes);
    const counted = await bare.pool.query<{ total: string }>(
      `SELECT COALESCE(sum(byte_size),0)::text AS total FROM managed_blobs
       WHERE community_id=$1 AND purpose IN ('attachment','icon') AND state IN ('stored','committed')`,
      [held.s.communityId]
    );
    expect(usage.storage.countedBytes).toBe(Number(counted.rows[0].total));
    await drainCleanup(bare);
    expect((await blobState(bare, heldKey)).state).toBe('evidence_hold');
    expect(await blobState(bare, plainKey)).toBeUndefined();

    // Overdue once the alert hours pass, then at most once an hour.
    const lines: string[] = [];
    const warn = (line: string) => lines.push(line);
    const createdAt = new Date(t.createdAt).getTime();
    const at = (hours: number) => new Date(createdAt + hours * 3_600_000);
    expect(await warnOverdueTakedownEvidence(bare.pool, { now: at(5), alertHours: 6, warn })).toBe(
      0
    );
    expect(await warnOverdueTakedownEvidence(bare.pool, { now: at(7), alertHours: 6, warn })).toBe(
      1
    );
    expect(
      await warnOverdueTakedownEvidence(bare.pool, { now: at(7.5), alertHours: 6, warn })
    ).toBe(0);
    expect(
      await warnOverdueTakedownEvidence(bare.pool, { now: at(8.1), alertHours: 6, warn })
    ).toBe(1);
    expect(lines.map((line) => JSON.parse(line))).toEqual([
      {
        event: 'community.takedown.evidence_overdue',
        takedownId: t.id,
        communityId: held.s.communityId,
        evidenceState: 'held_on_primary',
      },
      {
        event: 'community.takedown.evidence_overdue',
        takedownId: t.id,
        communityId: held.s.communityId,
        evidenceState: 'held_on_primary',
      },
    ]);

    // Retrying needs a store; releasing needs a person and their password.
    expect(
      (await hostCall(bare, `/takedowns/${t.id}/evidence/retry`, { bearer: bareKey.secret }, {}))
        .status
    ).toBe(409);
    const release = (auth: Auth, password?: string) =>
      hostCall(bare, `/takedowns/${t.id}/release-held`, auth, password ? { password } : {});
    expect((await release({ bearer: bareKey.secret }, TENANCY_PASSWORD)).status).toBe(403);
    const noPassword = await release({ cookie: bareOperator.cookie });
    expect({ status: noPassword.status, code: (await noPassword.json()).code }).toEqual({
      status: 403,
      code: 'REAUTH_REQUIRED',
    });
    expect((await blobState(bare, heldKey)).state).toBe('evidence_hold');
    const released = CommunityAdminTakedownResponseSchema.parse(
      await body(await release({ cookie: bareOperator.cookie }, TENANCY_PASSWORD), 200, 'release')
    ).takedown;
    expect(released.evidence.state).toBe('not_configured');
    expect(
      (
        await bare.pool.query(
          "SELECT 1 FROM host_audit_events WHERE action='takedown.release_held'"
        )
      ).rowCount
    ).toBe(1);
    await drainCleanup(bare);
    expect(await blobState(bare, heldKey)).toBeUndefined();
    expect(await scanDatabase(bare.pool, [...held.content, ...plain.content])).toEqual([]);
    expect(await scanBlobs(storageDirectory(bare), [...held.content, ...plain.content])).toEqual(
      []
    );
    expect(leaks([...held.needles, ...plain.needles])).toEqual([]);
    // Who let the copy go outlives the community itself.
    await ownerDeletionDue(bare, held.s);
    expect(await runDeletion(bare, held.s.communityId)).toBe(true);
    const operatorId = (
      await bare.pool.query<{ id: string }>(`SELECT id FROM "user" WHERE email='bo@host.test'`)
    ).rows[0].id;
    const record = await bare.pool.query(
      'SELECT released_by_kind,released_by_user_id,released_at FROM community_takedowns WHERE id=$1',
      [t.id]
    );
    expect(record.rows).toEqual([
      {
        released_by_kind: 'person',
        released_by_user_id: operatorId,
        released_at: expect.any(Date),
      },
    ]);
    const kept = await bare.pool.query<{ action: string; actor_user_id: string | null }>(
      `SELECT action,actor_user_id FROM host_audit_events WHERE community_id=$1 ORDER BY created_at`,
      [held.s.communityId]
    );
    expect(kept.rows.map((row) => row.action)).toEqual([
      'takedown.create',
      'takedown.release_held',
    ]);
    expect(kept.rows[1].actor_user_id).toBe(operatorId);
  });

  // Purpose (AC-6c, AC-6d): fails if a deletion outruns held evidence, if the staged record
  // loses the account once the author erases it, or if a store configured later cannot copy it.
  it('keeps the staged record through an account erasure and copies it once a store exists', async () => {
    const c = await canary(bare, bareOperator.cookie, 'later');
    const t = await created(
      await takedown(
        bare,
        c.s.communityId,
        { bearer: bareKey.secret },
        {
          target: { kind: 'entry', entryId: c.entryId },
          category: 'legal_order',
        }
      )
    );
    expect(t.evidence.state).toBe('held_on_primary');
    // The author erases their whole account.
    await body(
      await bare.call('/api/v1/account/erasures', {
        cookie: c.s.p.cookie,
        body: { kind: 'account', confirmEmail: c.email, password: TENANCY_PASSWORD },
      }),
      201,
      'account erasure'
    );
    await runErasures(bare.pool, hoursFromNow(73));
    expect(
      (await bare.pool.query('SELECT 1 FROM "user" WHERE id=$1', [c.s.p.userId])).rowCount
    ).toBe(0);
    // The owner's deletion waits for the held evidence.
    await ownerDeletionDue(bare, c.s);
    expect(await runDeletion(bare, c.s.communityId)).toBe(false);
    // A store is set up; the offline command sends the copy back to the worker.
    const later = join(EVIDENCE_ROOT, randomUUID());
    try {
      const retried = await runTakedownCommand(
        bare.pool,
        { kind: 'evidence-retry', takedownId: t.id },
        { evidenceStore: true }
      );
      expect(retried.evidence_state).toBe('pending');
      expect(await copyEvidence(bare, new FileSystemEvidenceSink(later))).toEqual({
        claimed: true,
        stored: true,
      });
      const folder = join(later, 'takedowns', t.id, 'attempt-1');
      const record = CommunityEvidenceRecordV1Schema.parse(
        JSON.parse(await readFile(join(folder, 'record.json'), 'utf8'))
      );
      expect(record.account).toMatchObject({ id: c.s.p.userId, email: c.email });
      expect(record.account!.sessions[0]).toMatchObject({ ipAddress: '203.0.113.7' });
      expect(record.entry?.text).toBe(c.text);
      expect(await readFile(join(folder, 'files', c.attachmentId), 'utf8')).toBe(c.bytes);
    } finally {
      await rm(later, { recursive: true, force: true });
    }
    expect(await runDeletion(bare, c.s.communityId)).toBe(true);
  });
});

describe('the deletion gate', () => {
  // Purpose: fails if a community waiting on evidence blocks the deletion worker for every
  // other community, by being claimed and skipped first on every pass.
  it('lets other due deletions run while one waits on evidence', async () => {
    const waiting = await canary(bare, bareOperator.cookie, 'gatewait');
    const free = await makeScene(bare, bareOperator.cookie, 'gatefree');
    await created(
      await takedown(
        bare,
        waiting.s.communityId,
        { bearer: bareKey.secret },
        {
          target: { kind: 'entry', entryId: waiting.entryId },
          category: 'child_safety',
        }
      )
    );
    await ownerDeletionDue(bare, waiting.s);
    await ownerDeletionDue(bare, free);
    // The waiting community is first in line on every pass.
    await bare.pool.query(
      `UPDATE community_deletion_jobs SET next_attempt_at=now()-interval '1 hour'
       WHERE community_id=$1`,
      [waiting.s.communityId]
    );
    for (let pass = 0; pass < 10; pass++) {
      await bare.pool.query(
        `UPDATE community_deletion_blob_progress SET next_attempt_at=now()-interval '1 second'`
      );
      const result = await sweepCommunityDeletions(bare.pool, bare.blobStore, 100);
      if (result.completed) break;
    }
    const exists = async (id: string) =>
      Boolean((await bare.pool.query('SELECT 1 FROM communities WHERE id=$1', [id])).rowCount);
    expect(await exists(free.communityId)).toBe(false);
    expect(await exists(waiting.s.communityId)).toBe(true);
  });
});

describe('storage', () => {
  // Purpose (AC-15): fails if a held blob loses committed_at or its metadata, or if the amended
  // checks let a held blob exist without them.
  it('keeps held blobs committed and refuses held blobs without metadata', async () => {
    const s = await makeScene(h, operator.cookie, 'checks');
    const key = (
      await h.pool.query<{ blob_key: string }>(
        "SELECT blob_key FROM managed_blobs WHERE community_id=$1 AND state='committed' LIMIT 1",
        [s.communityId]
      )
    ).rows[0].blob_key;
    await h.pool.query("UPDATE managed_blobs SET state='evidence_hold' WHERE blob_key=$1", [key]);
    expect((await blobState(h, key)).committed_at).toBeInstanceOf(Date);
    await expect(
      h.pool.query('UPDATE managed_blobs SET checksum=NULL WHERE blob_key=$1', [key])
    ).rejects.toThrow(/managed_blobs_stored_metadata/);
    await h.pool.query("UPDATE managed_blobs SET state='committed' WHERE blob_key=$1", [key]);
  });
});

describe('after review', () => {
  async function setIcon(harness: TenancyHarness, s: Scene, marker: string): Promise<string> {
    const png = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.from(marker)]);
    const settings = await body<{ settingsVersion: number }>(
      await harness.call(`${s.base}/settings`, { cookie: s.owner.cookie }),
      200,
      'settings'
    );
    await expectStatus(
      await harness.call(`${s.base}/settings/icon`, {
        method: 'PUT',
        cookie: s.owner.cookie,
        headers: { 'if-match': `"${settings.settingsVersion}"` },
        raw: png,
      }),
      200,
      'icon'
    );
    return (
      await harness.pool.query<{ icon_blob_key: string }>(
        'SELECT icon_blob_key FROM communities WHERE id=$1',
        [s.communityId]
      )
    ).rows[0].icon_blob_key;
  }

  async function fileKeyOf(harness: TenancyHarness, attachmentId: string) {
    return (
      await harness.pool.query<{ blob_key: string }>(
        'SELECT blob_key FROM attachments WHERE id=$1',
        [attachmentId]
      )
    ).rows[0].blob_key;
  }

  async function staged(harness: TenancyHarness, id: string) {
    return (
      await harness.pool.query('SELECT 1 FROM takedown_evidence_staging WHERE takedown_id=$1', [id])
    ).rowCount;
  }

  // Purpose: fails if a person could destroy a copy that is still being saved, or one that failed
  // while a store exists. Only bytes held for want of a store can be released online.
  it('refuses a person’s release of a copy that is pending or failed', async () => {
    const c = await canary(h, operator.cookie, 'norelease');
    const key = await fileKeyOf(h, c.attachmentId);
    const t = await created(
      await takedown(
        h,
        c.s.communityId,
        { bearer: keys.takedown.secret },
        {
          target: { kind: 'entry', entryId: c.entryId },
          category: 'child_safety',
        }
      )
    );
    const release = () =>
      hostCall(
        h,
        `/takedowns/${t.id}/release-held`,
        { cookie: operator.cookie },
        {
          password: TENANCY_PASSWORD,
        }
      );
    for (let round = 0; round <= EVIDENCE_MAX_FAILURES; round++) {
      const state = (await takedownRow(h, t.id)).evidence_state;
      expect(['pending', 'retrying', 'failed']).toContain(state);
      expect((await release()).status).toBe(409);
      expect(await staged(h, t.id)).toBe(1);
      expect((await blobState(h, key)).state).toBe('evidence_hold');
      if (state === 'failed') break;
      await onlyDue(h, t.id);
      await copyEvidence(h, downSink);
    }
    expect((await takedownRow(h, t.id)).evidence_state).toBe('failed');
  });

  // Purpose: fails if a takedown that commits between the deletion worker choosing a job and
  // locking its community is outrun: the job must stay waiting and the bytes held.
  it('does not delete a community whose takedown lands while its deletion is being claimed', async () => {
    const c = await canary(h, operator.cookie, 'claimrace');
    const key = await fileKeyOf(h, c.attachmentId);
    await ownerDeletionDue(h, c.s);
    let raced = false;
    const result = await sweepCommunityDeletions(h.pool, h.blobStore, 100, {
      afterCandidate: async (communityId) => {
        if (communityId !== c.s.communityId || raced) return;
        raced = true;
        await created(
          await takedown(
            h,
            c.s.communityId,
            { bearer: keys.takedown.secret },
            {
              target: { kind: 'entry', entryId: c.entryId },
            }
          )
        );
      },
    });
    expect(raced).toBe(true);
    expect(result).toMatchObject({ claimed: 0, completed: 0 });
    const job = await h.pool.query(
      'SELECT state FROM community_deletion_jobs WHERE community_id=$1',
      [c.s.communityId]
    );
    expect(job.rows).toEqual([{ state: 'waiting' }]);
    expect((await blobState(h, key)).state).toBe('evidence_hold');
    expect((await readdir(storageDirectory(h))).includes(key)).toBe(true);
    // Settle it, so no later test's deletion pass finds this one.
    const raceTakedown = (
      await h.pool.query<{ id: string }>(
        'SELECT id FROM community_takedowns WHERE community_id=$1',
        [c.s.communityId]
      )
    ).rows[0].id;
    await onlyDue(h, raceTakedown);
    expect(await copyEvidence(h)).toEqual({ claimed: true, stored: true });
    expect(await runDeletion(h, c.s.communityId)).toBe(true);
  });

  // Purpose: fails if an idempotency key could replay another community's takedown.
  it('refuses a replayed key aimed at another community', async () => {
    const a = await makeScene(h, operator.cookie, 'idema');
    const b = await makeScene(h, operator.cookie, 'idemb');
    await setIcon(h, a, 'idem-a');
    await setIcon(h, b, 'idem-b');
    const request = { idempotencyKey: 'icon-case-7', target: { kind: 'icon' } };
    await created(await takedown(h, a.communityId, { bearer: keys.takedown.secret }, request));
    const replayed = await takedown(h, b.communityId, { bearer: keys.takedown.secret }, request);
    expect({ status: replayed.status, code: (await replayed.json()).code }).toEqual({
      status: 409,
      code: 'IDEMPOTENCY_CONFLICT',
    });
    expect((await h.call(`${b.base}/icon`, { cookie: b.q.cookie })).status).toBe(200);
  });

  // Purpose: fails if taking down a message its author already removed lets the removed file's
  // bytes be swept before the copy; a file already swept is gone, and the takedown says so.
  it('holds again the files of a removed message that the sweep has not reached', async () => {
    const c = await canary(h, operator.cookie, 'rehold');
    const key = await fileKeyOf(h, c.attachmentId);
    await expectStatus(
      await h.call(`${c.s.base}/entries/${c.entryId}`, { method: 'DELETE', cookie: c.s.p.cookie }),
      200,
      'author removes'
    );
    expect((await blobState(h, key)).state).toBe('pending_delete');
    const t = await created(
      await takedown(
        h,
        c.s.communityId,
        { bearer: keys.takedown.secret },
        {
          target: { kind: 'entry', entryId: c.entryId },
        }
      )
    );
    expect(t.evidence.state).toBe('pending');
    expect((await blobState(h, key)).state).toBe('evidence_hold');
    for (const table of ['pending_blob_deletions', 'removed_file_blobs'])
      expect((await h.pool.query(`SELECT 1 FROM ${table} WHERE blob_key=$1`, [key])).rowCount).toBe(
        0
      );
    await drainCleanup(h);
    expect((await readdir(storageDirectory(h))).includes(key)).toBe(true);
    await onlyDue(h, t.id);
    expect(await copyEvidence(h)).toEqual({ claimed: true, stored: true });
    const folder = `takedowns/${t.id}/attempt-1/`;
    const record = CommunityEvidenceRecordV1Schema.parse(
      JSON.parse((await evidenceFile(`${folder}record.json`)).toString())
    );
    expect(record.entry).toMatchObject({
      contentAlreadyRemoved: true,
      text: REMOVED_ENTRY_TEXT.author,
    });
    expect(record.files).toEqual([
      expect.objectContaining({ id: c.attachmentId, name: c.fileName, sha256: c.checksum }),
    ]);
    expect((await evidenceFile(`${folder}files/${c.attachmentId}`)).toString()).toBe(c.bytes);
    await drainCleanup(h);
    expect(await scanDatabase(h.pool, c.content)).toEqual([]);

    // Swept already: nothing is left to hold, and the takedown says so.
    const swept = await canary(h, operator.cookie, 'swept');
    await expectStatus(
      await h.call(`${swept.s.base}/entries/${swept.entryId}`, {
        method: 'DELETE',
        cookie: swept.s.p.cookie,
      }),
      200,
      'author removes'
    );
    await drainCleanup(h);
    const gone = await created(
      await takedown(
        h,
        swept.s.communityId,
        { bearer: keys.takedown.secret },
        {
          target: { kind: 'entry', entryId: swept.entryId },
        }
      )
    );
    expect(gone.evidence.state).toBe('nothing_to_preserve');
  });

  // Purpose: fails if erasing a member's files and taking down one of them wait on each other in
  // a cycle (each holding one lock the other needs), which Postgres ends by failing one.
  it('lets an erasure of files and a takedown of one of them both finish', async () => {
    const c = await canary(h, operator.cookie, 'lockorder');
    const outcome = await holdingLock(
      h,
      'SELECT 1 FROM community_content_versions WHERE community_id=$1 FOR UPDATE',
      [c.s.communityId],
      async (release) => {
        const erasure = eraseMembership(h.pool, c.s.communityId, c.s.p.memberId, {
          log: () => {},
        });
        await waitForLockWaiters(h, 1);
        const removal = takedown(
          h,
          c.s.communityId,
          { bearer: keys.takedown.secret },
          {
            target: { kind: 'attachment', attachmentId: c.attachmentId },
          }
        );
        await waitForLockWaiters(h, 2);
        await release();
        return Promise.all([erasure, removal]);
      }
    );
    expect(outcome[0]).toBe('erased');
    expect(outcome[1].status).toBe(404);
  });

  // Purpose: fails if a download that started before a takedown keeps sending the file: its
  // bytes stay in storage for the copy, so only a per-chunk check can stop it.
  it('stops a download in progress once the file is taken down', async () => {
    const s = await makeScene(h, operator.cookie, 'download');
    const size = 8 * 1024 * 1024;
    const fileId = await upload(
      h,
      s.communityId,
      s.channelId,
      s.p.cookie,
      'big.txt',
      'a'.repeat(size)
    );
    await post(
      h,
      s.communityId,
      s.channelId,
      { cookie: s.p.cookie },
      {
        text: 'big file',
        idempotencyKey: 'big',
        attachmentIds: [fileId],
      }
    );
    const response = await h.call(`${s.base}/attachments/${fileId}`, { cookie: s.q.cookie });
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    let received = (await reader.read()).value?.length ?? 0;
    await created(
      await takedown(
        h,
        s.communityId,
        { bearer: keys.takedown.secret },
        {
          target: { kind: 'attachment', attachmentId: fileId },
        }
      )
    );
    let failed = false;
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        received += next.value.length;
      }
    } catch {
      failed = true;
    }
    expect(failed).toBe(true);
    expect(received).toBeLessThan(size);
  });
});
