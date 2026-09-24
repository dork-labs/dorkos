import type { Pool } from 'pg';
import { transaction } from './data.js';
import { releaseCommunityShortNames, type ShortNameHolds } from './host/short-names.js';
import { BlobStoreError, reconcileTenantNamespace, type BlobStore } from './storage/index.js';

const DELETE_BATCH = 25;
const MISSING_DELETION_INVENTORY_SQL = `
  SELECT a.blob_key FROM attachments a
  LEFT JOIN managed_blobs m ON m.blob_key=a.blob_key
    AND m.community_id=a.community_id AND m.purpose='attachment'
  WHERE a.community_id=$1 AND (m.blob_key IS NULL OR m.state<>'committed')
  UNION ALL
  SELECT e.blob_key FROM export_archives e
  LEFT JOIN managed_blobs m ON m.blob_key=e.blob_key
    AND m.community_id=e.community_id AND m.purpose='export'
  WHERE e.community_id=$1 AND (m.blob_key IS NULL OR m.state<>'committed')
  UNION ALL
  SELECT c.icon_blob_key FROM communities c
  LEFT JOIN managed_blobs m ON m.blob_key=c.icon_blob_key
    AND m.community_id=c.id AND m.purpose='icon'
  WHERE c.id=$1 AND c.icon_blob_key IS NOT NULL
    AND (m.blob_key IS NULL OR m.state<>'committed')`;

function safeDeleteError(error: unknown): string {
  return error instanceof BlobStoreError ? error.code : 'BLOB_DELETE_FAILED';
}

