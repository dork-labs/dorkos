import type { Pool } from 'pg';
import { transaction } from '../data.js';
import { releaseCommunityShortNames } from '../host/short-names.js';
import type { BlobStore } from '../storage/index.js';
import { cleanupBackoffSql } from '../storage/pending-deletions.js';
import { MANAGED_BLOB_RESERVATION_TTL_MS } from '../storage/managed-blobs.js';

/** What one teardown pass did. */
export type TeardownOutcome = 'settled' | 'waiting' | 'skipped';

/**
 * Remove what a cancelled or failed import left behind, then its unclaimed community.
 *
 * Each pass queues every stored or committed file of the community for deletion and deletes
 * it, keeping failures as cleanup work the pending-deletion sweep retries. A reservation whose
 * writer may still be running is left alone until its lease runs out. Once the community owns
 * no file at all, it is removed in one transaction and the import is settled; the import row
 * stays, with its state and failure code, for whoever started it.
 */
export async function teardownImport(
  pool: Pool,
  blobStore: BlobStore,
  importId: string
): Promise<TeardownOutcome> {
  const queued = await transaction(pool, async (client) => {
    const job = await client.query<{ community_id: string | null }>(
      `SELECT community_id FROM community_imports
       WHERE id=$1 AND state IN ('cancelled','failed') AND settled_at IS NULL
       FOR UPDATE SKIP LOCKED`,
      [importId]
    );
    const communityId = job.rows[0]?.community_id;
    if (!communityId) return null;
    await client.query('SELECT 1 FROM communities WHERE id=$1 FOR UPDATE', [communityId]);
    // Progress rows and the staging reference are what keep these files from the cleanup
    // sweeps; they go first so every file below is unreferenced.
    await client.query('DELETE FROM community_import_files WHERE import_id=$1', [importId]);
    await client.query('UPDATE community_imports SET staging_blob_key=NULL WHERE id=$1', [
      importId,
    ]);
    const settled = await client.query<{ blob_key: string }>(
      `UPDATE managed_blobs SET state='pending_delete'
       WHERE community_id=$1 AND state IN ('stored','committed')
       RETURNING blob_key`,
      [communityId]
    );
    // Every one of these writers finished (stored or committed), so a delete settles it: the
    // error timestamp marks the outcome as known for the sweep that retries a failure.
    await client.query(
      `INSERT INTO pending_blob_deletions(blob_key,attempts,next_attempt_at,last_error_at)
       SELECT unnest($1::text[]),0,now(),now()
       ON CONFLICT(blob_key) DO NOTHING`,
      [settled.rows.map((row) => row.blob_key)]
    );
    return { communityId, keys: settled.rows.map((row) => row.blob_key) };
  });
  if (!queued) return 'skipped';

  for (const key of queued.keys) {
    try {
      await blobStore.delete(key);
    } catch (error) {
      await pool.query(
        `UPDATE pending_blob_deletions
         SET attempts=attempts+1,last_error_at=now(),next_attempt_at=now() + ${cleanupBackoffSql('attempts')}
         WHERE blob_key=$1`,
        [key]
      );
      console.error(
        'Community import file cleanup deferred',
        error instanceof Error ? error.name : 'unknown'
      );
      continue;
    }
    await transaction(pool, async (client) => {
      await client.query('DELETE FROM pending_blob_deletions WHERE blob_key=$1', [key]);
      await client.query(
        "DELETE FROM managed_blobs WHERE blob_key=$1 AND community_id=$2 AND state='pending_delete'",
        [key, queued.communityId]
      );
    });
  }

  return transaction(pool, async (client) => {
    const job = await client.query<{ community_id: string | null }>(
      `SELECT community_id FROM community_imports
       WHERE id=$1 AND state IN ('cancelled','failed') AND settled_at IS NULL FOR UPDATE`,
      [importId]
    );
    const communityId = job.rows[0]?.community_id;
    if (!communityId) return 'skipped';
    await client.query('SELECT 1 FROM communities WHERE id=$1 FOR UPDATE', [communityId]);
    // A stale reservation (its writer's lease is over) is moved to cleanup here, as the pending
    // deletion sweep would; a fresh one still has a writer, so this pass waits for it.
    await client.query(
      `WITH stale AS (
         UPDATE managed_blobs SET state='pending_delete'
         WHERE community_id=$1 AND state='reserved'
           AND created_at<=now()-($2 * interval '1 millisecond')
         RETURNING blob_key
       )
       INSERT INTO pending_blob_deletions(blob_key,attempts,next_attempt_at)
       SELECT blob_key,0,now() FROM stale ON CONFLICT(blob_key) DO NOTHING`,
      [communityId, MANAGED_BLOB_RESERVATION_TTL_MS]
    );
    const remaining = await client.query(
      'SELECT 1 FROM managed_blobs WHERE community_id=$1 LIMIT 1',
      [communityId]
    );
    if (remaining.rowCount) {
      await client.query(
        `UPDATE community_imports SET next_attempt_at=now()+interval '1 minute',updated_at=now()
         WHERE id=$1`,
        [importId]
      );
      return 'waiting';
    }
    await client.query('DELETE FROM community_limits WHERE community_id=$1', [communityId]);
    // Nobody ever reached an unclaimed community by its name, so the name is free at once:
    // someone retrying a move can use the name they chose.
    await releaseCommunityShortNames(client, communityId, { hold: false });
    await client.query('DELETE FROM bootstrap_grants WHERE community_id=$1', [communityId]);
    await client.query(
      `UPDATE tenant_reconciliation SET community_id=NULL,state='dirty',validated_generation=NULL,
         namespace_digest=NULL,completed_at=NULL,invalidated_at=now(),reason_code='tenant_deleted'
       WHERE community_id=$1`,
      [communityId]
    );
    // Settled first: the import row's community_id clears with the delete (ON DELETE SET NULL),
    // and only a settled import may outlive its community.
    await client.query(
      `UPDATE community_imports SET settled_at=now(),lease_token=NULL,updated_at=now()
       WHERE id=$1`,
      [importId]
    );
    await client.query('DELETE FROM communities WHERE id=$1', [communityId]);
    return 'settled';
  });
}
