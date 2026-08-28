/**
 * Snapshots of a SQLite database — the safety net under DorkOS's own migrations,
 * and under every extension's.
 *
 * `~/.dork/dork.db` holds the only copy of every room, DM and thread
 * conversation. Nothing else on the machine has a second copy, and migrations
 * apply themselves silently at every boot. A migration that fails is already
 * safe — SQLite rolls DDL back with the data — but a migration that *succeeds*
 * and drops the wrong column is not, and neither is a disk that lies. So before
 * a migration runs, and once a day regardless, DorkOS writes a snapshot it can
 * be pointed back at.
 *
 * **Every snapshot is taken with `VACUUM INTO`, never a file copy.** The
 * database runs in WAL mode, so committed rows can live in `dork.db-wal` rather
 * than in `dork.db`: copying the main file alone silently loses them, and
 * restoring a stale main file while the `-wal`/`-shm` sidecars persist makes
 * SQLite replay the WAL against the wrong base. `VACUUM INTO` writes one
 * self-contained, defragmented file from the connection's own read view, so it
 * sees WAL content and produces a database that opens on its own — which is the
 * whole point of a snapshot somebody may have to open a year from now.
 *
 * **A file at the right path is not a snapshot until it has been read.** An
 * interrupted `VACUUM INTO` — a full disk, a `SIGKILL` — leaves a partial and
 * usually zero-byte file behind, and *a zero-byte file is a valid, empty SQLite
 * database*: it opens, and `PRAGMA integrity_check` answers `ok`. Anything that
 * decides "already done" from `existsSync` alone would accept that decoy, evict
 * a real snapshot from the retention pool to make room for it, and — on the
 * pre-migration path — announce a protected migration that is not protected. So
 * a failed write cleans up after itself ({@link snapshotSqlite}), and every site
 * that reuses an existing file verifies its contents first.
 *
 * Snapshots are a **manual** escape hatch. Nothing here ever restores one, and
 * nothing here ever deletes, moves or recreates a live database — see
 * `DatabaseOpenError` in `index.ts` for the other half of that rule.
 *
 * @module backup
 */
import Database from 'better-sqlite3';
import type BetterSqlite3 from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import type { Db } from './index.js';
import { migrationsFolder } from './migrations-folder.js';

/**
 * Thrown when a snapshot could not be written.
 *
 * The sibling of `DatabaseOpenError`, and it exists for the same reason: this is
 * a condition a person has to resolve, so it must arrive as an instruction
 * rather than as `SqliteError: unable to open database file` and a stack. It is
 * raised on the boot path, where a failed snapshot means the migration did not
 * run, and reaching the operator with that fact is the entire job.
 */
export class SnapshotFailedError extends Error {
  /** The directory the snapshot could not be written to. */
  readonly backupsDir: string;

  /**
   * Build the operator-facing message: what failed, what did not happen because
   * of it, and what to do.
   *
   * @param backupsDir - Directory the snapshot was being written to
   * @param cause - The underlying SQLite or filesystem error
   */
  constructor(backupsDir: string, cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(
      `Could not save a backup copy of the database to ${backupsDir}: ${detail}\n` +
        'Nothing was changed and your data has not been touched. DorkOS saves a copy before ' +
        'it changes how your data is stored, and it will not make that change without one. ' +
        'Free up disk space, or fix that folder so DorkOS can write to it, then start ' +
        'DorkOS again.',
      { cause }
    );
    this.name = 'SnapshotFailedError';
    this.backupsDir = backupsDir;
  }
}

/**
 * How many snapshots of each kind are kept before the oldest is deleted.
 *
 * `dork.db` is a couple of megabytes, so these are sized by how far back a
 * person might need to reach, not by disk cost: ten upgrades of history, and a
 * week of ordinary days.
 */
export const SNAPSHOT_RETENTION = {
  /** Pre-migration snapshots of `dork.db`. */
  preMigration: 10,
  /** Daily snapshots of `dork.db`. */
  daily: 7,
  /** Pre-migration snapshots of one extension's `store.db`. */
  extension: 5,
} as const;

/**
 * Filename shapes, one per snapshot kind, used both to name a new snapshot and
 * to decide which existing files a prune is allowed to delete.
 *
 * Each begins with a fixed prefix followed by a zero-padded UTC timestamp, so
 * plain lexicographic sort over matching names is chronological order — which is
 * what {@link pruneSnapshots} relies on instead of reading mtimes (an mtime is
 * rewritten by a file copy; the name is not).
 */
const PRE_MIGRATION_PATTERN = /^dork-\d{8}-\d{6}-pre-.+\.db$/;
const DAILY_PATTERN = /^dork-\d{8}-daily\.db$/;
const EXTENSION_PATTERN = /^store-\d{8}-\d{6}-pre-v\d+\.db$/;

