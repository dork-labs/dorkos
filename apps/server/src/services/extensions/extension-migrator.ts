/**
 * Per-extension schema migrator.
 *
 * Applies an extension's manifest `storage.migrations` to its `store.db` inside
 * a single SQLite transaction. SQLite's DDL is transactional, so a failed
 * migration rolls back the schema, the data, AND the recorded `schema_version`
 * to exactly their prior state — the same "previous state intact on failure"
 * guarantee ADR-0304 makes for marketplace installs, delivered here by the
 * database engine rather than a file copy.
 *
 * **Deliberately NO file-level backup/restore.** Under `journal_mode = WAL`,
 * committed rows can live in `store.db-wal` rather than the main file. A copy of
 * `store.db` alone would silently miss them (data loss), and restoring a stale
 * main file while the `-wal`/`-shm` sidecars persist makes SQLite replay the WAL
 * against the wrong base (corruption). The migration transaction — including its
 * crash recovery via SQLite's WAL — is the sole rollback mechanism; this module
 * creates no `.bak` files.
 *
 * @module services/extensions/extension-migrator
 */
import type { StorageMigration } from '@dorkos/extension-api';
import type BetterSqlite3 from 'better-sqlite3';
import {
  openExtensionDb,
  ensureMeta,
  getSchemaVersion,
  setSchemaVersion,
} from './extension-database.js';

/**
 * Outcome of a migration run.
 *
 * - `ok: true` — the database is at `appliedThrough` (the highest applied version).
 * - `SCHEMA_DOWNGRADE` — the DB is ahead of the manifest (forward-only refusal);
 *   nothing was mutated.
 * - `MIGRATION_FAILED` — a migration threw; the transaction rolled back, so the
 *   schema, data, and `schema_version` are unchanged. `version` names the
 *   migration that failed.
 */
export type MigrationResult =
  | { ok: true; appliedThrough: number }
  | { ok: false; code: 'SCHEMA_DOWNGRADE'; message: string }
  | { ok: false; code: 'MIGRATION_FAILED'; version: number; message: string };

/** Extract a human-readable message from an unknown thrown value. */
function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Apply pending migrations to an already-open database. Shared core of
 * {@link runMigrations} (on-disk) and {@link dryRun} (in-memory).
 */
function applyPending(db: BetterSqlite3.Database, migrations: StorageMigration[]): MigrationResult {
  ensureMeta(db);
  const applied = getSchemaVersion(db);

  // Highest version the manifest declares (0 for an empty migration set).
  const highestVersion = migrations.reduce((max, m) => Math.max(max, m.version), 0);
  if (applied > highestVersion) {
    return {
      ok: false,
      code: 'SCHEMA_DOWNGRADE',
      message: `Database schema is at version ${applied} but this extension only declares migrations up to ${highestVersion}. Forward-only migrations cannot downgrade — reinstall the newer version or delete store.db to start fresh.`,
    };
  }

  const pending = migrations
    .filter((m) => m.version > applied)
    .sort((a, b) => a.version - b.version);
  if (pending.length === 0) {
    return { ok: true, appliedThrough: applied };
  }

  // Track the version currently executing so a failure names the right one.
  // (The JS variable survives the SQLite rollback — only the DB state reverts.)
  let currentVersion = applied;
  const runInTransaction = db.transaction(() => {
    for (const m of pending) {
      currentVersion = m.version;
      db.exec(m.up);
      setSchemaVersion(db, m.version);
    }
  });

  try {
    runInTransaction();
  } catch (err) {
    // SQLite has already rolled the transaction back (schema, data, and
    // schema_version all reverted). No file restore is performed or needed.
    return {
      ok: false,
      code: 'MIGRATION_FAILED',
      version: currentVersion,
      message: errorMessage(err),
    };
  }

  return { ok: true, appliedThrough: pending[pending.length - 1].version };
}

/**
 * Apply an extension's pending migrations to its `store.db`.
 *
 * Opens the database, ensures the `_dork_meta` table, and applies every
 * migration whose version exceeds the recorded `schema_version`, in ascending
 * order, inside one transaction. Refuses (without mutating) when the DB is ahead
 * of the manifest. On any migration error the transaction rolls back and the
 * database is left exactly as it was — no `.bak` files are ever created.
 *
 * @param dbPath - Absolute path to the extension's `store.db`
 * @param migrations - The manifest's ordered `storage.migrations`
 */
export function runMigrations(dbPath: string, migrations: StorageMigration[]): MigrationResult {
  const db = openExtensionDb(dbPath);
  try {
    return applyPending(db, migrations);
  } finally {
    db.close();
  }
}

/**
 * Validate a migration set against a throwaway in-memory database.
 *
 * Applies the migrations to a fresh `:memory:` DB and returns the same
 * {@link MigrationResult} shape without touching disk — used at package
 * install/validate time to catch a broken migration before it reaches a real DB.
 *
 * @param migrations - The migration set to validate
 */
export function dryRun(migrations: StorageMigration[]): MigrationResult {
  const db = openExtensionDb(':memory:');
  try {
    return applyPending(db, migrations);
  } finally {
    db.close();
  }
}
