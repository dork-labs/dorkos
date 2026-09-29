/**
 * Each session's last context reading, kept so it shows the moment the
 * session opens and after a restart (spec `claude-account-fleet` §6 U).
 *
 * Backed by the `session_context` table, never `session_metadata`: opening a
 * session writes here, and a runtime-less `session_metadata` row would read as
 * a conversation that already exists. The row is moved across a canonical-id
 * rekey by `RuntimeRegistry.rekeySessionSettings`.
 *
 * @module services/session/fleet/session-context-store
 */
import { eq, sessionContext, type Db } from '@dorkos/db';
import type { SessionContextUsage } from '@dorkos/shared/session-stream';

/** One stored context reading. */
export interface SessionContextReading {
  /** Tokens occupying the context window. */
  contextTokens: number;
  /** The model's context window; `0` when the runtime did not say. */
  contextMaxTokens: number;
  /** When it was measured (ISO-8601). */
  observedAt: string;
}

/**
 * A stored reading as the status's `contextUsage`. The table keeps only the
 * two figures a gauge needs; the per-turn breakdown (output and cache tokens)
 * is a turn's own and reads as zero until the next turn reports it.
 *
 * @param reading - The stored reading.
 */
export function contextUsageOfReading(reading: SessionContextReading): SessionContextUsage {
  return {
    totalTokens: reading.contextTokens,
    maxTokens: reading.contextMaxTokens,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    observedAt: reading.observedAt,
  };
}

/** Reads and writes `session_context`. */
export class SessionContextStore {
  /**
   * Build a store over the database.
   *
   * @param db - The DorkOS database.
   */
  constructor(private readonly db: Db) {}

  /**
   * The session's stored reading, or `null`.
   *
   * @param sessionId - The session.
   */
  get(sessionId: string): SessionContextReading | null {
    const row = this.db
      .select()
      .from(sessionContext)
      .where(eq(sessionContext.sessionId, sessionId))
      .get();
    return row
      ? {
          contextTokens: row.contextTokens,
          contextMaxTokens: row.contextMaxTokens,
          observedAt: row.observedAt,
        }
      : null;
  }

  /**
   * Store a reading only when the session has none, and return the reading the
   * session now holds. For a DERIVED reading: a turn's reading written while the
   * derivation was in flight is newer, and must never be replaced by it.
   *
   * @param sessionId - The session.
   * @param reading - The derived reading.
   */
  putIfAbsent(sessionId: string, reading: SessionContextReading): SessionContextReading {
    this.db
      .insert(sessionContext)
      .values({ sessionId, ...reading })
      .onConflictDoNothing({ target: sessionContext.sessionId })
      .run();
    return this.get(sessionId) ?? reading;
  }

  /**
   * Store a reading, replacing the session's previous one.
   *
   * @param sessionId - The session.
   * @param reading - The reading.
   */
  put(sessionId: string, reading: SessionContextReading): void {
    this.db
      .insert(sessionContext)
      .values({ sessionId, ...reading })
      .onConflictDoUpdate({ target: sessionContext.sessionId, set: reading })
      .run();
  }
}
