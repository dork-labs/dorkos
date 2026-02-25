/**
 * SQLite-backed denial list for the Mesh module.
 *
 * Tracks project paths that have been explicitly rejected during discovery.
 * Denied paths are filtered out in future scans. Shares the same SQLite
 * database as AgentRegistry to minimize file handles.
 *
 * All paths are canonicalized via realpathSync before storage to prevent
 * symlink-based bypasses.
 *
 * @module mesh/denial-list
 */
import Database from 'better-sqlite3';
import { realpathSync } from 'fs';
import type { DenialRecord } from '@dorkos/shared/mesh-schemas';

// === Row Shape ===

/** Raw SQLite row for a denial (snake_case columns). */
interface DenialRow {
  path: string;
  strategy: string;
  reason: string | null;
  denied_by: string;
  denied_at: string;
}

// === Migrations ===

const DENIAL_MIGRATION = `
CREATE TABLE IF NOT EXISTS denials (
  path TEXT PRIMARY KEY,
  strategy TEXT NOT NULL,
  reason TEXT,
  denied_by TEXT NOT NULL,
  denied_at TEXT NOT NULL
);
`;

// === DenialList ===

/**
 * Persistent list of denied project paths.
 *
 * Shares the SQLite database instance from AgentRegistry.
 *
 * @example
 * ```typescript
 * const registry = new AgentRegistry(dbPath);
 * const denials = new DenialList(registry.database);
 * denials.deny('/projects/unwanted', 'claude-code', 'Not a project', 'user');
 * denials.isDenied('/projects/unwanted'); // true
 * ```
 */
export class DenialList {
  private readonly db: Database.Database;
  private readonly stmts: {
    insert: Database.Statement;
    check: Database.Statement;
    listAll: Database.Statement;
    remove: Database.Statement;
  };

  /**
   * Create a DenialList sharing an existing database connection.
   *
   * @param db - Shared better-sqlite3 database instance
   */
  constructor(db: Database.Database) {
    this.db = db;
    this.runMigration();
    this.stmts = {
      insert: this.db.prepare(
        `INSERT OR REPLACE INTO denials (path, strategy, reason, denied_by, denied_at) VALUES (?, ?, ?, ?, ?)`,
      ),
      check: this.db.prepare(`SELECT 1 FROM denials WHERE path = ?`),
      listAll: this.db.prepare(`SELECT * FROM denials ORDER BY denied_at DESC`),
      remove: this.db.prepare(`DELETE FROM denials WHERE path = ?`),
    };
  }

  /**
   * Add a path to the denial list.
   *
   * The path is canonicalized via realpathSync to prevent symlink bypasses.
   * If the path was already denied, the record is replaced (INSERT OR REPLACE).
   *
   * @param filePath - Absolute path to the project directory
   * @param strategy - Strategy name that detected the directory
   * @param reason - Human-readable reason for denial (optional)
   * @param denier - Identifier of the entity performing the denial (e.g., "user", "system")
   */
  deny(filePath: string, strategy: string, reason: string | undefined, denier: string): void {
    const canonicalPath = this.canonicalize(filePath);
    this.stmts.insert.run(canonicalPath, strategy, reason ?? null, denier, new Date().toISOString());
  }

  /**
   * Check whether a path has been denied.
   *
   * @param filePath - Absolute path to check
   * @returns `true` if the path (or its canonical realpath) is denied
   */
  isDenied(filePath: string): boolean {
    const canonicalPath = this.canonicalize(filePath);
    const row = this.stmts.check.get(canonicalPath);
    return row !== undefined;
  }

  /**
   * List all denial records.
   *
   * @returns All denials ordered by denial date (newest first)
   */
  list(): DenialRecord[] {
    const rows = this.stmts.listAll.all() as DenialRow[];
    return rows.map((row) => this.rowToRecord(row));
  }

  /**
   * Remove a path from the denial list.
   *
   * @param filePath - Absolute path to clear
   * @returns `true` if a denial was removed, `false` if path was not denied
   */
  clear(filePath: string): boolean {
    const canonicalPath = this.canonicalize(filePath);
    const result = this.stmts.remove.run(canonicalPath);
    return result.changes > 0;
  }

  private runMigration(): void {
    this.db.exec(DENIAL_MIGRATION);
  }

  /** Canonicalize a path to its realpath, falling back to the raw path if resolution fails. */
  private canonicalize(filePath: string): string {
    try {
      return realpathSync(filePath);
    } catch {
      return filePath;
    }
  }

  private rowToRecord(row: DenialRow): DenialRecord {
    return {
      path: row.path,
      strategy: row.strategy,
      reason: row.reason ?? undefined,
      deniedBy: row.denied_by,
      deniedAt: row.denied_at,
    };
  }
}
