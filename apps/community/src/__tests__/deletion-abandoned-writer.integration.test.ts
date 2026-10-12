/**
 * A community is deleted even when one of its uploads never reported back (DOR-2872).
 *
 * A writer that never confirmed leaves its key tombstoned: the file may still be published late,
 * so every sweep deletes it again and the community deletion waits. That wait used to have no
 * end. Now the writer is abandoned `MANAGED_BLOB_WRITER_ABANDONED_MS` after its reservation, one
 * more delete settles it, and a file already gone from storage counts as deleted.
 *
 * Tests run in order and share one community.
 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import { findOverdueCommunityDeletions, sweepCommunityDeletions } from '../deletion-worker.js';
import { MANAGED_BLOB_WRITER_ABANDONED_MS } from '../storage/managed-blobs.js';
import { sweepPendingBlobDeletions } from '../storage/pending-deletions.js';
import {
  TENANCY_PASSWORD,
  bootstrapHost,
  expectStatus,
  startTenancyHarness,
  type TenancyHarness,
} from './tenancy-test-harness.js';

let h: TenancyHarness;
let cookie = '';
let communityId = '';

const tenant = () => `/api/v1/communities/${communityId}`;

/** Insert an upload whose writer never reported back and whose file is not in storage. */
async function insertUnconfirmedUpload(key: string, ageMs: number): Promise<void> {
  await h.pool.query(
    `INSERT INTO managed_blobs(blob_key,community_id,purpose,community_lifecycle_version,state,
       created_at)
     SELECT $1,$2,'attachment',lifecycle_version,'pending_delete',
       now()-($3 * interval '1 millisecond') FROM communities WHERE id=$2`,
    [key, communityId, ageMs]
  );
  await h.pool.query(
    `INSERT INTO pending_blob_deletions(blob_key,attempts,next_attempt_at)
     VALUES($1,3,now()+interval '1 hour')`,
    [key]
  );
}

/** Run the deletion worker until it completes or `passes` runs out. */
async function sweepUntilDeleted(passes: number): Promise<number> {
  let completed = 0;
  for (let pass = 0; pass < passes && !completed; pass++) {
    completed = (await sweepCommunityDeletions(h.pool, h.blobStore, 100)).completed;
    await h.pool.query('UPDATE community_deletion_jobs SET next_attempt_at=now()');
    await h.pool.query('UPDATE community_deletion_blob_progress SET next_attempt_at=now()');
  }
  return completed;
}

beforeAll(async () => {
  h = await startTenancyHarness('abandoned_writer');
  const first = await bootstrapHost(h, 'Owner', 'owner@abandoned.test');
  cookie = first.cookie;
  communityId = first.communityId;
}, 60_000);

afterAll(async () => {
  await h?.close();
});

it('settles an abandoned writer in the pending-deletion sweep, and keeps a recent one', async () => {
  // Purpose: fails if the pending-deletion sweep deletes an abandoned writer's key every hour
  // for ever instead of settling it, or settles a writer still in its window.
  const recent = 'c'.repeat(64);
  const abandoned = 'd'.repeat(64);
  await insertUnconfirmedUpload(recent, 2 * 60 * 60 * 1000);
  await insertUnconfirmedUpload(abandoned, MANAGED_BLOB_WRITER_ABANDONED_MS + 60 * 60 * 1000);
  await h.pool.query("UPDATE pending_blob_deletions SET next_attempt_at=now()-interval '1 second'");

  expect(await sweepPendingBlobDeletions(h.pool, h.blobStore)).toEqual({ deleted: 1, failed: 0 });
  expect(
    (
      await h.pool.query<{ blob_key: string }>(
        'SELECT blob_key FROM managed_blobs WHERE blob_key = ANY($1)',
        [[recent, abandoned]]
      )
    ).rows
  ).toEqual([{ blob_key: recent }]);
  await h.pool.query('DELETE FROM pending_blob_deletions WHERE blob_key=$1', [recent]);
  await h.pool.query('DELETE FROM managed_blobs WHERE blob_key=$1', [recent]);
});

it('waits on a writer still in its window, then deletes the community once it is abandoned', async () => {
  // Purpose: fails if an unconfirmed upload whose file is already gone holds a community in
  // `deleting` past the abandonment window, or if a writer still in its window stops being
  // waited for.
  const recent = 'a'.repeat(64);
  const abandoned = 'b'.repeat(64);
  await insertUnconfirmedUpload(recent, 2 * 60 * 60 * 1000);
  await insertUnconfirmedUpload(abandoned, MANAGED_BLOB_WRITER_ABANDONED_MS + 60 * 60 * 1000);

  const version = (
    await h.pool.query<{ lifecycle_version: number }>(
      'SELECT lifecycle_version FROM communities WHERE id=$1',
      [communityId]
    )
  ).rows[0].lifecycle_version;
  await expectStatus(
    await h.call(`${tenant()}/owner/deletion`, {
      cookie,
      body: {
        lifecycleVersion: version,
        password: TENANCY_PASSWORD,
        confirmName: 'Owner Community',
        confirmIdSuffix: communityId.slice(-8),
      },
    }),
    200,
    'owner deletion request'
  );
  await h.pool.query(
    `UPDATE community_deletion_jobs SET delete_after=now()-interval '72 hours',
       next_attempt_at=now() WHERE community_id=$1`,
    [communityId]
  );

  // The recent writer may still publish, so the deletion waits, and says it is overdue.
  expect(await sweepUntilDeleted(5)).toBe(0);
  expect(
    (
      await h.pool.query<{ blob_key: string; state: string }>(
        'SELECT blob_key,state FROM community_deletion_blob_progress WHERE community_id=$1 ORDER BY blob_key',
        [communityId]
      )
    ).rows
  ).toEqual([
    { blob_key: recent, state: 'retrying' },
    { blob_key: abandoned, state: 'deleted' },
  ]);
  expect(await findOverdueCommunityDeletions(h.pool)).toEqual([
    expect.objectContaining({ communityId, overdueHours: 72 }),
  ]);

  // Once that writer is abandoned too, the next delete settles it and the community goes.
  await h.pool.query(
    "UPDATE managed_blobs SET created_at=created_at-interval '1 day' WHERE blob_key=$1",
    [recent]
  );
  expect(await sweepUntilDeleted(5)).toBe(1);
  expect(
    (await h.pool.query('SELECT 1 FROM communities WHERE id=$1', [communityId])).rowCount
  ).toBe(0);
  expect(
    (
      await h.pool.query('SELECT 1 FROM managed_blobs WHERE blob_key = ANY($1)', [
        [recent, abandoned],
      ])
    ).rowCount
  ).toBe(0);
  expect(await findOverdueCommunityDeletions(h.pool)).toEqual([]);
});
