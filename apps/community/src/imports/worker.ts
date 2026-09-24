import type { Pool } from 'pg';
import type { BlobStore } from '../storage/index.js';
import { IMPORT_RETENTION } from './store.js';
import { teardownImport } from './teardown.js';

/** How often the server looks for import work. */
export const IMPORT_POLL_MS = 15_000;

/**
 * Cancel every import whose upload window closed before a matching export arrived. A cancelled
 * import is then torn down like one the host cancelled.
 */
export async function expireImports(pool: Pool, now = new Date()): Promise<number> {
  const result = await pool.query(
    `WITH expired AS (
       UPDATE community_imports SET state='cancelled',lease_token=NULL,next_attempt_at=$1,
         updated_at=$1
       WHERE state='awaiting_upload' AND upload_expires_at<=$1 AND settled_at IS NULL
       RETURNING community_id
     )
     INSERT INTO host_audit_events(actor_kind,community_id,action,prior_state,next_state,changed_fields)
     SELECT 'system',community_id,'import.cancel','awaiting_upload','cancelled',ARRAY['state']
     FROM expired`,
    [now]
  );
  return result.rowCount ?? 0;
}

/**
 * Do one due piece of import work: tear down one cancelled or failed import. The work itself
 * takes the import with `SKIP LOCKED`, so replicas never work on the same one at once.
 *
 * @returns Whether an import was claimed, and whether its work finished.
 */
export async function sweepImports(
  pool: Pool,
  blobStore: BlobStore,
  now = new Date()
): Promise<{ claimed: number; settled: number }> {
  await expireImports(pool, now);
  const due = await pool.query<{ id: string }>(
    `SELECT id FROM community_imports
     WHERE settled_at IS NULL AND state IN ('cancelled','failed') AND next_attempt_at<=$1
     ORDER BY next_attempt_at,id LIMIT 1`,
    [now]
  );
  const job = due.rows[0];
  if (!job) return { claimed: 0, settled: 0 };
  const outcome = await teardownImport(pool, blobStore, job.id);
  return { claimed: outcome === 'skipped' ? 0 : 1, settled: outcome === 'settled' ? 1 : 0 };
}

/** Delete settled imports whose community is gone, 30 days after they settled. */
export async function pruneImports(pool: Pool, now = new Date()): Promise<number> {
  const result = await pool.query(
    `DELETE FROM community_imports
     WHERE settled_at IS NOT NULL AND community_id IS NULL
       AND settled_at < $1::timestamptz - ${IMPORT_RETENTION}`,
    [now]
  );
  return result.rowCount ?? 0;
}
