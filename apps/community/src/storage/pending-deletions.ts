import type { Pool } from 'pg';
import { transaction } from '../data.js';
import type { BlobStore } from './blob-store.js';
import { MANAGED_BLOB_RESERVATION_TTL_MS } from './managed-blobs.js';

/**
 * Build a capped database-clock retry delay for a trusted cleanup attempt column.
 *
 * The first retry waits one minute, each later failure doubles that wait, and
 * retries remain eligible forever at the one-hour cap.
 */
export function cleanupBackoffSql(
  attemptsColumn: 'attempts' | 'pending_blob_deletions.attempts' | 'cleanup_attempts'
): string {
  return `LEAST(interval '1 hour', interval '1 minute' * power(2, LEAST(${attemptsColumn}, 6)))`;
}

/** Retry a bounded batch of unreferenced blobs left by failed metadata operations. */
export async function sweepPendingBlobDeletions(pool: Pool, blobStore: BlobStore, batchSize = 50) {
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 100)
    throw new Error('Invalid pending blob sweep batch size');
  const candidates = await pool.query<{ blob_key: string }>(
    `SELECT blob_key
     FROM (
       SELECT blob_key,next_attempt_at AS eligible_at FROM pending_blob_deletions
       WHERE next_attempt_at<=now()
       UNION
       SELECT blob_key,created_at AS eligible_at FROM managed_blobs
       WHERE (state='pending_delete' AND NOT EXISTS(
                SELECT 1 FROM pending_blob_deletions p WHERE p.blob_key=managed_blobs.blob_key
              ))
          OR (state IN ('reserved','stored') AND created_at<=now()-($2 * interval '1 millisecond'))
     ) candidates
     ORDER BY eligible_at,blob_key LIMIT $1`,
    [batchSize, MANAGED_BLOB_RESERVATION_TTL_MS]
  );
  let deleted = 0;
  let failed = 0;
  for (const candidate of candidates.rows) {
    const attempt: { outcome: 'deleted' | 'failed' | 'skipped'; error?: unknown } = {
      outcome: 'skipped',
    };
    try {
      await transaction(pool, async (client) => {
        const managed = await client.query<{ state: string; lease_expired: boolean }>(
          `SELECT state,created_at<=now()-($2 * interval '1 millisecond') AS lease_expired
           FROM managed_blobs WHERE blob_key=$1 FOR UPDATE`,
          [candidate.blob_key, MANAGED_BLOB_RESERVATION_TTL_MS]
        );
        const queue = await client.query<{ blob_key: string; outcome_uncertain: boolean }>(
          `SELECT blob_key,last_error_at IS NULL AS outcome_uncertain
           FROM pending_blob_deletions
           WHERE blob_key=$1 AND next_attempt_at<=now() FOR UPDATE`,
          [candidate.blob_key]
        );
        const managedRow = managed.rows[0];
        const outcomeUncertain = Boolean(
          managedRow && (!queue.rows[0] || queue.rows[0].outcome_uncertain)
        );
        const staleReservation =
          managedRow &&
          (managedRow.state === 'reserved' || managedRow.state === 'stored') &&
          managedRow.lease_expired;
        if (!queue.rows[0] && managedRow?.state !== 'pending_delete' && !staleReservation) return;
        const referenced = await client.query(
          'SELECT 1 FROM attachments WHERE blob_key=$1 UNION ALL SELECT 1 FROM export_archives WHERE blob_key=$1 LIMIT 1',
          [candidate.blob_key]
        );
        if (referenced.rowCount) {
          if (!managedRow || managedRow.state === 'committed') {
            await client.query('DELETE FROM pending_blob_deletions WHERE blob_key=$1', [
              candidate.blob_key,
            ]);
          }
          return;
        }
        if (staleReservation) {
          await client.query(
            "UPDATE managed_blobs SET state='pending_delete' WHERE blob_key=$1 AND state IN ('reserved','stored')",
            [candidate.blob_key]
          );
          await client.query(
            `INSERT INTO pending_blob_deletions(blob_key,attempts,next_attempt_at)
             VALUES($1,0,now()+interval '1 minute') ON CONFLICT(blob_key) DO NOTHING`,
            [candidate.blob_key]
          );
          return;
        } else if (managedRow && managedRow.state !== 'pending_delete') {
          return;
        } else if (managedRow && !queue.rows[0]) {
          await client.query(
            `INSERT INTO pending_blob_deletions(blob_key,attempts,next_attempt_at)
             VALUES($1,0,now()) ON CONFLICT(blob_key) DO NOTHING`,
            [candidate.blob_key]
          );
        }
        try {
          await blobStore.delete(candidate.blob_key);
        } catch (error) {
          await client.query(
            `UPDATE pending_blob_deletions
             SET attempts=attempts+1,
                 last_error_at=CASE WHEN $2 THEN last_error_at ELSE now() END,
                 next_attempt_at=now() + ${cleanupBackoffSql('attempts')}
             WHERE blob_key=$1`,
            [candidate.blob_key, outcomeUncertain]
          );
          attempt.outcome = 'failed';
          attempt.error = error;
          return;
        }
        if (outcomeUncertain) {
          await client.query(
            `UPDATE pending_blob_deletions
             SET attempts=attempts+1,next_attempt_at=now()+interval '1 hour'
             WHERE blob_key=$1`,
            [candidate.blob_key]
          );
          return;
        }
        await client.query('DELETE FROM pending_blob_deletions WHERE blob_key=$1', [
          candidate.blob_key,
        ]);
        await client.query(
          "DELETE FROM managed_blobs WHERE blob_key=$1 AND state='pending_delete'",
          [candidate.blob_key]
        );
        attempt.outcome = 'deleted';
      });
    } catch (error) {
      failed++;
      console.error(
        'Community pending blob cleanup failed',
        error instanceof Error ? error.name : 'unknown'
      );
      continue;
    }
    if (attempt.outcome === 'deleted') {
      deleted++;
    } else if (attempt.outcome === 'failed') {
      failed++;
      console.error(
        'Community pending blob cleanup failed',
        attempt.error instanceof Error ? attempt.error.name : 'unknown'
      );
    }
  }
  return { deleted, failed };
}
