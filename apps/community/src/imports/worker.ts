import type { Pool } from 'pg';
import type { BlobStore } from '../storage/index.js';
import type { ImportLimits } from './manifest.js';
import { claimImport, processImport, type ImportWorkerHooks } from './process.js';
import { IMPORT_COMMIT_WINDOW_MS, IMPORT_RETENTION } from './store.js';
import { teardownImport } from './teardown.js';

/** How often the server looks for import work. */
export const IMPORT_POLL_MS = 15_000;

/**
 * Cancel every import whose window closed: an upload window that ended before a matching
 * export arrived, and a checked import left uncommitted for seven days. A cancelled import is
 * then torn down like one the host cancelled.
 */
export async function expireImports(pool: Pool, now = new Date()): Promise<number> {
  const result = await pool.query(
    `WITH expired AS (
       UPDATE community_imports SET state='cancelled',lease_token=NULL,next_attempt_at=$1,
         updated_at=$1
       WHERE settled_at IS NULL AND (
         (state='awaiting_upload' AND upload_expires_at<=$1)
         OR (state='validated' AND validated_at<=$1::timestamptz - ($2 * interval '1 millisecond'))
       )
       RETURNING community_id,
         CASE WHEN validated_at IS NULL THEN 'awaiting_upload' ELSE 'validated' END AS prior
     )
     INSERT INTO host_audit_events(actor_kind,community_id,action,prior_state,next_state,changed_fields)
     SELECT 'system',community_id,'import.cancel',prior,'cancelled',ARRAY['state']
     FROM expired`,
    [now, IMPORT_COMMIT_WINDOW_MS]
  );
  return result.rowCount ?? 0;
}

/**
 * Do one due piece of import work: check or restore one import, or tear down one that was
 * cancelled or failed. Work is claimed with `SKIP LOCKED` and a lease, so replicas never work
 * on the same import at once, and the main loop runs one import at a time per replica.
 *
 * @param limits - This host's content limits, which every import is held to.
 * @returns Whether an import was claimed, and whether its work settled it.
 */
export async function sweepImports(
  pool: Pool,
  blobStore: BlobStore,
  limits: ImportLimits,
  now = new Date(),
  hooks: ImportWorkerHooks = {}
): Promise<{ claimed: number; settled: number }> {
  await expireImports(pool, now);
  const job = await claimImport(pool, now);
  if (job) {
    await processImport(pool, blobStore, job, limits, hooks);
    return { claimed: 1, settled: 0 };
  }
  const due = await pool.query<{ id: string }>(
    `SELECT id FROM community_imports
     WHERE settled_at IS NULL AND state IN ('cancelled','failed') AND next_attempt_at<=$1
     ORDER BY next_attempt_at,id LIMIT 1`,
    [now]
  );
  if (!due.rows[0]) return { claimed: 0, settled: 0 };
  const outcome = await teardownImport(pool, blobStore, due.rows[0].id);
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
