/**
 * Codex Thread Map — adapter-owned durable mapping from a DorkOS `sessionId`
 * to its Codex `threadId` (ADR-0307: one DorkOS session <-> one Codex thread).
 *
 * Backed by the dedicated `codex_threads` table so `session_metadata`
 * (ADR-0255/0260) stays completely untouched. The binding is immutable once
 * assigned — writes use INSERT OR IGNORE (first-write-wins), mirroring
 * `RuntimeRegistry.persistSessionRuntime`.
 *
 * @module services/runtimes/codex/thread-map
 */
import { codexThreads, eq, type Db } from '@dorkos/db';

/**
 * Durable sessionId -> threadId map for the Codex runtime.
 *
 * The composition root (`apps/server/src/index.ts`) constructs this with the
 * consolidated Drizzle `Db` handle — never a filesystem path, per
 * `.claude/rules/dork-home.md`.
 */
export class CodexThreadMap {
  constructor(private readonly db: Db) {}

  /**
   * Look up the Codex thread bound to a DorkOS session.
   *
   * @param sessionId - DorkOS session identifier
   * @returns The bound Codex thread id, or `undefined` when no binding exists
   */
  getThreadId(sessionId: string): string | undefined {
    const row = this.db
      .select({ threadId: codexThreads.threadId })
      .from(codexThreads)
      .where(eq(codexThreads.sessionId, sessionId))
      .get();
    return row?.threadId;
  }

  /**
   * Bind a Codex thread to a DorkOS session.
   *
   * Uses INSERT OR IGNORE semantics: if a binding already exists for
   * `sessionId`, it is left untouched — the first write wins. Call this once
   * when the Codex thread is created for the session.
   *
   * @param sessionId - DorkOS session identifier
   * @param threadId - Codex thread identifier to bind
   */
  setThreadId(sessionId: string, threadId: string): void {
    this.db
      .insert(codexThreads)
      .values({ sessionId, threadId, createdAt: new Date().toISOString() })
      .onConflictDoNothing()
      .run();
  }
}
