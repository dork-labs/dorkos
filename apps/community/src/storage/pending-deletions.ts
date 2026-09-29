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
  attemptsColumn:
    'attempts' | 'pending_blob_deletions.attempts' | 'cleanup_attempts' | 'evidence_failures'
): string {
  return `LEAST(interval '1 hour', interval '1 minute' * power(2, LEAST(${attemptsColumn}, 6)))`;
}

/**
 * How long the tenant deletion worker and import teardown wait for the community row lock
 * before a file deletion counts as failed. The pending-deletion sweep skips a locked row instead.
 */
export const BLOB_LOCK_TIMEOUT_MS = 5_000;
/** How long one storage delete may take while the community row is held. */
export const BLOB_DELETE_TIMEOUT_MS = 60_000;

/**
 * Retry a bounded batch of unreferenced blobs left by failed metadata operations.
 *
 * A file whose community is under a host legal hold is left alone, however it came to be
 * queued, and is picked up again once the hold is released. Each file is deleted while its
 * community row is held `FOR SHARE`, after checking for a hold, as the tenant deletion worker
 * does: placing a hold takes that row `FOR UPDATE`, so once it commits no further file of that
 * community is removed here. The community row is taken with `SKIP LOCKED`: a file whose
 * community someone holds `FOR UPDATE` (placing a hold, an import finishing or being torn down)
 * is skipped this round, neither waited for nor counted as a failed attempt, so the sweep never
 * stalls behind it and reaches every other community's files in the same run.
 *
 * Accepted trade-off: the community row stays held `FOR SHARE` while the storage delete runs
 * (at most `BLOB_DELETE_TIMEOUT_MS`), so an admin write to that community waits for it.
 *
 * A queue row with no `managed_blobs` row is not hold-checked, because the database cannot name
 * its community. Only a legacy blob, one stored before the inventory existed, is queued that way
 * (`queueBlobs` and `releaseHeldBlobs` accept such keys); tenant reconciliation adopts those into
 * the inventory, after which they are checked like any other file.
 *
 * Lock order is community, then `managed_blobs`, then `pending_blob_deletions`; every path that
 * deletes a queued file's rows takes them in that order (import teardown and
 * `discardManagedBlob` included).
 */
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
          OR (state IN ('reserved','stored') AND created_at<=now()-($2 * interval '1 millisecond')
              -- A file an import restored waits, stored, for the import's final transaction,
              -- which can come long after its reservation; its progress row keeps it.
              AND NOT EXISTS(
                SELECT 1 FROM community_import_files f WHERE f.blob_key=managed_blobs.blob_key
              ))
     ) candidates
     -- A held file is not a candidate at all, so held files never fill a batch and starve
     -- everyone else's. The lock below re-checks, for a hold placed after this read.
     WHERE NOT EXISTS(
       SELECT 1 FROM managed_blobs m JOIN communities c ON c.id=m.community_id
       WHERE m.blob_key=candidates.blob_key AND c.legal_hold_at IS NOT NULL
     )
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
        // A file's community never changes, so it is read before the lock. A community row
        // someone else holds is skipped, not waited for; the storage delete below is bounded, so
        // one slow file never holds the row, and with it a hold being placed, for long.
        const owner = await client.query<{ community_id: string }>(
          'SELECT community_id FROM managed_blobs WHERE blob_key=$1',
          [candidate.blob_key]
        );
        if (owner.rows[0]) {
          const community = await client.query<{ legal_hold_at: Date | null }>(
            'SELECT legal_hold_at FROM communities WHERE id=$1 FOR SHARE SKIP LOCKED',
            [owner.rows[0].community_id]
          );
          if (!community.rows[0] || community.rows[0].legal_hold_at) return;
        }
        const managed = await client.query<{
          state: string;
          lease_expired: boolean;
          committed: boolean;
        }>(
          `SELECT state,created_at<=now()-($2 * interval '1 millisecond') AS lease_expired,
                  committed_at IS NOT NULL AS committed
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
        // A committed blob's writer finished long ago, so no delayed publish can follow this
        // delete, and its inventory row (which keeps the file's checksum) can go with it. Only
        // a blob whose writer never reported back stays tombstoned for later sweeps.
        const outcomeUncertain = Boolean(
          managedRow && !managedRow.committed && (!queue.rows[0] || queue.rows[0].outcome_uncertain)
        );
        const staleReservation =
          managedRow &&
          (managedRow.state === 'reserved' || managedRow.state === 'stored') &&
          managedRow.lease_expired;
        if (!queue.rows[0] && managedRow?.state !== 'pending_delete' && !staleReservation) return;
        const referenced = await client.query(
          `SELECT 1 FROM attachments WHERE blob_key=$1
           UNION ALL SELECT 1 FROM export_archives WHERE blob_key=$1
           UNION ALL SELECT 1 FROM export_segments WHERE blob_key=$1
           UNION ALL SELECT 1 FROM communities WHERE icon_blob_key=$1
           UNION ALL SELECT 1 FROM community_imports WHERE staging_blob_key=$1
           UNION ALL SELECT 1 FROM community_import_files WHERE blob_key=$1 LIMIT 1`,
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
          await blobStore.delete(candidate.blob_key, {
            signal: AbortSignal.timeout(BLOB_DELETE_TIMEOUT_MS),
          });
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
        // A removed file's description goes with its bytes.
        await client.query('DELETE FROM removed_file_blobs WHERE blob_key=$1', [
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
