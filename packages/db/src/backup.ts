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
 * Snapshots are a **manual** escape hatch. Nothing here ever restores one, and
 * nothing here ever deletes, moves or recreates a live database — see
 * `DatabaseOpenError` in `index.ts` for the other half of that rule.
 *
 * @module backup
 */
import type BetterSqlite3 from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import type { Db } from './index.js';
import { MIGRATIONS_FOLDER } from './migrations-folder.js';

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
 * @param sqlite - An open connection to the database being snapshotted
 * @param destPath - Absolute path of the snapshot file to create
 * @throws When the destination exists, the directory is not writable, or SQLite
 *   cannot read the source. Callers decide whether that is fatal.
 */
export function snapshotSqlite(sqlite: BetterSqlite3.Database, destPath: string): void {
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  sqlite.prepare('VACUUM INTO ?').run(destPath);
}

/**
 * Delete the oldest snapshots in `dir` until at most `keep` remain.
 *
 * Only files whose names match `pattern` are considered, so one kind of snapshot
 * can never prune another's — and nothing a person dropped into the folder by
 * hand is ever touched. A missing directory is not an error.
 *
 * @param dir - Directory holding the snapshots
 * @param pattern - Which filenames this prune owns; must sort chronologically
 * @param keep - How many of the newest matching files to keep
 * @returns The filenames that were deleted, oldest first
 */
export function pruneSnapshots(dir: string, pattern: RegExp, keep: number): string[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const matching = names.filter((name) => pattern.test(name)).sort();
  const doomed = matching.slice(0, Math.max(0, matching.length - keep));
  for (const name of doomed) {
    fs.rmSync(path.join(dir, name), { force: true });
  }
  return doomed;
}

/** What a database has and has not applied of the migrations shipped with it. */
export interface MigrationState {
  /** Tags of journal migrations this database has not applied yet, in order. */
  pending: string[];
  /**
   * True when the database has never had a migration applied — a fresh install,
   * where `pending` is the entire journal and there is nothing yet to lose.
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
 * Mirrors Drizzle's own decision exactly (`SQLiteSyncDialect.migrate`): it reads
 * the newest `created_at` out of `__drizzle_migrations` and applies every
 * journal entry stamped strictly later. Reproducing that comparison here is what
 * makes the pre-migration snapshot trustworthy — a different rule would either
 * snapshot when nothing was about to change, or miss the boot that mattered.
 *
 * @param db - The Drizzle handle whose underlying database is inspected
 */
export function readMigrationState(db: Db): MigrationState {
  const sqlite = db.$client;
  const journal = JSON.parse(
    fs.readFileSync(path.join(MIGRATIONS_FOLDER, 'meta', '_journal.json'), 'utf8')
  ) as { entries: JournalEntry[] };

  // The table does not exist until the migrator creates it, so ask sqlite_master
  // rather than letting the SELECT throw.
  const tableExists =
    sqlite
      .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = '__drizzle_migrations'`)
      .get() !== undefined;
  const newest = tableExists
    ? (sqlite
        .prepare('SELECT created_at FROM __drizzle_migrations ORDER BY created_at DESC LIMIT 1')
        .get() as { created_at: number | null } | undefined)
    : undefined;

  const lastApplied = newest?.created_at == null ? null : Number(newest.created_at);
  if (lastApplied === null) {
    return { pending: journal.entries.map((entry) => entry.tag), fresh: true };
  }
  return {
    pending: journal.entries.filter((entry) => lastApplied < entry.when).map((entry) => entry.tag),
    fresh: false,
  };
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
 * would be noise: nothing is pending, or the database is fresh and holds no data
 * to protect (every install's first boot).
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
 */
export function snapshotBeforeMigrations(db: Db, options: SnapshotOptions): string | null {
  const { pending, fresh } = readMigrationState(db);
  if (fresh || pending.length === 0) return null;

  const now = options.now ?? new Date();
  // Named for the FIRST pending migration: the snapshot is the state that
  // migration was applied to, which is what a person reading the folder wants
  // to know.
  const dest = path.join(options.dir, `dork-${utcStamp(now)}-pre-${pending[0]}.db`);
  // Same second, same pending migration, so the same state was already captured
  // — a server crash-looping through boot. Accepting it matters because failure
  // here is fatal: without this, a restart inside one second would turn a name
  // collision into a server that will not start, reporting "output file already
  // exists" as though that were the problem.
  if (fs.existsSync(dest)) return dest;
  snapshotSqlite(db.$client, dest);
  pruneSnapshots(options.dir, PRE_MIGRATION_PATTERN, SNAPSHOT_RETENTION.preMigration);
  return dest;
}

/**
 * Snapshot `dork.db` once per UTC day, as a safety net under everything a
 * migration cannot see coming — a bad delete, a corrupted page, a mistake.
 *
 * Idempotent: the day's snapshot is named after the day, so calling this on
 * every boot and again on a timer writes one file per day and returns `null`
 * for the rest.
 *
 * @param db - The database to snapshot
 * @param options - Destination directory, and an optional clock for tests
 * @returns Absolute path of the snapshot written, or `null` if today's exists
 */
export function snapshotDaily(db: Db, options: SnapshotOptions): string | null {
  const now = options.now ?? new Date();
  const dest = path.join(options.dir, `dork-${utcDay(now)}-daily.db`);
  if (fs.existsSync(dest)) return null;

  snapshotSqlite(db.$client, dest);
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
 * @throws When the snapshot cannot be written; the caller must not migrate.
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
  if (fs.existsSync(dest)) return dest;
  snapshotSqlite(sqlite, dest);
  pruneSnapshots(dir, EXTENSION_PATTERN, SNAPSHOT_RETENTION.extension);
  return dest;
}
