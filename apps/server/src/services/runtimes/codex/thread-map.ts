/**
 * Codex Thread Map — adapter-owned durable mapping from a DorkOS `sessionId`
 * to its Codex `threadId`, the `cwd` the thread was created in (ADR-0309:
 * one DorkOS session <-> one Codex thread), and the session's display
 * metadata (title / updatedAt / lastMessagePreview) written through from the
 * in-memory session registry so the session list survives a server restart.
 *
 * Backed by the dedicated `codex_threads` table so `session_metadata`
 * (ADR-0255/0260) stays completely untouched. The binding (threadId + cwd)
 * is immutable once assigned — writes use INSERT OR IGNORE (first-write-wins),
 * mirroring `RuntimeRegistry.persistSessionRuntime` — while the display
 * metadata is mutable via {@link CodexThreadMap.updateMetadata}. The `cwd` is
 * persisted so resume after a server restart (which wipes the in-memory
 * registry) still runs `codex exec` in the right directory rather than the
 * server's `process.cwd()`.
 *
 * @module services/runtimes/codex/thread-map
 */
import { codexThreads, eq, and, isNull, type Db, type CodexThread } from '@dorkos/db';

/**
 * Mutable display-metadata fields on a persisted Codex thread row. All
 * optional: patches carry only the fields that changed.
 */
export interface CodexThreadMetadataPatch {
  /** Session display title. */
  title?: string;
  /** ISO 8601 timestamp of the last metadata-bearing activity. */
  updatedAt?: string;
  /** One-line preview of the last triggered message. */
  lastMessagePreview?: string;
}

/**
 * A persisted Codex thread binding: the SDK thread id, the working directory
 * the thread was created in, and the session's durable display metadata.
 */
export interface CodexThreadBinding {
  /** Codex thread identifier bound to the session. */
  threadId: string;
  /**
   * Working directory the thread was created in, or `undefined` for pre-cwd
   * (legacy) bindings persisted before the `cwd` column existed.
   */
  cwd: string | undefined;
  /**
   * Session display title, or `undefined` for legacy rows persisted before
   * the metadata columns existed (degrades to a blank title on hydration).
   */
  title: string | undefined;
  /**
   * ISO 8601 timestamp of the last metadata write-through, or `undefined`
   * for legacy rows (hydration falls back to `createdAt`).
   */
  updatedAt: string | undefined;
  /** One-line preview of the last triggered message, or `undefined` for legacy rows. */
  lastMessagePreview: string | undefined;
}

/**
 * A full `codex_threads` row: the binding plus its identity and creation
 * timestamp — the shape {@link CodexThreadMap.listAll} yields for startup
 * hydration.
 */
export interface CodexThreadRecord extends CodexThreadBinding {
  /** DorkOS session identifier (the table's primary key). */
  sessionId: string;
  /** ISO 8601 timestamp the binding was persisted at. */
  createdAt: string;
}