/** Drizzle's own ledger of which migrations a database has applied. */
const DRIZZLE_MIGRATIONS_TABLE = '__drizzle_migrations';

/** Two-digit zero pad for the UTC filename stamps. */
function pad(n: number, width = 2): string {
  return String(n).padStart(width, '0');
}

/** `YYYYMMDD` in UTC. */
function utcDay(now: Date): string {
  return `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}`;
}

/** `YYYYMMDD-HHMMSS` in UTC. */
function utcStamp(now: Date): string {
  return `${utcDay(now)}-${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`;
}

/**
 * Write a self-contained copy of an open SQLite database to `destPath`.
 *
 * Creates the destination's parent directory if it does not exist. Refuses to
 * overwrite: `VACUUM INTO` fails when the target file already exists, and that
 * refusal is kept rather than worked around — a snapshot that can clobber an
 * older snapshot is not a safety net.
 *
 * On failure it removes whatever the interrupted write left behind before
 * rethrowing, because that leftover is typically a zero-byte file, and a
 * zero-byte file is a perfectly valid empty SQLite database that later callers
 * would mistake for a completed snapshot.
 *
 * @param sqlite - An open connection to the database being snapshotted
 * @param destPath - Absolute path of the snapshot file to create
 * @throws When the destination exists, the directory is not writable, or SQLite
 *   cannot read the source. Callers decide whether that is fatal.
 */
export function snapshotSqlite(sqlite: BetterSqlite3.Database, destPath: string): void {
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  // Whether anything was already here decides what cleanup is allowed to touch.
  // The commonest failure of all is `VACUUM INTO` refusing to overwrite, and
  // deleting the file it refused to overwrite would destroy a good snapshot to
  // tidy up after a write that never started.
  const preexisting = fs.existsSync(destPath);
  try {
    sqlite.prepare('VACUUM INTO ?').run(destPath);
  } catch (err) {
    if (!preexisting) {
      try {
        fs.rmSync(destPath, { force: true });
        // SQLite builds the vacuum output in rollback-journal mode, so this is
        // the one sidecar an interrupted write can leave next to it.
        fs.rmSync(`${destPath}-journal`, { force: true });
      } catch {
        // Cleanup is best-effort and must never replace the error that caused
        // it — that error is the one naming what the operator has to fix.
      }
    }
    throw err;
  }
}

/**
 * Is the file at `snapshotPath` a snapshot, rather than the wreckage of one?
 *
 * A process killed mid-`VACUUM INTO` leaves a file that {@link snapshotSqlite}'s
 * own cleanup never gets to run for, so existence proves nothing and this is the
 * check that does. Two questions, cheapest first: is there any content at all
 * (a zero-byte file is a valid EMPTY database — it opens, and
 * `integrity_check` says `ok`, which is exactly how the wreckage disguises
 * itself), and does the database inside hold what a real snapshot would.
 *
 * @param snapshotPath - Absolute path of the file to inspect
 * @param requiredTable - A table the snapshot must contain; when omitted, any
 *   non-`sqlite_%` table will do
 */
function isUsableSnapshot(snapshotPath: string, requiredTable?: string): boolean {
  let size: number;
  try {
    size = fs.statSync(snapshotPath).size;
  } catch {
    return false;
  }
  if (size === 0) return false;

  let snapshot: BetterSqlite3.Database;
  try {
    snapshot = new Database(snapshotPath, { readonly: true });
  } catch {
    return false;
  }
  try {
    const found = requiredTable
      ? snapshot
          .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`)
          .get(requiredTable)
      : snapshot
          .prepare(
            `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' LIMIT 1`
          )
          .get();
    return found !== undefined;
  } catch {
    return false;
  } finally {
    snapshot.close();
  }
}

/**
 * Decide what to do about a file already sitting at a snapshot's destination.
 *
 * @param dest - Absolute path the caller is about to write
 * @param requiredTable - Passed through to {@link isUsableSnapshot}
 * @returns `true` when `dest` already holds a real snapshot and the caller
 *   should reuse it; `false` once the path is clear to write
 */
function reuseOrClear(dest: string, requiredTable?: string): boolean {
  if (!fs.existsSync(dest)) return false;
  if (isUsableSnapshot(dest, requiredTable)) return true;
  // Not a snapshot, so it is a decoy — and leaving it costs more than deleting
  // it: `VACUUM INTO` will not write over it, so every future attempt at this
  // name fails, and the retention pool counts it as one of the copies being
  // kept. It is removed only after being read and found wanting.
  fs.rmSync(dest, { force: true });
  return false;
}

