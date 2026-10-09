/**
 * @dorkos/db — Unified Drizzle ORM database for DorkOS.
 *
 * Provides `createDb()` to open/create the SQLite database, `runMigrations()`
 * to apply pending migrations at startup, and re-exports all schema tables
 * and inferred types.
 *
 * @module db
 */
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { constructDatabase } from './database-construction.js';
export { DatabaseOpenError } from './database-construction.js';
import { migrationsFolder } from './migrations-folder.js';
import { bridgeLegacyDocMigrationHistory } from './doc-migration-history.js';

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
  return constructDatabase(dbPath).db;
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
  const folder = migrationsFolder();
  bridgeLegacyDocMigrationHistory(db, folder);
  migrate(db, { migrationsFolder: folder });
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
  like,
  or,
} from 'drizzle-orm';

// The type a `sql` fragment has, for stores that build one column's UPDATE
// expression (rather than a plain value) and need to name its type. Re-exported
// here for the same reason as the helpers above: one drizzle-orm instance.
export type { SQL } from 'drizzle-orm';

// Self-joins need a second name for the same table — the cross-room thread
// aggregation joins `room_entries` to itself to reach each reply's root.
export { alias } from 'drizzle-orm/sqlite-core';

// Fixed native persistence only; no public native constructor/completion/registrar.
export { createRoomSpendPersistence } from './room-spend-witness.js';
export type { RoomSpendPersistence, NativeSpendReceipt } from './room-spend-witness.js';