/** Convert a raw `codex_threads` row into its exported record shape (NULL -> undefined). */
function toRecord(row: CodexThread): CodexThreadRecord {
  return {
    sessionId: row.sessionId,
    threadId: row.threadId,
    cwd: row.cwd ?? undefined,
    createdAt: row.createdAt,
    title: row.title ?? undefined,
    updatedAt: row.updatedAt ?? undefined,
    lastMessagePreview: row.lastMessagePreview ?? undefined,
  };
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
   * Look up the full binding (thread id + cwd + display metadata) for a
   * DorkOS session.
   *
   * @param sessionId - DorkOS session identifier
   * @returns The binding, or `undefined` when no binding exists. `cwd` and the
   *   metadata fields are `undefined` for legacy rows persisted before their
   *   columns existed.
   */
  get(sessionId: string): CodexThreadBinding | undefined {
    const record = this.getRecord(sessionId);
    if (!record) return undefined;
    return {
      threadId: record.threadId,
      cwd: record.cwd,
      title: record.title,
      updatedAt: record.updatedAt,
      lastMessagePreview: record.lastMessagePreview,
    };
  }

  /**
   * Look up the full persisted record (binding + sessionId + createdAt) for a
   * DorkOS session: the single-row complement to {@link CodexThreadMap.listAll},
   * used to seed one session's registry entry from its durable row on demand.
   *
   * @param sessionId - DorkOS session identifier
   * @returns The full record, or `undefined` when no row exists
   */
  getRecord(sessionId: string): CodexThreadRecord | undefined {
    const row = this.db
      .select()
      .from(codexThreads)
      .where(eq(codexThreads.sessionId, sessionId))
      .get();
    return row ? toRecord(row) : undefined;
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
   * degrades to the pre-cwd behavior on resume. `metadata` carries the display
   * metadata captured at bind time (the registry's title/preview/updatedAt) so
   * the first turn's metadata lands with the row instead of waiting for the
   * next {@link CodexThreadMap.updateMetadata} write-through.
   *
   * @param sessionId - DorkOS session identifier
   * @param threadId - Codex thread identifier to bind
   * @param cwd - Working directory the thread was created in, when known
   * @param metadata - Initial display metadata for the row, when known
   */
  setThreadId(
    sessionId: string,
    threadId: string,
    cwd?: string,
    metadata?: CodexThreadMetadataPatch
  ): void {
    this.db
      .insert(codexThreads)
      .values({
        sessionId,
        threadId,
        createdAt: new Date().toISOString(),
        ...(cwd !== undefined ? { cwd } : {}),
        ...(metadata?.title !== undefined ? { title: metadata.title } : {}),
        ...(metadata?.updatedAt !== undefined ? { updatedAt: metadata.updatedAt } : {}),
        ...(metadata?.lastMessagePreview !== undefined
          ? { lastMessagePreview: metadata.lastMessagePreview }
          : {}),
      })
      .onConflictDoNothing()
      .run();
  }

  /**
   * Update a persisted row's display metadata (the mutable complement to the
   * immutable binding).
   *
   * A deliberate no-op when the row does not exist yet: the row is only
   * created once `thread.started` reveals the thread id, so metadata written
   * before the first bind simply stays in-memory-only until then (the bind
   * itself carries it via {@link CodexThreadMap.setThreadId}).
   *
   * @param sessionId - DorkOS session identifier
   * @param patch - Metadata fields to update; omitted fields are left untouched
   */
  updateMetadata(sessionId: string, patch: CodexThreadMetadataPatch): void {
    const values = {
      ...(patch.title !== undefined ? { title: patch.title } : {}),
      ...(patch.updatedAt !== undefined ? { updatedAt: patch.updatedAt } : {}),
      ...(patch.lastMessagePreview !== undefined
        ? { lastMessagePreview: patch.lastMessagePreview }
        : {}),
    };
    if (Object.keys(values).length === 0) return;
    this.db.update(codexThreads).set(values).where(eq(codexThreads.sessionId, sessionId)).run();
  }

  /**
   * Backfill the persisted cwd on a legacy row bound without one (pre-cwd
   * builds, DOR-202). Guarded to NULL rows only, so the binding stays
   * first-write-wins — an existing cwd is never overwritten. Without this a
   * legacy session gains a cwd only in memory and re-hydrates cwd-less
   * (belonging to no project list) after every restart (ADR 260707-193314).
   *
   * @param sessionId - DorkOS session identifier
   * @param cwd - Working directory resolved for the session's current turn
   */
  backfillCwd(sessionId: string, cwd: string): void {
    this.db
      .update(codexThreads)
      .set({ cwd })
      .where(and(eq(codexThreads.sessionId, sessionId), isNull(codexThreads.cwd)))
      .run();
  }

  /**
   * All persisted thread records — the startup hydration source that re-seeds
   * the in-memory session registry after a server restart.
   */
  listAll(): CodexThreadRecord[] {
    return this.db.select().from(codexThreads).all().map(toRecord);
  }
}
