/**
 * @dorkos/db — Unified Drizzle ORM database for DorkOS.
 *
 * Provides `createDb()` to open/create the SQLite database, `runMigrations()`
 * to apply pending migrations at startup, and re-exports all schema tables
 * and inferred types.
 *
 * @module db
 */
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import * as schema from './schema/index.js';
import { migrationsFolder } from './migrations-folder.js';

/**
 * Thrown when the database at a path exists but will not open.
 *
 * **DorkOS never recovers from this by itself.** It does not rename the file, it
 * does not recreate an empty one beside it, and it does not attempt a repair.
 * `dork.db` holds the only copy of every room, DM and thread conversation, and a
 * database that will not open is far more often a volume that has not mounted
 * yet, a half-finished copy, or a path typo than it is a lost cause — all three
 * of which a helpful auto-recovery would turn into real, permanent data loss by
 * starting fresh over the top. So boot stops here, loudly, with the file exactly
 * as it was found, and a person decides what happens next.
 */
export class DatabaseOpenError extends Error {
  /** Absolute path of the database that could not be opened. */
  readonly dbPath: string;

  /**
   * Build the operator-facing message: what failed, and what DorkOS did not do
   * about it.
   *
   * @param dbPath - Path that failed to open
   * @param cause - The underlying SQLite or filesystem error
   */
  constructor(dbPath: string, cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(
      `Could not open the DorkOS database at ${dbPath}: ${detail}\n` +
        'Your data has not been touched — DorkOS never recreates, renames or repairs a ' +
        'database it cannot open. Restore the newest snapshot from the "backups" folder ' +
        'beside it, or move the file aside yourself if you accept losing what it holds, ' +
        'then start DorkOS again.',
      { cause }
    );
    this.name = 'DatabaseOpenError';
    this.dbPath = dbPath;
  }
}

/**
 * Opens (or creates) the DorkOS SQLite database at the given path.
 * Applies WAL mode, NORMAL sync, 5s busy timeout, foreign key enforcement, and
 * recursive triggers.
 *
 * A path that does not exist yet is created — that is how every install gets its
 * first database. A path that exists but does not open is a
 * {@link DatabaseOpenError} and nothing else: see that class for why this
 * function has no recovery branch.
 *
 * @param dbPath - Absolute path to the database file, or ':memory:' for tests
 * @throws {DatabaseOpenError} When the file cannot be opened or configured.
 */
export function createDb(dbPath: string) {
  let sqlite: Database.Database;
  try {
    sqlite = new Database(dbPath);
  } catch (err) {
    throw new DatabaseOpenError(dbPath, err);
  }

  try {
    return configureAndWrap(sqlite);
  } catch (err) {
    // better-sqlite3 opens lazily, so a file that is not a database gets past
    // the constructor and fails on the first pragma instead. Close the handle we
    // opened; leave the file alone.
    sqlite.close();
    throw new DatabaseOpenError(dbPath, err);
  }
}

/** Apply the house pragmas to an open connection and wrap it in Drizzle. */
function configureAndWrap(sqlite: Database.Database) {
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('synchronous = NORMAL');
  sqlite.pragma('busy_timeout = 5000');
  sqlite.pragma('foreign_keys = ON');
  // WITHOUT THIS, `INSERT OR REPLACE` SILENTLY CORRUPTS THE MESSAGE-SEARCH INDEX.
  //
  // SQLite fires a table's DELETE triggers for rows that REPLACE conflict
  // resolution removes ONLY when recursive_triggers is on. It defaults to OFF,
  // and OFF was measured here (`PRAGMA recursive_triggers` returned 0 before
  // this line existed). So a REPLACE onto `messages` dropped the old row
  // without ever running `messages_fts_ad`, leaving the FTS5 index holding
  // terms for text that no longer exists anywhere.
  //
  // What made it worth a pragma rather than a rule is that NOTHING REPORTS IT.
  // Measured on the migrated database, after one REPLACE: `MATCH 'dog'` returns
  // a hit for the deleted text, `bm25()` scores it without complaint, and BOTH
  // integrity checks — `PRAGMA integrity_check` and FTS5's own
  // `INSERT INTO messages_fts(messages_fts) VALUES('integrity-check')` — report
  // `ok`. Only `snippet()` fails, with `database disk image is malformed`. A
  // convention would have to be obeyed by every future writer to hold; this
  // holds by itself.
  //
  // Safe to turn on for THIS database, and the reason is structural rather than
  // a headcount. The three triggers in migration 0037 are the only ones in the
  // migration history, and the operator's production database carries none at
  // all — but "there are no other triggers" is not the argument, because
  // extensions may declare their own: a manifest migration is the one place
  // third-party `CREATE TRIGGER` is allowed
  // (`packages/extension-api/src/manifest-schema.ts`). Those live in a separate
  // `store.db` on a separate connection opened by `openExtensionDb`, which
  // deliberately does NOT set this pragma and says so. So no trigger this
  // pragma can reach is one DorkOS did not write.
  //
  // The rest follows: none of the three writes to a table carrying triggers, so
  // none can recurse, and SQLite defines foreign key actions as unaffected by
  // this pragma.
  //
  // It is per-connection, so it protects connections opened through here and no
  // others. Anything writing `messages` must come through `createDb`.
  sqlite.pragma('recursive_triggers = ON');
  return drizzle(sqlite, { schema });
}

