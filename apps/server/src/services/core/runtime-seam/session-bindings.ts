/** Batched stored runtime bindings, with no inference or lifecycle mutation. */
import { sessionMetadata, inArray, type Db } from '@dorkos/db';

/**
 * How many session ids one `WHERE session_id IN (...)` may carry. Every id
 * spends one of SQLite's compiled-in bound variables (~32k), so a list past the
 * ceiling would fail the whole read rather than part of it — the same ceiling,
 * and the same 500, the queue store chunks its deletes at.
 */
const BOUND_RUNTIME_CHUNK_SIZE = 500;

/** One session's ownership row, as a caller that must not guess reads it. */
export interface SessionBinding {
  /** The runtime type the row names. Never inferred, never a default. */
  runtime: string;
  /**
   * When the row was written, epoch ms; `null` when the stored timestamp cannot
   * be parsed, which a caller must treat as "unknown", never as "long ago".
   */
  boundAt: number | null;
}

/**
 * Read bound runtime rows in SQLite-sized chunks; missing or unbound rows stay absent.
 * @param db - The registry's current database handle.
 * @param ids - Session identifiers to read.
 */
export function readSessionBindings(db: Db, ids: string[]): Map<string, SessionBinding> {
  const result = new Map<string, SessionBinding>();
  for (let i = 0; i < ids.length; i += BOUND_RUNTIME_CHUNK_SIZE) {
    const rows = db
      .select({
        sessionId: sessionMetadata.sessionId,
        runtime: sessionMetadata.runtime,
        createdAt: sessionMetadata.createdAt,
      })
      .from(sessionMetadata)
      .where(inArray(sessionMetadata.sessionId, ids.slice(i, i + BOUND_RUNTIME_CHUNK_SIZE)))
      .all();
    for (const row of rows) {
      if (!row.runtime) continue;
      // `created_at` is free-form TEXT that this class writes as ISO 8601.
      // Anything that does not parse is reported as unknown rather than as a
      // number a caller would compare against — the same treatment
      // `rowToSettings` gives an unreadable effort level.
      const parsed = Date.parse(row.createdAt);
      result.set(row.sessionId, {
        runtime: row.runtime,
        boundAt: Number.isFinite(parsed) ? parsed : null,
      });
    }
  }
  return result;
}
