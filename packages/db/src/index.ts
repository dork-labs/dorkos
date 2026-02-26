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
 * Applies WAL mode, NORMAL sync, 5s busy timeout, and foreign key enforcement.
 *
 * @param dbPath - Absolute path to the database file, or ':memory:' for tests
 */
export function createDb(dbPath: string) {
  const sqlite = new Database(dbPath);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('synchronous = NORMAL');
  sqlite.pragma('busy_timeout = 5000');
  sqlite.pragma('foreign_keys = ON');
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

// Re-export all schema tables and inferred types
export * from './schema/index.js';

// Re-export commonly used Drizzle query helpers so consumers share the same
// drizzle-orm instance as @dorkos/db (avoids duplicate-package type conflicts).
export { eq, and, gt, asc, desc, sql, count, avg, sum } from 'drizzle-orm';
