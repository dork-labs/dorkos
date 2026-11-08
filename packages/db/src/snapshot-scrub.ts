/**
 * What a database snapshot must not keep (DOR-4001).
 *
 * Snapshots are kept by count, not age (`SNAPSHOT_RETENTION` in `backup.ts`), so
 * on a computer that has been off for weeks they can outlive the 30 days the
 * turn-context record promises its text. So the text is emptied out of every
 * snapshot the moment it is written: the rows that point at it keep their
 * hashes, sizes and token counts, and a restored database reads those turns as
 * text no longer held, exactly as a record past its 30 days does.
 *
 * @module snapshot-scrub
 */
import Database from 'better-sqlite3';

/** The table holding recorded turn text. Every other turn-context table holds only hashes and counts. */
const RECORDED_TEXT_TABLE = 'turn_context_bodies';

/**
 * Empty the recorded turn text out of a snapshot file, in place.
 *
 * Deleting with `secure_delete` on, then `VACUUM`, so the bytes are gone from
 * the file and not merely unlinked from the table. A snapshot of a database
 * that has no such table (one from before the record existed, or an
 * extension's own store) is left exactly as it is.
 *
 * @param snapshotPath - Absolute path of the snapshot just written
 * @throws When the snapshot cannot be opened or written; the caller treats that
 *   as a failed snapshot and removes the file.
 */
export function scrubSnapshot(snapshotPath: string): void {
  const copy = new Database(snapshotPath);
  try {
    const present = copy
      .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`)
      .get(RECORDED_TEXT_TABLE);
    if (present === undefined) return;
    copy.pragma('secure_delete = ON');
    copy.exec(`DELETE FROM ${RECORDED_TEXT_TABLE}`);
    copy.exec('VACUUM');
  } finally {
    copy.close();
  }
}
