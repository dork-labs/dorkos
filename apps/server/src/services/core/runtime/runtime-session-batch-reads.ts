import { sessionMetadata, inArray, type Db } from '@dorkos/db';
import type { SessionSettings } from '@dorkos/shared/types';
import { rowToSettings } from './runtime-session-settings.js';

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
 * Where a session's runtime came from, for a caller that has to know.
 *
 * The registry answers "which runtime" for every session id it is handed,
 * including ids nothing has bound yet — see
 * {@link RuntimeRegistry.resolveSessionRuntime}. Routing wants that tolerance.
 * A gate does not: refusing a request on an inferred runtime refuses it on a
 * guess.
 */
export interface SessionRuntimeResolution {
  /** The runtime type to route by — the bound owner, or the inference. */
  type: string;
  /**
   * True when durable metadata or a native store identifies the owner. False
   * means no store has identified this session, and {@link type} is the
   * fallback rather than an answer.
   */
  bound: boolean;
}

/**
 * Read explicit persisted runtime ownership rows in the original bounded chunks.
 *
 * @param getDb - Original registry database accessor, invoked only for nonempty ids.
 * @param ids - Session identifiers to read.
 * @returns The original read-only projection keyed by session identifier.
 */
export function readSessionBindings(
  getDb: (method: string) => Db,
  ids: string[]
): Map<string, SessionBinding> {
  const result = new Map<string, SessionBinding>();
  if (ids.length === 0) return result;
  const db = getDb('getSessionBindings');
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

/**
 * Read persisted session settings without changing stored values.
 *
 * @param getDb - Original registry database accessor, invoked only for nonempty ids.
 * @param ids - Session identifiers to read.
 * @returns The original read-only projection keyed by session identifier.
 */
export function readSessionSettingsMany(
  getDb: (method: string) => Db,
  ids: string[]
): Map<string, SessionSettings> {
  const result = new Map<string, SessionSettings>();
  if (ids.length === 0) return result;
  const db = getDb('getSessionSettingsMany');
  const rows = db
    .select({
      sessionId: sessionMetadata.sessionId,
      permissionMode: sessionMetadata.permissionMode,
      model: sessionMetadata.model,
      effort: sessionMetadata.effort,
      fastMode: sessionMetadata.fastMode,
    })
    .from(sessionMetadata)
    .where(inArray(sessionMetadata.sessionId, ids))
    .all();
  for (const row of rows) result.set(row.sessionId, rowToSettings(row));
  return result;
}
