import type { Pool } from 'pg';
import { transaction } from '../data.js';
import type { BlobStore } from './blob-store.js';

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
      'INSERT INTO pending_blob_deletions(blob_key,attempts,last_error_at) VALUES($1,1,now()) ON CONFLICT(blob_key) DO UPDATE SET attempts=pending_blob_deletions.attempts+1,last_error_at=now()',
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
    'SELECT blob_key FROM pending_blob_deletions ORDER BY created_at,blob_key LIMIT $1',
    [batchSize]
  );
  let deleted = 0;
  let failed = 0;
  for (const candidate of candidates.rows) {
    try {
      await transaction(pool, async (client) => {
        const row = await client.query<{ blob_key: string }>(
          'SELECT blob_key FROM pending_blob_deletions WHERE blob_key=$1 FOR UPDATE',
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
        await blobStore.delete(candidate.blob_key);
        await client.query('DELETE FROM pending_blob_deletions WHERE blob_key=$1', [
          candidate.blob_key,
        ]);
        deleted++;
      });
    } catch (error) {
      failed++;
      await pool.query(
        'UPDATE pending_blob_deletions SET attempts=attempts+1,last_error_at=now() WHERE blob_key=$1',
        [candidate.blob_key]
      );
      console.error(
        'Community pending blob cleanup failed',
        error instanceof Error ? error.name : 'unknown'
      );
    }
  }
  return { deleted, failed };
}
