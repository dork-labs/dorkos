/**
 * Drizzle-backed denial list for the Mesh module.
 *
 * Tracks project paths that have been explicitly rejected during discovery.
 * Denied paths are filtered out in future scans. Shares the unified DorkOS
 * SQLite database via the Drizzle ORM.
 *
 * All paths are canonicalized via realpathSync before storage to prevent
 * symlink-based bypasses.
 *
 * @module mesh/denial-list
 */
import { realpathSync } from 'fs';
import { monotonicFactory } from 'ulidx';
import type { Db } from '@dorkos/db';
import { agentDenials, eq, desc } from '@dorkos/db';
import type { DenialRecord } from '@dorkos/shared/mesh-schemas';

const generateUlid = monotonicFactory();

/**
 * Persistent list of denied project paths.
 *
 * Uses the unified Drizzle database via `@dorkos/db`. Table creation and
 * schema management are handled by Drizzle migrations.
 *
 * @example
 * ```typescript
 * const denials = new DenialList(db);
 * denials.deny('/projects/unwanted', 'claude-code', 'Not a project', 'user');
 * denials.isDenied('/projects/unwanted'); // true
 * ```
 */
export class DenialList {
  /**
   * Create a DenialList backed by a Drizzle database instance.
   *
   * @param db - Drizzle database instance from `@dorkos/db`
   */
  constructor(private readonly db: Db) {}

  /**
   * Add a path to the denial list.
   *
   * The path is canonicalized via realpathSync to prevent symlink bypasses.
   * If the path was already denied, the record is replaced via
   * onConflictDoUpdate on the unique `path` column.
   *
   * @param filePath - Absolute path to the project directory
   * @param strategy - Strategy name that detected the directory
   * @param reason - Human-readable reason for denial (optional)
   * @param denier - Identifier of the entity performing the denial (e.g., "user", "system")
   */
  deny(filePath: string, strategy: string, reason: string | undefined, denier: string): void {
    const canonicalPath = this.canonicalize(filePath);
    this.db
      .insert(agentDenials)
      .values({
        id: generateUlid(),
        path: canonicalPath,
        reason: reason ?? null,
        denier,
        createdAt: new Date().toISOString(),
      })
      .onConflictDoUpdate({
        target: agentDenials.path,
        set: {
          reason: reason ?? null,
          denier,
          createdAt: new Date().toISOString(),
        },
      })
      .run();
  }

  /**
   * Check whether a path has been denied.
   *
   * @param filePath - Absolute path to check
   * @returns `true` if the path (or its canonical realpath) is denied
   */
  isDenied(filePath: string): boolean {
    const canonicalPath = this.canonicalize(filePath);
    const row = this.db
      .select({ path: agentDenials.path })
      .from(agentDenials)
      .where(eq(agentDenials.path, canonicalPath))
      .get();
    return row !== undefined;
  }

  /**
   * List all denial records.
   *
   * @returns All denials ordered by denial date (newest first)
   */
  list(): DenialRecord[] {
    const rows = this.db
      .select()
      .from(agentDenials)
      .orderBy(desc(agentDenials.createdAt))
      .all();
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
    const result = this.db
      .delete(agentDenials)
      .where(eq(agentDenials.path, canonicalPath))
      .run();
    return result.changes > 0;
  }

  /** Canonicalize a path to its realpath, falling back to the raw path if resolution fails. */
  private canonicalize(filePath: string): string {
    try {
      return realpathSync(filePath);
    } catch {
      return filePath;
    }
  }

  private rowToRecord(row: typeof agentDenials.$inferSelect): DenialRecord {
    return {
      path: row.path,
      // DenialRecord requires strategy but agentDenials schema doesn't have it;
      // use 'manual' as default since strategy was dropped in the schema migration.
      strategy: 'manual',
      reason: row.reason ?? undefined,
      deniedBy: row.denier ?? 'unknown',
      deniedAt: row.createdAt,
    };
  }
}