/**
 * Delete the wreckage and then the oldest snapshots in `dir`, until at most
 * `keep` real ones remain.
 *
 * Only files whose names match `pattern` are considered, so one kind of snapshot
 * can never prune another's — and nothing a person dropped into the folder by
 * hand is ever touched. A missing directory is not an error.
 *
 * Files that match the pattern but are not readable databases go first and do
 * not count toward `keep`. A process killed mid-`VACUUM INTO` leaves a
 * zero-byte file under a timestamped name that nothing will ever try to write
 * again, so without this it would sit in the folder holding one of the slots a
 * real snapshot should have — quietly reducing how far back the operator can
 * reach, for as long as it takes to age out.
 *
 * @param dir - Directory holding the snapshots
 * @param pattern - Which filenames this prune owns; must sort chronologically
 * @param keep - How many of the newest real snapshots to keep
 * @returns The filenames that were deleted, wreckage first then oldest first
 */
export function pruneSnapshots(dir: string, pattern: RegExp, keep: number): string[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const matching = names.filter((name) => pattern.test(name)).sort();

  const wreckage: string[] = [];
  const real: string[] = [];
  for (const name of matching) {
    (isUsableSnapshot(path.join(dir, name)) ? real : wreckage).push(name);
  }

  const doomed = [...wreckage, ...real.slice(0, Math.max(0, real.length - keep))];
  for (const name of doomed) {
    fs.rmSync(path.join(dir, name), { force: true });
  }
  return doomed;
}

/**
 * Does this database hold anything of anybody's?
 *
 * Answered by counting tables that are neither SQLite's own internals nor
 * Drizzle's migration ledger. It is deliberately a measurement rather than an
 * inference from the migration state: a first boot, and a first boot whose
 * migrations rolled back leaving an empty `__drizzle_migrations` behind, both
 * have a schema-less database and nothing to protect, and only looking can tell
 * them apart from an install that has been running for a year.
 *
 * @param db - The database to inspect
 */
export function databaseHoldsUserData(db: Db): boolean {
  const row = db.$client
    .prepare(
      `SELECT count(*) AS n FROM sqlite_master
        WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> ?`
    )
    .get(DRIZZLE_MIGRATIONS_TABLE) as { n: number };
  return row.n > 0;
}

/** What a database has and has not applied of the migrations shipped with it. */
export interface MigrationState {
  /** Tags of journal migrations this database has not applied yet, in order. */
  pending: string[];
  /**
   * True when the database holds no schema of its own yet — a first boot, where
   * `pending` is the entire journal and there is nothing to lose.
   *
   * Measured by {@link databaseHoldsUserData}, NOT read off the migration
   * ledger. The two disagree in states that are reachable: Drizzle creates
   * `__drizzle_migrations` outside its migration transaction, so a first run
   * that rolls back leaves the ledger present and empty.
   */
  fresh: boolean;
}

/** One entry of Drizzle's `meta/_journal.json`. */
interface JournalEntry {
  when: number;
  tag: string;
}

/**
 * Work out which migrations a database still owes, without applying any.
 *
 * `pending` mirrors Drizzle's own decision exactly
 * (`SQLiteSyncDialect.migrate`): it reads the newest `created_at` out of
 * `__drizzle_migrations` and applies every journal entry stamped strictly later,
 * treating a missing table, an empty table and a `NULL` `created_at` alike as
 * "apply everything" (Drizzle reaches the same place via
 * `Number(null) === 0`). Reproducing that comparison here is what makes the
 * pre-migration snapshot trustworthy — a different rule would either snapshot
 * when nothing was about to change, or miss the boot that mattered.
 *
 * @param db - The Drizzle handle whose underlying database is inspected
 */
