import type { Pool } from 'pg';
import { transaction } from '../data.js';
import type { BlobStore } from '../storage/index.js';
import {
  BLOB_DELETE_TIMEOUT_MS,
  cleanupBackoffSql,
  communityFilesDeletable,
} from '../storage/pending-deletions.js';
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
 * ended, so their rows are simply removed once they stop being listed. A ready evidence export
 * never expires here: the takedown worker deletes it once it has copied it to the evidence store.
 *
 * Nor does an archive of a community under a host legal hold. An export is a copy, but a hold
 * does not stop item removals, so an archive taken before one may be the last copy of what was
 * removed. It stays exactly as it is, segments and all, and expires on the first sweep after the
 * release. Nobody can download it meanwhile: downloads end at `expires_at` whatever this sweep
 * has done. Held archives are not candidates, so they never fill a batch, and the hold is read
 * again under the community row, held `FOR SHARE` through the delete, for a hold placed after
 * that read.
 */
export async function sweepExpiredExports(
  pool: Pool,
  blobStore: BlobStore,
  { now = new Date(), batchSize = 25 }: { now?: Date; batchSize?: number } = {}
): Promise<{ deleted: number; failed: number }> {
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 100)
    throw new Error('Invalid export sweep batch size');
  const result = await pool.query<{ id: string; community_id: string }>(
    `SELECT e.id,e.community_id FROM export_archives e
     WHERE e.state='ready' AND e.deleted_at IS NULL AND e.expires_at<$2
       AND e.cleanup_next_attempt_at<=now() AND e.scope<>'evidence'
       AND NOT EXISTS(
         SELECT 1 FROM communities c WHERE c.id=e.community_id AND c.legal_hold_at IS NOT NULL
       )
     ORDER BY e.cleanup_next_attempt_at,e.expires_at,e.id LIMIT $1`,
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
        if (!(await communityFilesDeletable(client, row.community_id))) return;
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
            await blobStore.delete(archive.blob_key, {
              signal: AbortSignal.timeout(BLOB_DELETE_TIMEOUT_MS),
            });
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
