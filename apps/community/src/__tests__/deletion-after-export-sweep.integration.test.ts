/**
 * A community whose export expired and was swept can still be deleted (DOR-2269).
 *
 * The export sweep deletes the archive's object and its managed-blob row but keeps the archive
 * row, marked `deleted_at`, for the audit trail. The deletion inventory must not count that row
 * as a missing object, or every deletion request for the community is refused with
 * "Storage ownership must be reconciled" for ever.
 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import { sweepCommunityDeletions } from '../deletion-worker.js';
import { sweepExpiredExports } from '../routes/exports.js';
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

beforeAll(async () => {
  h = await startTenancyHarness('swept_export');
  const first = await bootstrapHost(h, 'Owner', 'owner@swept.test');
  cookie = first.cookie;
  communityId = first.communityId;
}, 60_000);

afterAll(async () => {
  await h?.close();
});

it('deletes a community after one of its exports expired and was swept', async () => {
  // Purpose: fails if a swept export's kept archive row blocks the community's deletion.
  await expectStatus(
    await h.call(`${tenant()}/owner/export`, { cookie, body: { password: TENANCY_PASSWORD } }),
    201,
    'owner export'
  );
  await h.pool.query(
    "UPDATE export_archives SET expires_at=now()-interval '1 minute' WHERE community_id=$1",
    [communityId]
  );
  await sweepExpiredExports(h.pool, h.blobStore);
  const archive = await h.pool.query<{ deleted_at: Date | null; blob_key: string }>(
    'SELECT deleted_at,blob_key FROM export_archives WHERE community_id=$1',
    [communityId]
  );
  expect(archive.rows).toHaveLength(1);
  expect(archive.rows[0].deleted_at).not.toBeNull();
  expect(
    (
      await h.pool.query('SELECT 1 FROM managed_blobs WHERE blob_key=$1', [
        archive.rows[0].blob_key,
      ])
    ).rowCount
  ).toBe(0);

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
    `UPDATE community_deletion_jobs SET delete_after=now()-interval '1 second',
       next_attempt_at=now() WHERE community_id=$1`,
    [communityId]
  );
  let completed = 0;
  for (let pass = 0; pass < 10 && !completed; pass++) {
    completed = (await sweepCommunityDeletions(h.pool, h.blobStore, 100)).completed;
    await h.pool.query('UPDATE community_deletion_jobs SET next_attempt_at=now()');
  }
  expect(completed).toBe(1);
  expect(
    (await h.pool.query('SELECT 1 FROM export_archives WHERE community_id=$1', [communityId]))
      .rowCount
  ).toBe(0);
});