async function countMissingDeletionInventory(pool: Pool, communityId: string): Promise<number> {
  const result = await pool.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM (${MISSING_DELETION_INVENTORY_SQL}) missing`,
    [communityId]
  );
  return result.rows[0]?.count ?? 0;
}

/** Adopt verified legacy singleton blobs before permanent deletion can be requested. */
export async function prepareCommunityDeletionInventory(
  pool: Pool,
  blobStore: BlobStore,
  communityId: string
): Promise<boolean> {
  const state = await pool.query<{ count: number; multiple_used: boolean }>(
    `SELECT (SELECT count(*)::int FROM communities) AS count,
            (SELECT multiple_communities_used FROM community_backout_fence WHERE singleton)
              AS multiple_used`
  );
  const host = state.rows[0];
  // A host which has never admitted a second tenant has no durable proof that its legacy
  // namespace was ever inventoried. Re-run the complete gate even when no relational reference
  // is missing so unexplained legacy objects block deletion instead of becoming silent orphans.
  if (host?.count === 1 && !host.multiple_used) {
    const reconciliation = await reconcileTenantNamespace(pool, blobStore);
    return reconciliation.ready && (await countMissingDeletionInventory(pool, communityId)) === 0;
  }
  return (await countMissingDeletionInventory(pool, communityId)) === 0;
}

/**
 * Delete one due tenant in bounded, restart-safe object and database phases.
 *
 * `shortNameHolds` is how a deleted community's short names are held back from reuse. A
 * community that has names is not finished without it: the job stays retrying with
 * `SHORT_NAME_HOLDS_REQUIRED`, so no name is ever freed at once or left behind in clear text.
 * `now` is the clock a hold's cool-off starts from.
 */
export async function sweepCommunityDeletions(
  pool: Pool,
  blobStore: BlobStore,
  blobBatchSize = DELETE_BATCH,
  options: { shortNameHolds?: ShortNameHolds; now?: () => Date } = {}
): Promise<{ claimed: number; deletedBlobs: number; completed: number; failed: number }> {
  if (!Number.isInteger(blobBatchSize) || blobBatchSize < 1 || blobBatchSize > 100)
    throw new Error('Invalid community deletion batch size');
  const job = await transaction(pool, async (client) => {
    const selected = await client.query<{ community_id: string }>(
      `SELECT community_id
       FROM community_deletion_jobs
       WHERE delete_after<=now() AND next_attempt_at<=now()
       ORDER BY next_attempt_at,community_id
       LIMIT 1`
    );
    const candidate = selected.rows[0];
    if (!candidate) return null;
    const community = await client.query<{ lifecycle: string; lifecycle_version: number }>(
      'SELECT lifecycle,lifecycle_version FROM communities WHERE id=$1 FOR UPDATE SKIP LOCKED',
      [candidate.community_id]
    );
    if (!community.rows[0]) return null;
    const lockedJob = await client.query<{
      community_id: string;
      lifecycle_version: number;
      created_at: Date;
      attempts: number;
    }>(
      `SELECT community_id,lifecycle_version,created_at,attempts
       FROM community_deletion_jobs
       WHERE community_id=$1 AND delete_after<=now() AND next_attempt_at<=now()
       FOR UPDATE SKIP LOCKED`,
      [candidate.community_id]
    );
    const row = lockedJob.rows[0];
    if (!row) return null;
    if (
      community.rows[0]?.lifecycle !== 'deletion_pending' ||
      community.rows[0].lifecycle_version !== row.lifecycle_version
    ) {
      await client.query('DELETE FROM community_deletion_jobs WHERE community_id=$1', [
        row.community_id,
      ]);
      return null;
    }
    await client.query(
      `INSERT INTO community_deletion_blob_progress(community_id,blob_key)
       SELECT community_id,blob_key FROM managed_blobs WHERE community_id=$1
       ON CONFLICT(community_id,blob_key) DO NOTHING`,
      [row.community_id]
    );
    await client.query(
      `UPDATE community_deletion_jobs
       SET state='deleting',next_attempt_at=now()+interval '5 minutes',updated_at=now(),last_error_class=NULL
       WHERE community_id=$1`,
      [row.community_id]
    );
    return row;
  });
  if (!job) return { claimed: 0, deletedBlobs: 0, completed: 0, failed: 0 };

  const candidates = await pool.query<{ blob_key: string }>(
    `SELECT blob_key FROM community_deletion_blob_progress
     WHERE community_id=$1 AND state<>'deleted' AND next_attempt_at<=now()
     ORDER BY next_attempt_at,blob_key LIMIT $2`,
    [job.community_id, blobBatchSize]
  );
  let deletedBlobs = 0;
  let failed = 0;
  for (const candidate of candidates.rows) {
    try {
      await blobStore.delete(candidate.blob_key);
      // An absent object does not settle a writer that still owns this key. Its
      // delayed put may ignore cancellation and publish after this delete.
      const marked = await pool.query(
        `UPDATE community_deletion_blob_progress p
         SET state='deleted',deleted_at=now(),last_error_class=NULL
         WHERE p.community_id=$1 AND p.blob_key=$2 AND p.state<>'deleted'
           AND NOT EXISTS(
             SELECT 1 FROM managed_blobs m
             LEFT JOIN pending_blob_deletions q ON q.blob_key=m.blob_key
             WHERE m.community_id=p.community_id AND m.blob_key=p.blob_key
               AND (
                 m.state IN ('reserved','stored')
                 OR (
                   m.state='pending_delete'
                   AND m.committed_at IS NULL
                   AND (q.blob_key IS NULL OR q.last_error_at IS NULL)
                 )
               )
           )`,
        [job.community_id, candidate.blob_key]
      );
      if (marked.rowCount) {
        deletedBlobs++;
      } else {
        await pool.query(
          `UPDATE community_deletion_blob_progress
           SET state='retrying',next_attempt_at=now()+interval '1 minute'
           WHERE community_id=$1 AND blob_key=$2 AND state<>'deleted'`,
          [job.community_id, candidate.blob_key]
        );
      }
    } catch (error) {
      failed++;
      await transaction(pool, async (client) => {
        const community = await client.query('SELECT 1 FROM communities WHERE id=$1 FOR UPDATE', [
          job.community_id,
        ]);
        if (!community.rowCount) return;
        const lockedJob = await client.query(
          'SELECT 1 FROM community_deletion_jobs WHERE community_id=$1 FOR UPDATE',
          [job.community_id]
        );
        if (!lockedJob.rowCount) return;
        await client.query(
          `UPDATE community_deletion_blob_progress
           SET state='retrying',attempts=attempts+1,last_error_class=$3,
               next_attempt_at=now()+LEAST(interval '1 hour',interval '1 minute' * power(2,LEAST(attempts,6)))
           WHERE community_id=$1 AND blob_key=$2 AND state<>'deleted'`,
          [job.community_id, candidate.blob_key, safeDeleteError(error)]
        );
        await client.query(
          `UPDATE community_deletion_jobs
           SET state='retrying',attempts=attempts+1,last_error_class=$2,
               next_attempt_at=now()+LEAST(interval '1 hour',interval '1 minute' * power(2,LEAST(attempts,6))),
               updated_at=now() WHERE community_id=$1`,
          [job.community_id, safeDeleteError(error)]
        );
      });
    }
  }
  if (failed) return { claimed: 1, deletedBlobs, completed: 0, failed };

  const completed = await transaction(pool, async (client) => {
    const community = await client.query<{ lifecycle: string; lifecycle_version: number }>(
      'SELECT lifecycle,lifecycle_version FROM communities WHERE id=$1 FOR UPDATE',
      [job.community_id]
    );
    if (
      community.rows[0]?.lifecycle !== 'deletion_pending' ||
      community.rows[0].lifecycle_version !== job.lifecycle_version
    )
      return false;
    const locked = await client.query<{
      created_at: Date;
      attempts: number;
      requested_by_host_actor: string | null;
    }>(
      `SELECT created_at,attempts,requested_by_host_actor FROM community_deletion_jobs
       WHERE community_id=$1 AND delete_after<=now() FOR UPDATE`,
      [job.community_id]
    );
    if (!locked.rows[0]) return false;
    const missingInventory = await client.query(
      `SELECT 1 FROM (${MISSING_DELETION_INVENTORY_SQL}) missing LIMIT 1`,
      [job.community_id]
    );
    if (missingInventory.rowCount) {
      await client.query(
        `UPDATE community_deletion_jobs
         SET state='retrying',next_attempt_at=now()+interval '1 hour',
             updated_at=now(),last_error_class='INCOMPLETE_BLOB_INVENTORY'
         WHERE community_id=$1`,
        [job.community_id]
      );
      return false;
    }
    const incomplete = await client.query(
      // Recheck writer uncertainty under the final community lock so progress
      // recorded by an older worker cannot discard its durable tombstone.
      `SELECT 1 FROM managed_blobs m
       LEFT JOIN community_deletion_blob_progress p
         ON p.community_id=m.community_id AND p.blob_key=m.blob_key
       LEFT JOIN pending_blob_deletions q ON q.blob_key=m.blob_key
       WHERE m.community_id=$1 AND (
         p.blob_key IS NULL
         OR p.state<>'deleted'
         OR m.state IN ('reserved','stored')
         OR (
           m.state='pending_delete'
           AND m.committed_at IS NULL
           AND (q.blob_key IS NULL OR q.last_error_at IS NULL)
         )
       ) LIMIT 1`,
      [job.community_id]
    );
    if (incomplete.rowCount) {
      await client.query(
        `UPDATE community_deletion_jobs SET next_attempt_at=now()+interval '1 minute',updated_at=now()
         WHERE community_id=$1`,
        [job.community_id]
      );
      return false;
    }

    const named = await client.query('SELECT 1 FROM community_short_names WHERE community_id=$1', [
      job.community_id,
    ]);
    if (named.rowCount && !options.shortNameHolds) {
      await client.query(
        `UPDATE community_deletion_jobs
         SET state='retrying',next_attempt_at=now()+interval '1 hour',
             updated_at=now(),last_error_class='SHORT_NAME_HOLDS_REQUIRED'
         WHERE community_id=$1`,
        [job.community_id]
      );
      return false;
    }
    await client.query(
      `UPDATE communities SET lifecycle='pending_owner',icon_blob_key=NULL,icon_content_type=NULL,
         suspended_from_state=NULL,suspended_at=NULL,archived_at=NULL,
         held_from_state=NULL,held_at=NULL,deletion_notice_at=NULL,
         delete_requested_at=NULL,delete_after=NULL,delete_requested_by=NULL,
         delete_requested_by_host_actor=NULL,
         lifecycle_version=lifecycle_version+1 WHERE id=$1`,
      [job.community_id]
    );
    await client.query('DELETE FROM community_deletion_jobs WHERE community_id=$1', [
      job.community_id,
    ]);
    if (named.rowCount && options.shortNameHolds)
      await releaseCommunityShortNames(client, job.community_id, {
        hold: true,
        holds: options.shortNameHolds,
        at: options.now?.() ?? new Date(),
      });
    for (const table of [
      'member_limit_overrides',
      'community_limits',
      'entry_mentions',
      'export_archive_channels',
      'read_cursors',
      'attachments',
      'entries',
      'agent_channel_members',
      'channel_members',
      'agent_credentials',
      'community_handles',
      'export_archives',
      'owner_quota_windows',
      'invite_uses',
      'pending_admissions',
      'connection_grants',
      'connection_pairings',
      'invites',
      'audit_events',
      'agents',
      'channels',
    ]) {
      // content-change: tenant-deletion
      await client.query(`DELETE FROM ${table} WHERE community_id=$1`, [job.community_id]);
    }
    await client.query('DELETE FROM community_creation_receipts WHERE community_id=$1', [
      job.community_id,
    ]);
    await client.query('DELETE FROM bootstrap_grants WHERE community_id=$1', [job.community_id]);
    await client.query('DELETE FROM host_audit_events WHERE community_id=$1', [job.community_id]);
    await client.query(
      `DELETE FROM pending_blob_deletions p USING managed_blobs m
       WHERE p.blob_key=m.blob_key AND m.community_id=$1`,
      [job.community_id]
    );
    await client.query('DELETE FROM managed_blobs WHERE community_id=$1', [job.community_id]);
    await client.query('DELETE FROM community_deletion_blob_progress WHERE community_id=$1', [
      job.community_id,
    ]);
    await client.query('DELETE FROM members WHERE community_id=$1', [job.community_id]);
    await client.query(
      `UPDATE tenant_reconciliation SET community_id=NULL,state='dirty',validated_generation=NULL,
         namespace_digest=NULL,completed_at=NULL,invalidated_at=now(),reason_code='tenant_deleted'
       WHERE community_id=$1`,
      [job.community_id]
    );
    const now = new Date();
    await client.query(
      `INSERT INTO community_deletion_tombstones(
         community_id,requested_at,completed_at,outcome,retry_count,expires_at,
         requested_by,requested_by_host_actor
       ) VALUES($1,$2,$3,'deleted',$4,$3::timestamptz+interval '30 days',$5,$6)`,
      [
        job.community_id,
        locked.rows[0].created_at,
        now,
        locked.rows[0].attempts,
        locked.rows[0].requested_by_host_actor ? 'host' : 'owner',
        locked.rows[0].requested_by_host_actor,
      ]
    );
    await client.query('DELETE FROM communities WHERE id=$1', [job.community_id]);
    return true;
  });
  return { claimed: 1, deletedBlobs, completed: completed ? 1 : 0, failed: 0 };
}

/** Remove expired content-free tenant deletion receipts. */
export async function sweepCommunityDeletionTombstones(pool: Pool): Promise<number> {
  const result = await pool.query(
    'DELETE FROM community_deletion_tombstones WHERE expires_at<=now()'
  );
  return result.rowCount ?? 0;
}
