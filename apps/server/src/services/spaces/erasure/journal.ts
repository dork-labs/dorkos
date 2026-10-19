import type { Pool, PoolClient } from 'pg';

/** One finished erasure as the journal keeps it: ids only, never anything that was erased. */
export type ErasureJournalRecord =
  { kind: 'member'; communityId: string; memberId: string } | { kind: 'account'; userId: string };

/**
 * One journal line as the host API returns it: the JSON object the server logs and writes to
 * `COMMUNITY_ERASURE_JOURNAL`, plus `finishedAt`, so each one, written as a line, is input
 * `erasure:reapply` reads (it ignores `finishedAt`).
 */
export type ErasureJournalLine = (
  | { event: 'community.member_erased'; communityId: string; memberId: string }
  | { event: 'community.account_erased'; userId: string }
) & {
  /**
   * When the erasure finished: the row's `created_at`, set in the transaction that finishes it
   * and the time retention counts from. A row never changes, so neither does this.
   */
  finishedAt: string;
};

/** Where a reader stands: after row `id`, whose random `nonce` it saw. `id` 0 is the start. */
export interface ErasureJournalPosition {
  id: number;
  nonce: string | null;
}

/**
 * Serialises journal writers from their insert to their commit, so rows commit in id order and
 * every reader sees a prefix of the ids. Without it an erasure that took id 10 could commit after
 * one that took id 11, and a reader that already moved past 11 would never see 10.
 *
 * This key is the journal's alone (the guard in advisory-locks.test.ts keeps each key to one
 * purpose). Sharing one with code that takes row locks after it deadlocks: an erasure holds its
 * community row when it gets here.
 */
export const JOURNAL_WRITE_LOCK = 77281505;

/**
 * Add one row, inside the caller's transaction. The lock is taken last and nothing else ever
 * takes it, so a writer only waits for another writer's insert and commit, never for a row lock.
 */
export async function appendJournalRow(
  client: PoolClient,
  record: ErasureJournalRecord
): Promise<void> {
  await client.query('SELECT pg_advisory_xact_lock($1)', [JOURNAL_WRITE_LOCK]);
  await client.query(
    'INSERT INTO erasure_journal(kind,community_id,member_id,user_id) VALUES($1,$2,$3,$4)',
    record.kind === 'member'
      ? ['member', record.communityId, record.memberId, null]
      : ['account', null, null, record.userId]
  );
}

/**
 * Delete rows older than `retentionDays`, whatever community or account they name, deleted ones
 * included: once no backup that predates a row can exist, re-applying it has nothing to undo.
 * A cursor naming a pruned row answers 410 and its reader starts again, which is harmless.
 */
export async function pruneErasureJournal(
  pool: Pool,
  retentionDays: number,
  now = new Date()
): Promise<number> {
  const result = await pool.query(
    `DELETE FROM erasure_journal WHERE created_at < $1::timestamptz - make_interval(days => $2)`,
    [now, retentionDays]
  );
  return result.rowCount ?? 0;
}

/** The cursor names a row this database no longer has as the reader saw it. */
export class ErasureJournalCursorStale extends Error {
  constructor() {
    super('The erasure journal cursor no longer matches this database.');
    this.name = 'ErasureJournalCursorStale';
  }
}

interface JournalRow {
  id: string;
  nonce: string;
  kind: 'member' | 'account';
  community_id: string | null;
  member_id: string | null;
  user_id: string | null;
  created_at: Date;
}

/**
 * Read up to `limit` rows after `after`, oldest first.
 *
 * The row the position names must still exist with the nonce the reader saw. After a backup
 * restore, or once pruned, it is gone, or its id belongs to a new row, and the read throws
 * {@link ErasureJournalCursorStale}; the reader starts again from the start, which is safe
 * because re-applying an erasure is idempotent.
 */
export async function readErasureJournal(
  pool: Pool,
  after: ErasureJournalPosition,
  limit: number
): Promise<{ lines: ErasureJournalLine[]; next: ErasureJournalPosition; hasMore: boolean }> {
  // One snapshot for the check and the read, so a restore cannot land between them.
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    if (after.id > 0) {
      const seen = await client.query('SELECT 1 FROM erasure_journal WHERE id=$1 AND nonce=$2', [
        after.id,
        after.nonce,
      ]);
      if (!seen.rowCount) throw new ErasureJournalCursorStale();
    }
    // `id` is selected as the bigint it is (pg hands it over as a string): cast to text in the
    // select list, ORDER BY would sort that output column as text and put 10 before 9.
    const rows = await client.query<JournalRow>(
      `SELECT id,nonce,kind,community_id,member_id,user_id,created_at FROM erasure_journal
       WHERE id>$1 ORDER BY id LIMIT $2`,
      [after.id, limit + 1]
    );
    await client.query('COMMIT');
    const page = rows.rows.slice(0, limit);
    const last = page.at(-1);
    return {
      lines: page.map((row) => ({
        ...(row.kind === 'member'
          ? {
              event: 'community.member_erased' as const,
              communityId: row.community_id!,
              memberId: row.member_id!,
            }
          : { event: 'community.account_erased' as const, userId: row.user_id! }),
        finishedAt: row.created_at.toISOString(),
      })),
      next: last ? { id: Number(last.id), nonce: last.nonce } : after,
      hasMore: rows.rows.length > limit,
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
