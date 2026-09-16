import type { Pool } from 'pg';
import { transaction } from '../data.js';
import type { BlobStore } from './blob-store.js';

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

/** Delete an unreferenced blob, or persist retry work if storage is unavailable. */
export async function deleteUnreferencedBlob(pool: Pool, blobStore: BlobStore, key: string) {
  const referenced = await pool.query(
    'SELECT 1 FROM attachments WHERE blob_key=$1 UNION ALL SELECT 1 FROM export_archives WHERE blob_key=$1 LIMIT 1',
    [key]
  );
  if (referenced.rowCount) return;
  try {
    await blobStore.delete(key);
  } catch (error) {
    await pool.query(
      `INSERT INTO pending_blob_deletions(blob_key,attempts,last_error_at,next_attempt_at)
       VALUES($1,1,now(),now() + interval '1 minute')
       ON CONFLICT(blob_key) DO UPDATE SET
         attempts=pending_blob_deletions.attempts+1,
         last_error_at=now(),
         next_attempt_at=now() + ${cleanupBackoffSql('pending_blob_deletions.attempts')}`,
      [key]
    );
    console.error(
      'Community blob cleanup deferred',
      error instanceof Error ? error.name : 'unknown'
    );
  }
}

/** Retry a bounded batch of unreferenced blobs left by failed metadata operations. */
export async function sweepPendingBlobDeletions(pool: Pool, blobStore: BlobStore, batchSize = 50) {
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 100)
    throw new Error('Invalid pending blob sweep batch size');
  const candidates = await pool.query<{ blob_key: string }>(
    'SELECT blob_key FROM pending_blob_deletions WHERE next_attempt_at<=now() ORDER BY next_attempt_at,created_at,blob_key LIMIT $1',
    [batchSize]
  );
  let deleted = 0;
  let failed = 0;
  for (const candidate of candidates.rows) {
    const attempt: { outcome: 'deleted' | 'failed' | 'skipped'; error?: unknown } = {
      outcome: 'skipped',
    };
    try {
      await transaction(pool, async (client) => {
        const row = await client.query<{ blob_key: string }>(
          'SELECT blob_key FROM pending_blob_deletions WHERE blob_key=$1 AND next_attempt_at<=now() FOR UPDATE',
          [candidate.blob_key]
        );
        if (!row.rows[0]) return;
        const referenced = await client.query(
          'SELECT 1 FROM attachments WHERE blob_key=$1 UNION ALL SELECT 1 FROM export_archives WHERE blob_key=$1 LIMIT 1',
          [candidate.blob_key]
        );
        if (referenced.rowCount) {
          await client.query('DELETE FROM pending_blob_deletions WHERE blob_key=$1', [
            candidate.blob_key,
          ]);
          return;
        }
        try {
          await blobStore.delete(candidate.blob_key);
        } catch (error) {
          await client.query(
            `UPDATE pending_blob_deletions
             SET attempts=attempts+1,last_error_at=now(),next_attempt_at=now() + ${cleanupBackoffSql('attempts')}
             WHERE blob_key=$1`,
            [candidate.blob_key]
          );
          attempt.outcome = 'failed';
          attempt.error = error;
          return;
        }
        await client.query('DELETE FROM pending_blob_deletions WHERE blob_key=$1', [
          candidate.blob_key,
        ]);
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
