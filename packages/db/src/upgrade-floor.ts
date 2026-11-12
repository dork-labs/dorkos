/** Read the upgrade watermark before any writable database or config open. */
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import Database from 'better-sqlite3';

/** Last migration shipped in 0.115.0: 20261011080030_heartbeat_outbox_delivered_at. */
export const MINIMUM_DATABASE_UPGRADE_TIMESTAMP = 1791705630799;

/** The database needs the intermediate release before this build can use it. */
export class DatabaseUpgradeRequiredError extends Error {
  /**
   * Describe the intermediate release needed without opening the old database.
   * @param dbPath - The database that requires the intermediate release.
   */
  constructor(readonly dbPath: string) {
    super(
      'DorkOS cannot upgrade this database directly.\n' +
        'Upgrade to 0.115 first, then upgrade to this version.\n' +
        'Your data has not been changed.'
    );
    this.name = 'DatabaseUpgradeRequiredError';
  }
}

/** Both read modes failed; never recover by creating or repairing a database. */
export class DatabasePreflightError extends Error {
  /**
   * Report a read failure without suggesting automatic recovery.
   * @param dbPath - The database that could not be checked.
   * @param cause - The filesystem or SQLite read failure.
   */
  constructor(
    readonly dbPath: string,
    cause: unknown
  ) {
    super(`Could not check the DorkOS database at ${dbPath}.\nYour data has not been changed.`, {
      cause,
    });
    this.name = 'DatabasePreflightError';
  }
}

interface Reader {
  prepare(sql: string): { get(...params: never[]): unknown };
}

/** Follow the same newest-created_at watermark that Drizzle uses. */
function watermark(db: Reader): number {
  if (
    !db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = '__drizzle_migrations'")
      .get()
  )
    return 0;
  const row = db
    .prepare('SELECT created_at FROM __drizzle_migrations ORDER BY created_at DESC LIMIT 1')
    .get() as { created_at: unknown } | undefined;
  const value = Number(row?.created_at ?? 0);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('Invalid migration watermark');
  return value;
}

/**
 * Check AFTER the data-directory instance lock, before Conf or startup work.
 * Immutable reads neither lock nor create sidecars, but ignore pending WAL.
 * A supported main-file watermark is sufficient for this FLOOR check only.
 * A future CEILING check must use normal read-only SQLite, never immutable.
 *
 * Only an old immutable answer with nonempty WAL, or an immutable read error,
 * permits the normal read-only fallback. It may create SQLite sidecar metadata;
 * neither reader changes user data/schema, checkpoints or runs migrations.
 * Missing files are fresh installs; other filesystem errors fail closed.
 * @param dbPath - The existing consolidated database, never a connection opened writable.
 */
export function assertSupportedDatabaseUpgrade(dbPath: string): void {
  try {
    fs.statSync(dbPath);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw new DatabasePreflightError(dbPath, cause);
  }
  let current: number;
  try {
    const db = new DatabaseSync(`${pathToFileURL(dbPath).href}?immutable=1`, { readOnly: true });
    try {
      current = watermark(db);
    } finally {
      db.close();
    }
  } catch {
    // A checkpoint can race the immutable read: use SQLite's WAL-aware view.
    current = readNormally(dbPath);
    if (current < MINIMUM_DATABASE_UPGRADE_TIMESTAMP)
      throw new DatabaseUpgradeRequiredError(dbPath);
    return;
  }
  if (current >= MINIMUM_DATABASE_UPGRADE_TIMESTAMP) return;
  let walSize: number;
  try {
    walSize = fs.statSync(`${dbPath}-wal`).size;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== 'ENOENT')
      throw new DatabasePreflightError(dbPath, cause);
    walSize = 0;
  }
  if (walSize === 0 || readNormally(dbPath) < MINIMUM_DATABASE_UPGRADE_TIMESTAMP) {
    throw new DatabaseUpgradeRequiredError(dbPath);
  }
}

/** Open only read-only and only after the immutable branch permits fallback. */
function readNormally(dbPath: string): number {
  try {
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    try {
      return watermark(db);
    } finally {
      db.close();
    }
  } catch (cause) {
    throw new DatabasePreflightError(dbPath, cause);
  }
}
