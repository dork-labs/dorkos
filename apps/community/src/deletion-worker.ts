import type { Pool } from 'pg';
import { transaction } from './data.js';
import { BlobStoreError, type BlobStore } from './storage/index.js';

const DELETE_BATCH = 25;

function safeDeleteError(error: unknown): string {
  return error instanceof BlobStoreError ? error.code : 'BLOB_DELETE_FAILED';
}

/** Delete one due tenant in bounded, restart-safe object and database phases. */
export async function sweepCommunityDeletions(
  pool: Pool,
  blobStore: BlobStore,
  blobBatchSize = DELETE_BATCH
): Promise<{ claimed: number; deletedBlobs: number; completed: number; failed: number }> {
  if (!Number.isInteger(blobBatchSize) || blobBatchSize < 1 || blobBatchSize > 100)
    throw new Error('Invalid community deletion batch size');
  const job = await transaction(pool, async (client) => {
    const selected = await client.query<{
      community_id: string;
      lifecycle_version: number;
      created_at: Date;
      attempts: number;
    }>(
      `SELECT community_id,lifecycle_version,created_at,attempts
       FROM community_deletion_jobs
       WHERE delete_after<=now() AND next_attempt_at<=now()
       ORDER BY next_attempt_at,community_id
       FOR UPDATE SKIP LOCKED LIMIT 1`
    );
    const row = selected.rows[0];
    if (!row) return null;
    const community = await client.query<{ lifecycle: string; lifecycle_version: number }>(
      'SELECT lifecycle,lifecycle_version FROM communities WHERE id=$1 FOR UPDATE',
      [row.community_id]
    );
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
      `UPDATE community_deletion_jobs SET state='deleting',updated_at=now(),last_error_class=NULL
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
      const marked = await pool.query(
        `UPDATE community_deletion_blob_progress
         SET state='deleted',deleted_at=now(),last_error_class=NULL
         WHERE community_id=$1 AND blob_key=$2 AND state<>'deleted'`,
        [job.community_id, candidate.blob_key]
      );
      if (marked.rowCount) deletedBlobs++;
    } catch (error) {
      failed++;
      await transaction(pool, async (client) => {
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
    const locked = await client.query<{ created_at: Date; attempts: number }>(
      `SELECT created_at,attempts FROM community_deletion_jobs
       WHERE community_id=$1 AND delete_after<=now() FOR UPDATE`,
      [job.community_id]
    );
    if (!locked.rows[0]) return false;
    const incomplete = await client.query(
      `SELECT 1 FROM managed_blobs m
       LEFT JOIN community_deletion_blob_progress p
         ON p.community_id=m.community_id AND p.blob_key=m.blob_key
       WHERE m.community_id=$1 AND (p.blob_key IS NULL OR p.state<>'deleted') LIMIT 1`,
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

    await client.query(
      `UPDATE communities SET lifecycle='pending_owner',icon_blob_key=NULL,icon_content_type=NULL,
         suspended_from_state=NULL,suspended_at=NULL,archived_at=NULL,
         delete_requested_at=NULL,delete_after=NULL,delete_requested_by=NULL,
         lifecycle_version=lifecycle_version+1 WHERE id=$1`,
      [job.community_id]
    );
    await client.query('DELETE FROM community_deletion_jobs WHERE community_id=$1', [
      job.community_id,
    ]);
    for (const table of [
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
         community_id,requested_at,completed_at,outcome,retry_count,expires_at
       ) VALUES($1,$2,$3,'deleted',$4,$3::timestamptz+interval '30 days')`,
      [job.community_id, locked.rows[0].created_at, now, locked.rows[0].attempts]
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
