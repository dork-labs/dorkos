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
 * **It does take a snapshot first, which is a different thing.** The transaction
 * covers a migration that FAILS. It does nothing about one that succeeds and is
 * wrong — a `DROP TABLE` in the manifest of an extension update commits happily
 * and takes the rows with it. So before the first pending migration runs against
 * a store that already holds a schema, `snapshotBeforeExtensionMigration` writes
 * a self-contained `VACUUM INTO` copy to `backups/` beside the database (never a
 * file copy, for the WAL reason above). Nothing restores it automatically; it is
 * there for a person. A snapshot that cannot be written is `BACKUP_FAILED` and
 * the migration does not run — same rule as `dork.db` at boot (ADR
 * 260815-200159).
 *
 * @module services/extensions/extension-migrator
 */
import type { StorageMigration } from '@dorkos/extension-api';
import type BetterSqlite3 from 'better-sqlite3';
import { snapshotBeforeExtensionMigration } from '@dorkos/db';
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
 * - `BACKUP_FAILED` — the pre-migration snapshot could not be written, so
 *   nothing was attempted. The database is untouched.
 */
export type MigrationResult =
  | { ok: true; appliedThrough: number }
  | { ok: false; code: 'SCHEMA_DOWNGRADE'; message: string }
  | { ok: false; code: 'MIGRATION_FAILED'; version: number; message: string }
  | { ok: false; code: 'BACKUP_FAILED'; message: string };

/** Extract a human-readable message from an unknown thrown value. */
function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Apply pending migrations to an already-open database. Shared core of
 * {@link runMigrations} (on-disk) and {@link dryRun} (in-memory).
 */
function applyPending(
  db: BetterSqlite3.Database,
  migrations: StorageMigration[],
  beforeApply?: (fromVersion: number, toVersion: number) => void
): MigrationResult {
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

  if (beforeApply) {
    try {
      beforeApply(applied, pending[0].version);
    } catch (err) {
      return {
        ok: false,
        code: 'BACKUP_FAILED',
        message: `Could not snapshot this extension's database before migrating it, so nothing was migrated: ${errorMessage(err)}`,
      };
    }
  }

  // Track the version currently executing so a failure names the right one.
  // (The JS variable survives the SQLite rollback — only the DB state reverts.)
  let currentVersion = applied;
  const runInTransaction = db.transaction(() => {
    for (const m of pending) {
      currentVersion = m.version;
      // `m.up` is SQL an extension author wrote in their manifest, executed as-is.
      // That is intended — a migration IS arbitrary DDL, and there is no useful
      // subset to allow — and it is safe only because of where it sits: nothing
      // reaches this function until a person has approved that extension to run
      // its code inside DorkOS (`extension-load-policy.ts`), and an extension that
      // may run `server.ts` in this process can already do strictly more than run
      // SQL against its own `store.db`. Any future caller that arrives BEFORE that
      // approval has to bring its own gate.
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
 * Opens the database, ensures the `_dork_meta` table, snapshots the store if it
 * already holds a schema, and applies every migration whose version exceeds the
 * recorded `schema_version`, in ascending order, inside one transaction. Refuses
 * (without mutating) when the DB is ahead of the manifest, or when the snapshot
 * cannot be written. On any migration error the transaction rolls back and the
 * database is left exactly as it was — no `.bak` files are ever created.
 *
 * @param dbPath - Absolute path to the extension's `store.db`
 * @param migrations - The manifest's ordered `storage.migrations`
 */
export function runMigrations(dbPath: string, migrations: StorageMigration[]): MigrationResult {
  const db = openExtensionDb(dbPath);
  try {
    return applyPending(db, migrations, (fromVersion, toVersion) => {
      // Version 0 is a store with no schema in it yet — the extension's first
      // install. There is nothing to snapshot, and writing one would leave every
      // fresh install with an empty file in a backups folder.
      if (fromVersion === 0) return;
      snapshotBeforeExtensionMigration(db, { dbPath, toVersion });
    });
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
