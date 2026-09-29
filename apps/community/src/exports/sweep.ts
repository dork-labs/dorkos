import type { Pool } from 'pg';
import { transaction } from '../data.js';
import type { BlobStore } from '../storage/index.js';
import { cleanupBackoffSql } from '../storage/pending-deletions.js';
import { dropSegments } from './store.js';

/** How long a failed or cancelled job stays listed before its row is removed. */
const ENDED_RETENTION_DAYS = 7;

/**
 * Reclaim expired archives and old ended jobs, a bounded batch of each.
 *
 * A ready archive past `expires_at` is marked deleted and its bytes go: a version 2 archive's
 * segments are queued for the pending-deletion sweep; a version 1 archive (written before
 * background exports, and gone within an hour of the upgrade) deletes its one blob here and keeps
 * failures for retry with backoff. Failed and cancelled jobs queued their segments when they
 * ended, so their rows are simply removed once they stop being listed.
 */
export async function sweepExpiredExports(
  pool: Pool,
  blobStore: BlobStore,
  { now = new Date(), batchSize = 25 }: { now?: Date; batchSize?: number } = {}
): Promise<{ deleted: number; failed: number }> {
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 100)
    throw new Error('Invalid export sweep batch size');
  const result = await pool.query<{ id: string }>(
    `SELECT id FROM export_archives
     WHERE state='ready' AND deleted_at IS NULL AND expires_at<$2 AND cleanup_next_attempt_at<=now()
     ORDER BY cleanup_next_attempt_at,expires_at,id LIMIT $1`,
    [batchSize, now]
  );
  let deleted = 0;
  let failed = 0;
  for (const row of result.rows) {
    const attempt: { outcome: 'deleted' | 'failed' | 'skipped'; error?: unknown } = {
      outcome: 'skipped',
    };
    try {
      await transaction(pool, async (client) => {
        const current = await client.query<{ blob_key: string | null; community_id: string }>(
          `SELECT blob_key,community_id FROM export_archives
           WHERE id=$1 AND state='ready' AND deleted_at IS NULL AND expires_at<$2
             AND cleanup_next_attempt_at<=now()
           FOR UPDATE`,
          [row.id, now]
        );
        const archive = current.rows[0];
        if (!archive) return;
        if (archive.blob_key) {
          try {
            await blobStore.delete(archive.blob_key);
          } catch (error) {
            await client.query(
              `UPDATE export_archives
               SET cleanup_attempts=cleanup_attempts+1,cleanup_next_attempt_at=now() + ${cleanupBackoffSql('cleanup_attempts')}
               WHERE id=$1 AND deleted_at IS NULL`,
              [row.id]
            );
            attempt.outcome = 'failed';
            attempt.error = error;
            return;
          }
          await client.query('DELETE FROM managed_blobs WHERE blob_key=$1', [archive.blob_key]);
        } else {
          await dropSegments(client, row.id, archive.community_id);
        }
        await client.query('UPDATE export_archives SET deleted_at=$2 WHERE id=$1', [row.id, now]);
        await client.query(
          'INSERT INTO audit_events(community_id,action,subject_id) VALUES($1,$2,$3)',
          [archive.community_id, 'export.expire', row.id]
        );
        attempt.outcome = 'deleted';
      });
    } catch (error) {
      attempt.outcome = 'failed';
      attempt.error = error;
    }
    if (attempt.outcome === 'deleted') {
      deleted++;
    } else if (attempt.outcome === 'failed') {
      failed++;
      console.error('Community export cleanup failed', {
        archiveId: row.id,
        error: attempt.error instanceof Error ? attempt.error.name : 'unknown',
      });
    }
  }
  await transaction(pool, async (client) => {
    const ended = await client.query<{ id: string; community_id: string }>(
      `SELECT id,community_id FROM export_archives
       WHERE state IN ('failed','cancelled') AND ended_at<$2::timestamptz - $3 * interval '1 day'
       ORDER BY ended_at LIMIT $1 FOR UPDATE SKIP LOCKED`,
      [batchSize, now, ENDED_RETENTION_DAYS]
    );
    for (const job of ended.rows) {
      // Nothing should be left, since ending a job queues its segments; this keeps it so.
      await dropSegments(client, job.id, job.community_id);
      await client.query('DELETE FROM export_archives WHERE id=$1', [job.id]);
    }
  });
  return { deleted, failed };
}
