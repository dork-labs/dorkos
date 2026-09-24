import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient, QueryResult } from 'pg';
import { eraseMembership } from '../erasure/erasure.js';
import { transaction } from '../data.js';
import { dropSegments } from '../exports/store.js';
import type { BlobStore } from '../storage/index.js';
import { sweepPendingBlobDeletions } from '../storage/pending-deletions.js';
import { openArchive } from './export-test-helpers.js';
import {
  downloadArchive,
  exportCommunity,
  exportMember,
  forever,
  jobRow,
  orphanExportBlobs,
  requestOwnerExport,
  requestPersonalExport,
  runExport,
  seedEntries,
  seedFile,
  segmentsOf,
  until,
  type ExportCommunity,
} from './export-jobs-fixture.js';
import {
  bootstrapHost,
  expectStatus,
  startTenancyHarness,
  TENANCY_PASSWORD,
  waitForLockWaiters,
  type TenancyHarness,
} from './tenancy-test-harness.js';

let h: TenancyHarness;
let operatorCookie: string;

beforeAll(async () => {
  h = await startTenancyHarness('exportrebuild');
  operatorCookie = (await bootstrapHost(h, 'Rea Host', 'rea@export-host.test')).cookie;
});

afterAll(async () => {
  await h?.close();
});

/** Segments this small hold one of the long messages below each, so message n is in segment n. */
const ONE_MESSAGE = 3600;
const long = (label: string) => (n: number) => `${label} ${n} ${'x'.repeat(3000)}`;

async function removeEntry(community: ExportCommunity, entryId: string, cookie: string) {
  return h.call(`${community.base}/entries/${entryId}`, { method: 'DELETE', cookie });
}

async function erase(community: ExportCommunity, memberId: string) {
  return eraseMembership(h.pool, community.communityId, memberId, { log: () => undefined });
}

/** Rows of `entries` in an archive, by id. */
function entriesById(archive: Awaited<ReturnType<typeof openArchive>>) {
  return new Map(
    archive
      .rows<{ id: string; text: string; removal: string | null }>('entries')
      .map((row) => [row.id, row])
  );
}

/** Data segment blob keys as each was first committed, recorded by an afterSegment hook. */
function recordKeys(exportId: () => string, into: Map<number, string>) {
  return async ({ segmentNo, kind }: { segmentNo: number; kind: string }) => {
    if (kind !== 'data' || into.has(segmentNo)) return;
    const row = await h.pool.query<{ blob_key: string }>(
      'SELECT blob_key FROM export_segments WHERE export_id=$1 AND segment_no=$2',
      [exportId(), segmentNo]
    );
    into.set(segmentNo, row.rows[0].blob_key);
  };
}

async function currentKeys(exportId: string): Promise<Map<number, string>> {
  return new Map(
    (await segmentsOf(h, exportId))
      .filter((segment) => segment.kind === 'data')
      .map((segment) => [segment.segment_no, segment.blob_key])
  );
}

/** Let every abandoned reservation age past its lease and run the cleanup until it settles. */
async function cleanUp(communityId: string) {
  await h.pool.query(
    "UPDATE managed_blobs SET created_at=now()-interval '2 hours' WHERE community_id=$1 AND purpose='export'",
    [communityId]
  );
  for (let round = 0; round < 5; round++) await sweepPendingBlobDeletions(h.pool, h.blobStore);
}

