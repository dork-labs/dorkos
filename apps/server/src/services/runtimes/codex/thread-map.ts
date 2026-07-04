/**
 * Codex Thread Map — adapter-owned durable mapping from a DorkOS `sessionId`
 * to its Codex `threadId` and the `cwd` the thread was created in (ADR-0309:
 * one DorkOS session <-> one Codex thread).
 *
 * Backed by the dedicated `codex_threads` table so `session_metadata`
 * (ADR-0255/0260) stays completely untouched. The binding is immutable once
 * assigned — writes use INSERT OR IGNORE (first-write-wins), mirroring
 * `RuntimeRegistry.persistSessionRuntime`. The `cwd` is persisted so resume
 * after a server restart (which wipes the in-memory registry) still runs
 * `codex exec` in the right directory rather than the server's `process.cwd()`.
 *
 * @module services/runtimes/codex/thread-map
 */
import { codexThreads, eq, type Db } from '@dorkos/db';

/**
 * A persisted Codex thread binding: the SDK thread id plus the working
 * directory the thread was created in.
 */
export interface CodexThreadBinding {
  /** Codex thread identifier bound to the session. */
  threadId: string;
  /**
   * Working directory the thread was created in, or `undefined` for pre-cwd
   * (legacy) bindings persisted before the `cwd` column existed.
   */
  cwd: string | undefined;
}

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
   * Look up the full binding (thread id + cwd) for a DorkOS session.
   *
   * @param sessionId - DorkOS session identifier
   * @returns The binding, or `undefined` when no binding exists. `cwd` is
   *   `undefined` for legacy bindings persisted before the column existed.
   */
  get(sessionId: string): CodexThreadBinding | undefined {
    const row = this.db
      .select({ threadId: codexThreads.threadId, cwd: codexThreads.cwd })
      .from(codexThreads)
      .where(eq(codexThreads.sessionId, sessionId))
      .get();
    return row ? { threadId: row.threadId, cwd: row.cwd ?? undefined } : undefined;
  }

  /**
   * Look up the Codex thread bound to a DorkOS session.
   *
   * A focused convenience accessor over {@link CodexThreadMap.get} for callers
   * that only need the thread id (the full binding, incl. `cwd`, comes from
   * `get`). Retained as a stable, self-documenting part of the map's surface.
   *
   * @param sessionId - DorkOS session identifier
   * @returns The bound Codex thread id, or `undefined` when no binding exists
   */
  getThreadId(sessionId: string): string | undefined {
    return this.get(sessionId)?.threadId;
  }

  /**
   * Bind a Codex thread to a DorkOS session.
   *
   * Uses INSERT OR IGNORE semantics: if a binding already exists for
   * `sessionId`, it is left untouched — the first write wins. Call this once
   * when the Codex thread is created for the session. The session's `cwd` is
   * persisted alongside the thread id so a post-restart `resumeThread` runs in
   * the right project directory (the in-memory registry's cwd does not survive
   * a restart). Omit `cwd` when it is genuinely unknown — a null column then
   * degrades to the pre-cwd behavior on resume.
   *
   * @param sessionId - DorkOS session identifier
   * @param threadId - Codex thread identifier to bind
   * @param cwd - Working directory the thread was created in, when known
   */
  setThreadId(sessionId: string, threadId: string, cwd?: string): void {
    this.db
      .insert(codexThreads)
      .values({
        sessionId,
        threadId,
        createdAt: new Date().toISOString(),
        ...(cwd !== undefined ? { cwd } : {}),
      })
      .onConflictDoNothing()
      .run();
  }
}
