import type { Pool } from 'pg';

/** Delete one bounded batch of expired admission transactions and their cascading receipts. */
export async function sweepExpiredAdmissions(pool: Pool, batchSize = 100): Promise<number> {
  const result = await pool.query(
    `WITH expired AS (
       SELECT id FROM pending_admissions
       WHERE expires_at<=now()
       ORDER BY expires_at,id
       LIMIT $1
       FOR UPDATE SKIP LOCKED
     )
     DELETE FROM pending_admissions p USING expired
     WHERE p.id=expired.id
     RETURNING p.id`,
    [batchSize]
  );
  return result.rowCount ?? 0;
}
