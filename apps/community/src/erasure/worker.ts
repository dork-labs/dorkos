import type { Pool } from 'pg';
import { ContentChangeError } from '../content-removal.js';
import { transaction } from '../data.js';
import { eraseAccount, eraseMembership, ErasureError, type ErasureOptions } from './erasure.js';
import { cleanupBackoffSql } from '../storage/pending-deletions.js';

/** How often the server looks for due erasures. */
export const ERASURE_POLL_MS = 30_000;
/** Completed and cancelled requests are deleted this long after they end. */
const RETENTION = "interval '30 days'";

interface ClaimedRequest {
  id: string;
  kind: 'membership' | 'account';
  user_id: string | null;
  community_id: string | null;
  member_id: string | null;
}

/**
 * Claim one due erasure and run it. The claim is a five-minute lease: a worker that dies
 * leaves it to expire and another replica resumes, which is safe because every procedure is
 * idempotent. Claiming an account erasure also signs the person out everywhere.
 *
 * @param options.now - The clock the due check and lease use; injected by tests.
 * @returns Whether a request was claimed, and whether it finished.
 */
export async function sweepErasures(
  pool: Pool,
  options: ErasureOptions & { now?: Date } = {}
): Promise<{ claimed: number; completed: number; failed: number }> {
  const now = options.now ?? new Date();
  const request = await transaction(pool, async (client) => {
    const due = await client.query<ClaimedRequest>(
      `SELECT id,kind,user_id,community_id,member_id FROM erasure_requests
       WHERE state IN ('scheduled','running') AND execute_after<=$1 AND next_attempt_at<=$1
       ORDER BY next_attempt_at,id LIMIT 1 FOR UPDATE SKIP LOCKED`,
      [now]
    );
    const row = due.rows[0];
    if (!row) return null;
    await client.query(
      `UPDATE erasure_requests SET state='running',started_at=COALESCE(started_at,now()),
         next_attempt_at=$2::timestamptz+interval '5 minutes'
       WHERE id=$1`,
      [row.id, now]
    );
    if (row.kind === 'account') {
      await client.query('DELETE FROM session WHERE "userId"=$1', [row.user_id]);
    }
    return row;
  });
  if (!request) return { claimed: 0, completed: 0, failed: 0 };
  try {
    if (request.kind === 'account') {
      await eraseAccount(pool, request.user_id!, { ...options, requestId: request.id });
    } else {
      await eraseMembership(pool, request.community_id!, request.member_id!, {
        ...options,
        requestId: request.id,
      });
    }
    return { claimed: 1, completed: 1, failed: 0 };
  } catch (error) {
    const code =
      error instanceof ErasureError || error instanceof ContentChangeError
        ? error.code
        : 'ERASURE_FAILED';
    await pool.query(
      `UPDATE erasure_requests SET attempts=attempts+1,last_error_class=$2,
         next_attempt_at=$3::timestamptz + ${cleanupBackoffSql('attempts')}
       WHERE id=$1 AND state='running'`,
      [request.id, code, now]
    );
    // An error class only: a database message can carry row content.
    console.error('Community erasure deferred', code);
    return { claimed: 1, completed: 0, failed: 1 };
  }
}

/** Delete completed and cancelled requests 30 days after they ended, children first. */
export async function pruneErasureRequests(pool: Pool, now = new Date()): Promise<number> {
  const result = await pool.query(
    `DELETE FROM erasure_requests r
     WHERE r.state IN ('completed','cancelled')
       AND COALESCE(r.completed_at,r.cancelled_at) < $1::timestamptz - ${RETENTION}
       AND NOT EXISTS (SELECT 1 FROM erasure_requests child WHERE child.parent_request_id=r.id)`,
    [now]
  );
  return result.rowCount ?? 0;
}