async function exportBlobCount(communityId: string, exportId: string): Promise<number> {
  const result = await h.pool.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM managed_blobs m
     WHERE m.community_id=$1 AND m.purpose='export' AND m.state<>'pending_delete'
       AND NOT EXISTS (SELECT 1 FROM export_segments s WHERE s.blob_key=m.blob_key AND s.export_id<>$2)`,
    [communityId, exportId]
  );
  return result.rows[0].count;
}

describe('consistency and rebuilds', () => {
  // Purpose (AC-5): the export is as of its start for messages and as of its end for people.
  // Fails if a message posted after the start is exported, or if a rename during the job is
  // not in the archive.
  it('leaves out later messages and exports people as they are at the end', async () => {
    const community = await exportCommunity(h, operatorCookie, 'Window Place');
    const bob = await exportMember(h, community, 'Bob Window');
    await seedEntries(h, community, {
      authorMemberId: bob.memberId,
      count: 3,
      textOf: long('before'),
    });
    const requested = await requestOwnerExport(h, community);
    let once = false;
    await runExport(h, {
      segmentBytes: ONE_MESSAGE,
      hooks: {
        afterSegment: async ({ kind }) => {
          if (kind !== 'data' || once) return;
          once = true;
          await seedEntries(h, community, {
            authorMemberId: bob.memberId,
            count: 1,
            textOf: () => 'posted after the start',
          });
          await h.pool.query("UPDATE members SET display_name='Bob Renamed' WHERE id=$1", [
            bob.memberId,
          ]);
        },
      },
    });
    const archive = await openArchive(await downloadArchive(h, community, requested.export.id));
    const texts = archive.rows<{ text: string }>('entries').map((row) => row.text);
    expect(texts).toHaveLength(3);
    expect(texts).not.toContain('posted after the start');
    expect(
      archive
        .rows<{ id: string; display_name: string }>('members')
        .find((row) => row.id === bob.memberId)?.display_name
    ).toBe('Bob Renamed');
  });

  // Purpose (AC-6): removals in an early segment and a later one rebuild only what they changed.
  // Fails if the job restarts from scratch (segments 2 and 4 would get new blobs), keeps the old
  // text, or counts more than one rebuild pass.
  it('rewrites only the segment a removal changed, in one pass', async () => {
    const community = await exportCommunity(h, operatorCookie, 'Rebuild Place');
    const xena = await exportMember(h, community, 'Xena Rebuild');
    const [m1, m2] = await seedEntries(h, community, {
      authorMemberId: community.owner.memberId,
      count: 2,
      textOf: long('owner'),
    });
    const [m3] = await seedEntries(h, community, {
      authorMemberId: xena.memberId,
      count: 1,
      textOf: long('xena'),
    });
    const [m4] = await seedEntries(h, community, {
      authorMemberId: community.owner.memberId,
      count: 1,
      textOf: long('owner last'),
    });
    const requested = await requestOwnerExport(h, community);
    const first = new Map<number, string>();
    const record = recordKeys(() => requested.export.id, first);
    await runExport(h, {
      segmentBytes: ONE_MESSAGE,
      hooks: {
        afterSegment: async (event) => {
          await record(event);
          if (event.kind !== 'data' || event.segmentNo !== 2) return;
          await expectStatus(
            await removeEntry(community, m1.id, community.owner.cookie),
            200,
            'remove m1'
          );
          await expectStatus(
            await removeEntry(community, m3.id, community.owner.cookie),
            200,
            'remove m3 as a moderator'
          );
        },
      },
    });
    expect(await jobRow(h, requested.export.id)).toMatchObject({
      state: 'ready',
      rebuild_passes: 1,
    });
    const final = await currentKeys(requested.export.id);
    expect(final.size).toBe(4);
    expect(final.get(1)).not.toBe(first.get(1));
    expect(final.get(2)).toBe(first.get(2));
    expect(final.get(4)).toBe(first.get(4));
    const archive = await openArchive(await downloadArchive(h, community, requested.export.id));
    const entries = entriesById(archive);
    expect(entries.get(m1.id)).toMatchObject({
      removal: 'author',
      text: 'This message was deleted.',
    });
    expect(entries.get(m2.id)?.removal).toBeNull();
    expect(entries.get(m3.id)?.removal).toBe('moderator');
    expect(entries.get(m4.id)?.removal).toBeNull();
  });

  // Purpose (review decision): an erasure while a job is being prepared sends it back to the
  // start, so segments written before the erasure (holding the person's words) are queued for
  // deletion at once instead of sitting in storage until the job's deadline. Fails if a
  // pre-erasure segment survives, or the finished archive holds the person as they were.
  it('restarts a job an erasure interrupts, dropping the segments it wrote', async () => {
    const community = await exportCommunity(h, operatorCookie, 'Restart Erase Place');
    const xena = await exportMember(h, community, 'Xena Restart');
    await seedEntries(h, community, {
      authorMemberId: xena.memberId,
      count: 3,
      textOf: long('xena'),
    });
    const requested = await requestOwnerExport(h, community);
    let before: string[] = [];
    await runExport(h, {
      segmentBytes: ONE_MESSAGE,
      hooks: {
        afterSegment: async ({ kind, segmentNo }) => {
          if (kind !== 'data' || segmentNo !== 2 || before.length) return;
          before = (await segmentsOf(h, requested.export.id)).map((segment) => segment.blob_key);
          expect(await erase(community, xena.memberId)).toBe('erased');
        },
      },
    });
    expect(before).toHaveLength(2);
    const reset = await h.pool.query(
      'SELECT state,data_complete,watermark FROM export_archives WHERE id=$1',
      [requested.export.id]
    );
    expect(reset.rows[0]).toEqual({ state: 'queued', data_complete: false, watermark: null });
    expect(await segmentsOf(h, requested.export.id)).toEqual([]);
    const states = await h.pool.query(
      'SELECT DISTINCT state FROM managed_blobs WHERE blob_key=ANY($1::text[])',
      [before]
    );
    expect(states.rows).toEqual([{ state: 'pending_delete' }]);
    expect(await runExport(h, { segmentBytes: ONE_MESSAGE })).toBe(requested.export.id);
    expect(await jobRow(h, requested.export.id)).toMatchObject({ state: 'ready' });
    const archive = await openArchive(await downloadArchive(h, community, requested.export.id));
    expect(archive.rows<{ removal: string | null }>('entries').map((row) => row.removal)).toEqual([
      'erased',
      'erased',
      'erased',
    ]);
    expect(
      archive
        .rows<{ id: string; display_name: string }>('members')
        .find((row) => row.id === xena.memberId)?.display_name
    ).toBe('Erased member');
  });

  // Purpose (AC-6b): a change that bumps the version without a redaction row is still caught
  // by the segment digests. Fails if the deleted file stays in the archive, or if segments
  // whose content did not change are rewritten.
  it('finds an unexplained change by digest and rewrites only that segment', async () => {
    const community = await exportCommunity(h, operatorCookie, 'Digest Place');
    const entries = await seedEntries(h, community, {
      authorMemberId: community.owner.memberId,
      count: 3,
      textOf: long('digest'),
    });
    const files: Awaited<ReturnType<typeof seedFile>>[] = [];
    for (const [index, entry] of entries.entries())
      files.push(
        await seedFile(h, community, {
          entryId: entry.id,
          uploaderMemberId: community.owner.memberId,
          name: `f${index + 1}.txt`,
          bytes: Buffer.from(`file ${index + 1}`),
        })
      );
    const requested = await requestOwnerExport(h, community);
    const first = new Map<number, string>();
    const record = recordKeys(() => requested.export.id, first);
    await runExport(h, {
      segmentBytes: ONE_MESSAGE,
      hooks: {
        afterSegment: async (event) => {
          await record(event);
          if (event.kind !== 'data' || event.segmentNo !== 2) return;
          // A change that breaks the rule: no redaction row, only a version bump.
          await h.pool.query('DELETE FROM attachments WHERE id=$1', [files[1].id]);
          await h.pool.query(
            'UPDATE community_content_versions SET version=version+1 WHERE community_id=$1',
            [community.communityId]
          );
        },
      },
    });
    expect(await jobRow(h, requested.export.id)).toMatchObject({
      state: 'ready',
      rebuild_passes: 1,
    });
    const final = await currentKeys(requested.export.id);
    expect(final.get(1)).toBe(first.get(1));
    expect(final.get(2)).not.toBe(first.get(2));
    expect(final.get(3)).toBe(first.get(3));
    const archive = await openArchive(await downloadArchive(h, community, requested.export.id));
    const ids = archive.rows<{ id: string }>('attachments').map((row) => row.id);
    expect(ids).toEqual([files[0].id, files[2].id]);
    expect([...archive.files.keys()].some((name) => name.startsWith(`files/${files[1].id}/`))).toBe(
      false
    );
  });

  // Purpose (AC-6b): a file removed while its segment is being written (its bytes gone before
  // they are read) makes the worker write that segment again and finish. Fails if the job fails
  // on the missing bytes or keeps the removed file.
  it('rewrites a segment whose file vanishes while it is written, and finishes', async () => {
    const community = await exportCommunity(h, operatorCookie, 'Vanish Place');
    const [entry] = await seedEntries(h, community, {
      authorMemberId: community.owner.memberId,
      count: 1,
      textOf: () => 'with two files',
    });
    const keep = await seedFile(h, community, {
      entryId: entry.id,
      uploaderMemberId: community.owner.memberId,
      name: 'keep.txt',
      bytes: Buffer.from('kept'),
    });
    const gone = await seedFile(h, community, {
      entryId: entry.id,
      uploaderMemberId: community.owner.memberId,
      name: 'gone.txt',
      bytes: Buffer.from('gone'),
    });
    const requested = await requestOwnerExport(h, community);
    let removed = false;
    await runExport(h, {
      hooks: {
        beforeFile: async ({ attachmentId }) => {
          if (attachmentId !== gone.id || removed) return;
          removed = true;
          await expectStatus(
            await h.call(`${community.base}/attachments/${gone.id}`, {
              method: 'DELETE',
              cookie: community.owner.cookie,
            }),
            200,
            'remove the file'
          );
          // The pending-deletion sweep removes the bytes before the worker reads them.
          await h.blobStore.delete(gone.blobKey);
        },
      },
    });
    expect(removed).toBe(true);
    expect(await jobRow(h, requested.export.id)).toMatchObject({ state: 'ready' });
    expect((await jobRow(h, requested.export.id)).rebuild_passes).toBeGreaterThanOrEqual(1);
    const archive = await openArchive(await downloadArchive(h, community, requested.export.id));
    expect(archive.rows<{ id: string }>('attachments').map((row) => row.id)).toEqual([keep.id]);
    expect(archive.files.get(`files/${keep.id}/keep.txt`)?.toString()).toBe('kept');
  });
});

describe('the tail commit keeps erasure’s guarantee', () => {
  // Purpose (AC-7): a removal committed after the last check but before the final FOR SHARE
  // read makes the tail go round again. Fails if the tail commits with the old text.
  it('goes round again when a removal commits just before the final lock', async () => {
    const community = await exportCommunity(h, operatorCookie, 'Round Place');
    const [m1] = await seedEntries(h, community, {
      authorMemberId: community.owner.memberId,
      count: 2,
      textOf: long('round'),
    });
    const requested = await requestOwnerExport(h, community);
    let removed = false;
    await runExport(h, {
      segmentBytes: ONE_MESSAGE,
      hooks: {
        beforeTailCommit: async () => {
          if (removed) return;
          removed = true;
          await expectStatus(
            await removeEntry(community, m1.id, community.owner.cookie),
            200,
            'remove m1'
          );
        },
      },
    });
    const job = await jobRow(h, requested.export.id);
    expect(job.state).toBe('ready');
    expect(job.rebuild_passes).toBeGreaterThanOrEqual(1);
    const archive = await openArchive(await downloadArchive(h, community, requested.export.id));
    expect(entriesById(archive).get(m1.id)?.removal).toBe('author');
  });

  // Purpose (AC-7): a removal that reaches the content version while the tail holds it FOR
  // SHARE waits until the archive is ready, then commits; the archive stays (removal does not
  // delete exports). Fails if the removal slips in before the commit or deadlocks with it.
  it('makes a removal wait for the ready commit, and leaves the archive', async () => {
    const community = await exportCommunity(h, operatorCookie, 'Wait Place');
    const [m1] = await seedEntries(h, community, {
      authorMemberId: community.owner.memberId,
      count: 1,
      textOf: () => 'original words',
    });
    const requested = await requestOwnerExport(h, community);
    let removal: Promise<Response> | undefined;
    await runExport(h, {
      hooks: {
        afterTailLock: async () => {
          if (removal) return;
          removal = removeEntry(community, m1.id, community.owner.cookie);
          await waitForLockWaiters(h, 1, 'community_content_versions');
        },
      },
    });
    expect((await removal!).status).toBe(200);
    expect(await jobRow(h, requested.export.id)).toMatchObject({
      state: 'ready',
      rebuild_passes: 0,
    });
    const archive = await openArchive(await downloadArchive(h, community, requested.export.id));
    expect(entriesById(archive).get(m1.id)).toMatchObject({
      text: 'original words',
      removal: null,
    });
  });

  // Purpose (AC-7): an erasure that waits on the tail's lock deletes the archive once it is
  // ready, with every segment queued. Fails if the ready archive survives the erasure.
  it('lets an erasure that waited on the lock delete the archive once it is ready', async () => {
    const community = await exportCommunity(h, operatorCookie, 'Erase Wait Place');
    const xena = await exportMember(h, community, 'Xena Wait');
    const [entry] = await seedEntries(h, community, {
      authorMemberId: xena.memberId,
      count: 1,
      textOf: () => 'xena words',
    });
    await seedFile(h, community, {
      entryId: entry.id,
      uploaderMemberId: xena.memberId,
      name: 'xena.txt',
      bytes: Buffer.from('xena file'),
    });
    const requested = await requestOwnerExport(h, community);
    let erasure: Promise<string> | undefined;
    await runExport(h, {
      hooks: {
        afterTailLock: async () => {
          if (erasure) return;
          erasure = erase(community, xena.memberId);
          await waitForLockWaiters(h, 1, 'community_content_versions');
        },
      },
    });
    const keys = (
      await h.pool.query<{ blob_key: string }>(
        "SELECT blob_key FROM managed_blobs WHERE community_id=$1 AND purpose='export'",
        [community.communityId]
      )
    ).rows.map((row) => row.blob_key);
    expect(await erasure!).toBe('erased');
    expect(
      (await h.pool.query('SELECT 1 FROM export_archives WHERE id=$1', [requested.export.id]))
        .rowCount
    ).toBe(0);
    expect(keys.length).toBeGreaterThan(0);
    const states = await h.pool.query<{ state: string }>(
      'SELECT DISTINCT state FROM managed_blobs WHERE blob_key=ANY($1::text[])',
      [keys]
    );
    expect(states.rows).toEqual([{ state: 'pending_delete' }]);
    expect(await orphanExportBlobs(h, community.communityId)).toEqual([]);
  });

  // Purpose (AC-7): a community that never stops changing fails the job after five passes and
  // leaves nothing stored. Fails if the job loops forever or keeps a segment.
  it('gives up after five passes of changes and keeps no segment', async () => {
    const community = await exportCommunity(h, operatorCookie, 'Churn Place');
    const entries = await seedEntries(h, community, {
      authorMemberId: community.owner.memberId,
      count: 12,
      textOf: long('churn'),
    });
    const requested = await requestOwnerExport(h, community);
    let next = 0;
    await runExport(h, {
      segmentBytes: ONE_MESSAGE,
      hooks: {
        beforeTailCommit: async () => {
          await expectStatus(
            await removeEntry(community, entries[next++].id, community.owner.cookie),
            200,
            'remove one more'
          );
        },
      },
    });
    expect(await jobRow(h, requested.export.id)).toMatchObject({
      state: 'failed',
      failure_code: 'EXPORT_CONTENT_CHANGING',
      rebuild_passes: 5,
    });
    expect(await segmentsOf(h, requested.export.id)).toEqual([]);
    await cleanUp(community.communityId);
    expect(await exportBlobCount(community.communityId, requested.export.id)).toBe(0);
  });
});

describe('jobs, erasure, access and deadlines', () => {
  // Purpose (AC-10b): an erasure completes while an owner export is building (the husk step
  // does not wait on a job in progress), deletes a ready export with every segment queued, and
  // the building job starts again and includes the husk. Fails if the erasure loops on the job, or a
  // ready export (or one of its blobs) survives.
  it('completes an erasure while an export builds and deletes the ready one', async () => {
    const community = await exportCommunity(h, operatorCookie, 'Husk Place');
    const xena = await exportMember(h, community, 'Xena Husk');
    const yuri = await exportMember(h, community, 'Yuri Ready');
    await seedEntries(h, community, {
      authorMemberId: xena.memberId,
      count: 2,
      textOf: long('xena'),
    });
    await seedEntries(h, community, {
      authorMemberId: yuri.memberId,
      count: 1,
      textOf: long('yuri'),
    });
    const personal = await requestPersonalExport(h, community, yuri.cookie);
    await runExport(h, { segmentBytes: ONE_MESSAGE });
    const readyKeys = (await segmentsOf(h, personal.export.id)).map((segment) => segment.blob_key);
    expect(readyKeys.length).toBeGreaterThan(0);

    const owner = await requestOwnerExport(h, community);
    let outcome: string | undefined;
    await runExport(h, {
      segmentBytes: ONE_MESSAGE,
      hooks: {
        afterSegment: async ({ kind, segmentNo }) => {
          if (kind !== 'data' || segmentNo !== 1 || outcome) return;
          outcome = await erase(community, xena.memberId);
        },
      },
    });
    expect(outcome).toBe('erased');
    // The erasure sent the building job back to the start; it runs again from nothing.
    expect(await runExport(h, { segmentBytes: ONE_MESSAGE })).toBe(owner.export.id);
    expect(
      (await h.pool.query('SELECT 1 FROM export_archives WHERE id=$1', [personal.export.id]))
        .rowCount
    ).toBe(0);
    const queued = await h.pool.query<{ state: string }>(
      'SELECT state FROM managed_blobs WHERE blob_key=ANY($1::text[])',
      [readyKeys]
    );
    expect(queued.rows.map((row) => row.state)).toEqual(readyKeys.map(() => 'pending_delete'));
    expect(
      (
        await h.pool.query(
          'SELECT count(*)::int AS count FROM pending_blob_deletions WHERE blob_key=ANY($1::text[])',
          [readyKeys]
        )
      ).rows[0].count
    ).toBe(readyKeys.length);
    expect(await jobRow(h, owner.export.id)).toMatchObject({ state: 'ready' });
    const archive = await openArchive(await downloadArchive(h, community, owner.export.id));
    expect(
      archive
        .rows<{ id: string; display_name: string }>('members')
        .find((row) => row.id === xena.memberId)?.display_name
    ).toBe('Erased member');
    expect(
      archive
        .rows<{ author_member_id: string; removal: string | null }>('entries')
        .filter((row) => row.author_member_id === xena.memberId)
        .map((row) => row.removal)
    ).toEqual(['erased', 'erased']);
    expect(await orphanExportBlobs(h, community.communityId)).toEqual([]);
  });

  // Purpose (AC-11): a requester who loses their authority stops the job before its next
  // segment. Fails if a demoted owner's export keeps building, or its segments are kept.
  it('fails an owner export with EXPORT_ACCESS_ENDED when ownership moves on', async () => {
    const community = await exportCommunity(h, operatorCookie, 'Demote Place');
    const bob = await exportMember(h, community, 'Bob Successor');
    await seedEntries(h, community, {
      authorMemberId: bob.memberId,
      count: 3,
      textOf: long('demote'),
    });
    const requested = await requestOwnerExport(h, community);
    let segments = 0;
    await runExport(h, {
      segmentBytes: ONE_MESSAGE,
      hooks: {
        afterSegment: async ({ kind }) => {
          if (kind !== 'data' || ++segments !== 1) return;
          const lifecycle = await h.pool.query<{ lifecycle_version: number }>(
            'SELECT lifecycle_version FROM communities WHERE id=$1',
            [community.communityId]
          );
          await expectStatus(
            await h.call(`${community.base}/owner/transfer`, {
              cookie: community.owner.cookie,
              body: {
                successorMemberId: bob.memberId,
                password: TENANCY_PASSWORD,
                lifecycleVersion: lifecycle.rows[0].lifecycle_version,
              },
            }),
            200,
            'transfer ownership'
          );
        },
      },
    });
    expect(segments).toBe(1);
    expect(await jobRow(h, requested.export.id)).toMatchObject({
      state: 'failed',
      failure_code: 'EXPORT_ACCESS_ENDED',
    });
    expect(await segmentsOf(h, requested.export.id)).toEqual([]);
    expect(await orphanExportBlobs(h, community.communityId)).toEqual([]);
  });

  // Purpose (AC-11): a personal export whose requester leaves an exported channel stops the
  // same way. Fails if it goes on exporting a channel they can no longer read.
  it('fails a personal export when its requester leaves a channel', async () => {
    const community = await exportCommunity(h, operatorCookie, 'Leave Place');
    const bob = await exportMember(h, community, 'Bob Leaver');
    await seedEntries(h, community, {
      authorMemberId: bob.memberId,
      count: 3,
      textOf: long('leave'),
    });
    const requested = await requestPersonalExport(h, community, bob.cookie);
    let segments = 0;
    await runExport(h, {
      segmentBytes: ONE_MESSAGE,
      hooks: {
        afterSegment: async ({ kind }) => {
          if (kind !== 'data' || ++segments !== 1) return;
          await expectStatus(
            await h.call(`${community.base}/channels/${community.channelId}/leave`, {
              cookie: bob.cookie,
              body: {},
            }),
            200,
            'leave the channel'
          );
        },
      },
    });
    expect(segments).toBe(1);
    expect(await jobRow(h, requested.export.id)).toMatchObject({
      state: 'failed',
      failure_code: 'EXPORT_ACCESS_ENDED',
    });
  });

  // Purpose (AC-12): a job past COMMUNITY_EXPORT_MAX_HOURS fails and queues what it wrote.
  // Fails if the deadline is not enforced or its segments stay stored.
  it('fails a job past its deadline with EXPORT_TIMED_OUT and queues its segments', async () => {
    const community = await exportCommunity(h, operatorCookie, 'Deadline Place');
    await seedEntries(h, community, {
      authorMemberId: community.owner.memberId,
      count: 3,
      textOf: long('deadline'),
    });
    const requested = await requestOwnerExport(h, community);
    let clock = Date.now();
    let written: string[] = [];
    await runExport(h, {
      segmentBytes: ONE_MESSAGE,
      maxHours: 1,
      now: () => new Date(clock),
      hooks: {
        afterSegment: async () => {
          written = (await segmentsOf(h, requested.export.id)).map((segment) => segment.blob_key);
          clock += 2 * 3600_000;
        },
      },
    });
    expect(await jobRow(h, requested.export.id)).toMatchObject({
      state: 'failed',
      failure_code: 'EXPORT_TIMED_OUT',
    });
    expect(written).toHaveLength(1);
    expect(await segmentsOf(h, requested.export.id)).toEqual([]);
    const states = await h.pool.query(
      'SELECT state FROM managed_blobs WHERE blob_key=ANY($1::text[])',
      [written]
    );
    expect(states.rows).toEqual([{ state: 'pending_delete' }]);
  });
});

describe('restarts and isolation', () => {
  // Purpose (AC-4): a worker that dies after a data segment, and another that dies inside the
  // tail, leave a job the next worker finishes from the last committed segment, byte for byte
  // the archive an uninterrupted run writes; the dead writer's reservation is cleaned up. Fails
  // without per-segment commits (the work would restart or be lost) or with orphaned blobs.
  it('resumes after a worker dies, into the same bytes, with no orphaned blob', async () => {
    const community = await exportCommunity(h, operatorCookie, 'Restart Place');
    const entries = await seedEntries(h, community, {
      authorMemberId: community.owner.memberId,
      count: 3,
      textOf: long('restart'),
    });
    await seedFile(h, community, {
      entryId: entries[1].id,
      uploaderMemberId: community.owner.memberId,
      name: 'restart.txt',
      bytes: Buffer.from('restart bytes'),
    });
    const requested = await requestOwnerExport(h, community);
    const start = Date.now();
    const at = (minutes: number) => () => new Date(start + minutes * 60_000);
    // Dies after the first data segment.
    void runExport(h, {
      segmentBytes: ONE_MESSAGE,
      now: at(0),
      hooks: { afterSegment: () => forever() },
    });
    await until(async () => (await segmentsOf(h, requested.export.id)).length === 1, 'segment 1');
    // Another worker takes over once the lease has expired, and dies writing the tail.
    let inTail = false;
    void runExport(h, {
      segmentBytes: ONE_MESSAGE,
      now: at(6),
      hooks: {
        duringTail: () => {
          inTail = true;
          return forever();
        },
      },
    });
    await until(async () => inTail, 'the tail');
    expect(
      (await segmentsOf(h, requested.export.id)).filter((s) => s.kind === 'data')
    ).toHaveLength(3);
    const finish = at(12);
    expect(await runExport(h, { segmentBytes: ONE_MESSAGE, now: finish })).toBe(
      requested.export.id
    );
    expect(await jobRow(h, requested.export.id)).toMatchObject({ state: 'ready' });
    const resumed = await downloadArchive(h, community, requested.export.id);

    // The same job, uninterrupted, from the same inputs and clock.
    await transaction(h.pool, async (client: PoolClient) => {
      await dropSegments(client, requested.export.id, community.communityId);
      await client.query(
        `UPDATE export_archives SET state='queued',data_complete=false,rebuild_passes=0,
           ready_at=NULL,expires_at=NULL,byte_size=NULL,lease_until=NULL,progress_done=0
         WHERE id=$1`,
        [requested.export.id]
      );
      // Same inputs: the first run's own audit row is not part of them.
      await client.query(
        "DELETE FROM audit_events WHERE action='export.create' AND subject_id=$1",
        [requested.export.id]
      );
    });
    expect(await runExport(h, { segmentBytes: ONE_MESSAGE, now: finish })).toBe(
      requested.export.id
    );
    const uninterrupted = await downloadArchive(h, community, requested.export.id);
    expect(resumed.equals(uninterrupted)).toBe(true);

    await cleanUp(community.communityId);
    expect(await orphanExportBlobs(h, community.communityId)).toEqual([]);
    const reserved = await h.pool.query(
      "SELECT 1 FROM managed_blobs WHERE community_id=$1 AND purpose='export' AND state<>'committed'",
      [community.communityId]
    );
    expect(reserved.rowCount).toBe(0);
  });

  // Purpose (AC-13): one community's export never reads another's rows or blobs. Fails if any
  // query the worker makes returns a row naming community B, or it opens any of B's blobs.
  it('never reads another community’s rows or blobs', async () => {
    const a = await exportCommunity(h, operatorCookie, 'Isolation A');
    const b = await exportCommunity(h, operatorCookie, 'Isolation B');
    const bMember = await exportMember(h, b, 'Bea Other');
    const [aEntry] = await seedEntries(h, a, { authorMemberId: a.owner.memberId, count: 2 });
    const [bEntry] = await seedEntries(h, b, {
      authorMemberId: bMember.memberId,
      count: 2,
      textOf: () => 'b secret words',
    });
    await seedFile(h, a, {
      entryId: aEntry.id,
      uploaderMemberId: a.owner.memberId,
      name: 'a.txt',
      bytes: Buffer.from('a bytes'),
    });
    const bFile = await seedFile(h, b, {
      entryId: bEntry.id,
      uploaderMemberId: bMember.memberId,
      name: 'b.txt',
      bytes: Buffer.from('b bytes'),
    });
    const seen: string[] = [];
    const record = (result: QueryResult) => {
      seen.push(JSON.stringify(result.rows));
      return result;
    };
    const wrap = <T extends Pool | PoolClient>(target: T): T =>
      new Proxy(target, {
        get(object, property) {
          if (property === 'query')
            return async (...args: unknown[]) =>
              record(await (object.query as (...a: unknown[]) => Promise<QueryResult>)(...args));
          if (property === 'connect' && 'connect' in object && 'totalCount' in object)
            return async () => wrap(await (object as Pool).connect());
          const value = Reflect.get(object, property);
          return typeof value === 'function' ? value.bind(object) : value;
        },
      });
    const keys: string[] = [];
    const store: BlobStore = {
      put: (input) => h.blobStore.put(input),
      get: (key, options) => {
        keys.push(key);
        return h.blobStore.get(key, options);
      },
      delete: (key, options) => h.blobStore.delete(key, options),
      listNamespace: (options) => h.blobStore.listNamespace(options),
    };
    const requested = await requestOwnerExport(h, a);
    expect(await runExport(h, { pool: wrap(h.pool), blobStore: store })).toBe(requested.export.id);
    expect(await jobRow(h, requested.export.id)).toMatchObject({ state: 'ready' });
    const forbidden = [
      b.communityId,
      b.channelId,
      b.owner.memberId,
      bMember.memberId,
      bEntry.id,
      bFile.id,
      bFile.blobKey,
      'b secret words',
    ];
    expect(seen.length).toBeGreaterThan(20);
    for (const value of forbidden) expect(seen.join('\n')).not.toContain(value);
    expect(keys).not.toContain(bFile.blobKey);
  });
});
