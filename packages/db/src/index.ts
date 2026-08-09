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
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Opens (or creates) the DorkOS SQLite database at the given path.
 * Applies WAL mode, NORMAL sync, 5s busy timeout, foreign key enforcement, and
 * recursive triggers.
 *
 * @param dbPath - Absolute path to the database file, or ':memory:' for tests
 */
export function createDb(dbPath: string) {
  const sqlite = new Database(dbPath);
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
 * Resolves migrations folder relative to this file (works in both dev and CLI bundle).
 *
 * @param db - Drizzle database instance from createDb()
 */
export function runMigrations(db: ReturnType<typeof createDb>): void {
  const migrationsFolder = path.join(__dirname, '../drizzle');
  migrate(db, { migrationsFolder });
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
