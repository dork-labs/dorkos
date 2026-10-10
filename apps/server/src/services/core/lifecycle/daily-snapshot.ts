/**
 * The once-a-day snapshot of `dork.db` taken at boot and on the daily timer.
 *
 * @module services/core/lifecycle/daily-snapshot
 */
import { snapshotDaily, type Db } from '@dorkos/db';
import { logger, logError } from '../../../lib/logger.js';

/**
 * Take the day's snapshot of `dork.db`, if today has not had one yet.
 *
 * Best-effort by design, and that is the difference from the pre-migration
 * snapshot: nothing irreversible happens next, so a full disk should cost a
 * warning in the log rather than a server that will not start.
 *
 * @param db - The consolidated database.
 * @param backupsDir - `<dorkHome>/backups`.
 */
export function takeDailySnapshot(db: Db, backupsDir: string): void {
  try {
    const written = snapshotDaily(db, { dir: backupsDir });
    if (written) logger.info(`[DB] Daily snapshot written to ${written}`);
  } catch (err) {
    logger.warn('[DB] Daily snapshot failed — your data is fine, the backup is not', logError(err));
  }
}