/**
 * Applies all pending Drizzle migrations synchronously.
 * Safe to call before server.listen() — no async required.
 *
 * Take a snapshot first: `snapshotBeforeMigrations` (in `./backup.ts`) is the
 * only thing standing between a migration that succeeds wrongly and the loss of
 * every conversation the database holds.
 *
 * @param db - Drizzle database instance from createDb()
 */
export function runMigrations(db: ReturnType<typeof createDb>): void {
  migrate(db, { migrationsFolder: migrationsFolder() });
}

/** The Drizzle DB instance type. Use as the parameter type for all stores. */
export type Db = ReturnType<typeof createDb>;

/**
 * The transaction handle `Db.transaction()` hands its callback.
 *
 * A store method that must sometimes be atomic with a write another store
 * makes — the bridge store's external-ref write landing in the same
 * transaction as `RoomStore.appendEntry`, for instance — takes one of these as
 * an optional parameter and runs its statements against it when the caller
 * supplies one.
 *
 * **What this buys is explicitness, not atomicity — `@dorkos/db` is a single
 * `better-sqlite3` connection, so atomicity already holds without it.**
 * `better-sqlite3`'s `transaction()` wraps a synchronous callback between
 * `BEGIN`/`COMMIT` on that one connection; because everything here runs
 * synchronously and single-threaded, a plain `this.db.insert(...).run()`
 * called from inside another method's `db.transaction(...)` callback lands in
 * the SAME open transaction whether or not it was handed the `tx` argument —
 * there is only one connection for it to run against. Passing `tx` explicitly
 * is what makes a method's participation in a caller's transaction reviewable
 * at the call site rather than an accident of call order, and it is the seam
 * that would start MATTERING for atomicity the day `@dorkos/db` stops being
 * one connection (a pool, a second writer, an async driver) — a change this
 * type does not have to be revisited for.
 */
export type DbTransaction = Parameters<Parameters<Db['transaction']>[0]>[0];

// Re-export all schema tables and inferred types
export * from './schema/index.js';

// Snapshots — the pre-migration and daily safety nets under this database, and
// the primitives an extension's own migrator reuses.
export {
  snapshotSqlite,
  pruneSnapshots,
  readMigrationState,
  databaseHoldsUserData,
  snapshotBeforeMigrations,
  snapshotDaily,
  snapshotBeforeExtensionMigration,
  SnapshotFailedError,
  SNAPSHOT_RETENTION,
} from './backup.js';
export type { MigrationState, SnapshotOptions } from './backup.js';

// Re-export the percentile-extension feature probe (DOR-166) — shared by any
// store that aggregates with `percentile_cont()` so a build predating
// better-sqlite3 12.10 degrades to `NULL` instead of throwing.
// (`resetPercentileSupportCache` is deliberately not re-exported: it's a
// test-only helper whose sole consumer imports the module directly.)
export { hasPercentileSupport } from './sql-features.js';

// Re-export commonly used Drizzle query helpers so consumers share the same
// drizzle-orm instance as @dorkos/db (avoids duplicate-package type conflicts).
export {
  eq,
  ne,
  and,
  gt,
  gte,
  lt,
  lte,
  asc,
  desc,
  sql,
  count,
  avg,
  sum,
  max,
  inArray,
  notInArray,
  isNull,
  isNotNull,
  or,
} from 'drizzle-orm';

// The type a `sql` fragment has, for stores that build one column's UPDATE
// expression (rather than a plain value) and need to name its type. Re-exported
// here for the same reason as the helpers above: one drizzle-orm instance.
export type { SQL } from 'drizzle-orm';

// Self-joins need a second name for the same table — the cross-room thread
// aggregation joins `room_entries` to itself to reach each reply's root.
export { alias } from 'drizzle-orm/sqlite-core';