export function readMigrationState(db: Db): MigrationState {
  const sqlite = db.$client;
  const journal = JSON.parse(
    fs.readFileSync(path.join(migrationsFolder(), 'meta', '_journal.json'), 'utf8')
  ) as { entries: JournalEntry[] };

  // The table does not exist until the migrator creates it, so ask sqlite_master
  // rather than letting the SELECT throw.
  const tableExists =
    sqlite
      .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`)
      .get(DRIZZLE_MIGRATIONS_TABLE) !== undefined;
  const newest = tableExists
    ? (sqlite
        .prepare(
          `SELECT created_at FROM ${DRIZZLE_MIGRATIONS_TABLE} ORDER BY created_at DESC LIMIT 1`
        )
        .get() as { created_at: number | null } | undefined)
    : undefined;

  const lastApplied = newest?.created_at == null ? null : Number(newest.created_at);
  const pending =
    lastApplied === null
      ? journal.entries.map((entry) => entry.tag)
      : journal.entries.filter((entry) => lastApplied < entry.when).map((entry) => entry.tag);

  return { pending, fresh: !databaseHoldsUserData(db) };
}

/** Where snapshots go, and (in tests) what time it is. */
export interface SnapshotOptions {
  /** Directory to write into — `<dorkHome>/backups` in production. */
  dir: string;
  /** Clock override for tests. Defaults to now. */
  now?: Date;
}

/**
 * Snapshot `dork.db` if — and only if — a migration is about to change it.
 *
 * Returns `null` without writing anything in the two cases where a snapshot
 * would be noise: nothing is pending, or the database holds no schema of its own
 * yet and so has nothing to protect (every install's first boot).
 *
 * **Failures are thrown, and the boot path deliberately does not catch them.**
 * If a snapshot cannot be written, the honest response is to leave the database
 * as it is and tell the operator, rather than take an irreversible step with no
 * way back. Freeing disk space or fixing the folder's permissions and starting
 * again is a recoverable morning; discovering after the fact that a migration
 * ate a year of conversations is not.
 *
 * @param db - The database about to be migrated
 * @param options - Destination directory, and an optional clock for tests
 * @returns Absolute path of the snapshot written, or `null` if none was needed
 * @throws {SnapshotFailedError} When the snapshot cannot be written.
 */
export function snapshotBeforeMigrations(db: Db, options: SnapshotOptions): string | null {
  const { pending, fresh } = readMigrationState(db);
  if (fresh || pending.length === 0) return null;

  const now = options.now ?? new Date();
  // Named for the FIRST pending migration: the snapshot is the state that
  // migration was applied to, which is what a person reading the folder wants
  // to know.
  const dest = path.join(options.dir, `dork-${utcStamp(now)}-pre-${pending[0]}.db`);
  // A real snapshot already at this name captured this same state, one second
  // ago, from a boot that then failed — reuse it rather than turning a name
  // collision into a server that will not start. Wreckage at this name is
  // cleared instead, because trusting it would mean migrating unprotected while
  // logging that a snapshot was taken.
  if (!reuseOrClear(dest, DRIZZLE_MIGRATIONS_TABLE)) {
    try {
      snapshotSqlite(db.$client, dest);
    } catch (err) {
      throw new SnapshotFailedError(options.dir, err);
    }
  }
  pruneSnapshots(options.dir, PRE_MIGRATION_PATTERN, SNAPSHOT_RETENTION.preMigration);
  return dest;
}

/**
 * Snapshot `dork.db` once per UTC day, as a safety net under everything a
 * migration cannot see coming — a bad delete, a corrupted page, a mistake.
 *
 * Idempotent: the day's snapshot is named after the day, so calling this on
 * every boot and again on a timer writes one file per day and returns `null`
 * for the rest. A day whose file exists but is not a readable database counts
 * as a day with no snapshot, and is retaken — otherwise one failed write would
 * mark the day permanently done and hold a slot in the week's retention pool.
 *
 * @param db - The database to snapshot
 * @param options - Destination directory, and an optional clock for tests
 * @returns Absolute path of the snapshot written, or `null` if today's exists
 * @throws {SnapshotFailedError} When the snapshot cannot be written.
 */
export function snapshotDaily(db: Db, options: SnapshotOptions): string | null {
  const now = options.now ?? new Date();
  const dest = path.join(options.dir, `dork-${utcDay(now)}-daily.db`);
  if (reuseOrClear(dest)) return null;

  try {
    snapshotSqlite(db.$client, dest);
  } catch (err) {
    throw new SnapshotFailedError(options.dir, err);
  }
  pruneSnapshots(options.dir, DAILY_PATTERN, SNAPSHOT_RETENTION.daily);
  return dest;
}

/**
 * Snapshot one extension's `store.db` before its next schema migration.
 *
 * The same rule as {@link snapshotBeforeMigrations}, applied to a store DorkOS
 * does not own the schema of: the snapshot lands in a `backups` folder beside
 * the database, named for the version about to be applied.
 *
 * @param sqlite - The open connection to the extension's `store.db`
 * @param options - The database's path, the version about to be applied, and an
 *   optional clock for tests
 * @returns Absolute path of the snapshot written
 * @throws {SnapshotFailedError} When it cannot be written; the caller must not
 *   migrate.
 */
export function snapshotBeforeExtensionMigration(
  sqlite: BetterSqlite3.Database,
  options: { dbPath: string; toVersion: number; now?: Date }
): string {
  const dir = path.join(path.dirname(options.dbPath), 'backups');
  const now = options.now ?? new Date();
  const dest = path.join(dir, `store-${utcStamp(now)}-pre-v${options.toVersion}.db`);
  // Same second, same target version, so the same state — see the equivalent
  // note in `snapshotBeforeMigrations`.
  if (!reuseOrClear(dest)) {
    try {
      snapshotSqlite(sqlite, dest);
    } catch (err) {
      throw new SnapshotFailedError(dir, err);
    }
  }
  pruneSnapshots(dir, EXTENSION_PATTERN, SNAPSHOT_RETENTION.extension);
  return dest;
}
