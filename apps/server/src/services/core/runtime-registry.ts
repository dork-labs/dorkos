import type { AgentRuntime, RuntimeCapabilities } from '@dorkos/shared/agent-runtime';
import type { SessionSettings } from '@dorkos/shared/types';
import { sessionMetadata, eq, inArray, type Db } from '@dorkos/db';
import { logger } from '../../lib/logger.js';

/** Columns read from `session_metadata` for the settings projection. */
type SettingsRow = {
  permissionMode: string | null;
  model: string | null;
  effort: string | null;
  fastMode: boolean | null;
};

/** Map a settings DB row (NULLs) to a `SessionSettings` object (omitted keys). */
function rowToSettings(row: SettingsRow): SessionSettings {
  const settings: SessionSettings = {};
  if (row.permissionMode != null)
    settings.permissionMode = row.permissionMode as SessionSettings['permissionMode'];
  if (row.model != null) settings.model = row.model;
  if (row.effort != null) settings.effort = row.effort as SessionSettings['effort'];
  if (row.fastMode != null) settings.fastMode = row.fastMode;
  return settings;
}

/** Reduce `SessionSettings` to only the explicitly-provided keys for an UPSERT patch. */
function pickSettings(settings: SessionSettings): Partial<typeof sessionMetadata.$inferInsert> {
  const patch: Partial<typeof sessionMetadata.$inferInsert> = {};
  if (settings.permissionMode !== undefined) patch.permissionMode = settings.permissionMode;
  if (settings.model !== undefined) patch.model = settings.model;
  if (settings.effort !== undefined) patch.effort = settings.effort;
  if (settings.fastMode !== undefined) patch.fastMode = settings.fastMode;
  return patch;
}

/**
 * Error thrown when a session's stored runtime type is not registered with the
 * `RuntimeRegistry`. Surfacing this explicitly (rather than silently falling
 * back to the default runtime) prevents routing bugs where a session's intended
 * runtime is unavailable — e.g., a `codex` session before the Codex adapter
 * ships, or a server started without a runtime that prior sessions depended on.
 */
export class RuntimeNotRegisteredError extends Error {
  constructor(
    public readonly runtime: string,
    public readonly sessionId: string
  ) {
    super(
      `Session '${sessionId}' is owned by runtime '${runtime}', which is not registered on this server.`
    );
    this.name = 'RuntimeNotRegisteredError';
  }
}

/**
 * Registry of available agent runtimes, keyed by type string.
 *
 * Initialized at server startup with one or more runtime implementations.
 * Routes and services use `runtimeRegistry.getDefault()` to get the active runtime,
 * or `runtimeRegistry.resolveForSession(sessionId)` to dispatch per-session based
 * on the `session_metadata` DB table (see ADR 0255).
 */
export class RuntimeRegistry {
  private runtimes = new Map<string, AgentRuntime>();
  private defaultType: string = 'claude-code';
  private db: Db | undefined;

  /**
   * Register a runtime implementation.
   *
   * @param runtime - The runtime to register. Replaces any existing registration for the same type.
   */
  register(runtime: AgentRuntime): void {
    this.runtimes.set(runtime.type, runtime);
  }

  /**
   * Inject the consolidated Drizzle DB handle used for `session_metadata` lookups.
   *
   * The registry is a module-level singleton instantiated before the DB exists
   * at server boot, so the composition root (`apps/server/src/index.ts`) calls
   * this once after `createDb()` — before any route or service uses a
   * session-scoped method. Session-scoped methods throw if called before this.
   */
  setDb(db: Db): void {
    this.db = db;
  }

  /**
   * Get a runtime by type.
   *
   * @param type - The runtime type string (e.g. 'claude-code')
   * @throws If the type is not registered
   */
  get(type: string): AgentRuntime {
    const runtime = this.runtimes.get(type);
    if (!runtime) throw new Error(`Runtime '${type}' not registered`);
    return runtime;
  }

  /** Get the default runtime (claude-code unless changed via setDefault). */
  getDefault(): AgentRuntime {
    return this.get(this.defaultType);
  }

  /**
   * Resolve the runtime for a specific agent by looking up the agent manifest's runtime field.
   * Falls back to the default runtime if the agent has no runtime specified or meshCore is unavailable.
   *
   * @param agentId - The mesh agent ID to resolve runtime for
   * @param meshCore - Optional MeshCore instance for agent manifest lookup
   */
  resolveForAgent(
    agentId: string,
    meshCore?: { getAgent(id: string): { runtime?: string } | undefined }
  ): AgentRuntime {
    if (meshCore) {
      const agent = meshCore.getAgent(agentId);
      if (agent?.runtime) {
        const runtime = this.runtimes.get(agent.runtime);
        if (runtime) return runtime;
      }
    }
    return this.getDefault();
  }

  /**
   * Persist the owning runtime for a session in `session_metadata`.
   *
   * Uses INSERT OR IGNORE semantics: if a row already exists for `sessionId`,
   * it is left untouched. Session ownership is immutable once assigned — the
   * first write wins. Call this once at session-creation time.
   *
   * @param sessionId - Session identifier (any runtime's session id)
   * @param runtime - Runtime type string (e.g. `'claude-code'`, `'codex'`)
   * @param agentPath - Optional path to the agent that owns this session
   */
  async persistSessionRuntime(
    sessionId: string,
    runtime: string,
    agentPath?: string
  ): Promise<void> {
    const db = this.requireDb('persistSessionRuntime');
    await db
      .insert(sessionMetadata)
      .values({
        sessionId,
        runtime,
        agentPath: agentPath ?? null,
        createdAt: new Date().toISOString(),
      })
      .onConflictDoNothing();
  }

  /**
   * Return the runtime type string for a session.
   *
   * Pure read — never writes. If `session_metadata` has no row for
   * `sessionId`, infers `'claude-code'` when that adapter is registered
   * (legacy sessions predate the table), otherwise the default registered
   * type. The caller is responsible for persisting the inference via
   * `persistSessionRuntime` when it is the session-creation path; for
   * arbitrary read paths (e.g. `/api/sessions/:id/runtime-type`) we avoid
   * accidental ghost rows by never writing here.
   *
   * @param sessionId - Session identifier
   */
  async getSessionRuntimeType(sessionId: string): Promise<string> {
    const db = this.requireDb('getSessionRuntimeType');
    const row = db
      .select({ runtime: sessionMetadata.runtime })
      .from(sessionMetadata)
      .where(eq(sessionMetadata.sessionId, sessionId))
      .get();
    if (row) return row.runtime;

    // Legacy inference: sessions predating the registry table are Claude Code
    // sessions — but only when that adapter is actually registered. On a
    // DORKOS_TEST_RUNTIME server (test-mode only), inferring 'claude-code'
    // would 503 every PRE-first-message read — `/events` connect, history GET,
    // commands — for a brand-new client-created id (which has no row until the
    // first POST persists one), leaving the client permanently stream-less.
    const inferred = this.runtimes.has('claude-code') ? 'claude-code' : this.getDefaultType();
    logger.debug(
      `[RuntimeRegistry] Inferring runtime='${inferred}' for row-less session '${sessionId}' (not persisted)`
    );
    return inferred;
  }

  /**
   * Resolve the runtime instance that owns a session.
   *
   * Reads `session_metadata`; row-less sessions resolve through
   * {@link getSessionRuntimeType}'s inference (no row is written here). If the
   * stored runtime type is not currently registered, throws
   * {@link RuntimeNotRegisteredError} rather than silently routing to the
   * default — masking such mismatches would hide routing bugs (e.g., a `codex`
   * session on a server without the Codex adapter).
   *
   * @param sessionId - Session identifier
   * @throws {RuntimeNotRegisteredError} If the session's stored runtime is not registered.
   */
  async resolveForSession(sessionId: string): Promise<AgentRuntime> {
    const runtimeType = await this.getSessionRuntimeType(sessionId);
    const runtime = this.runtimes.get(runtimeType);
    if (!runtime) throw new RuntimeNotRegisteredError(runtimeType, sessionId);
    return runtime;
  }

  // ---------------------------------------------------------------------------
  // Per-session settings store (SessionSettingsPort; ADR-0260)
  //
  // Mutable operator preferences live in the same `session_metadata` row as the
  // immutable runtime ownership, but with last-write-wins semantics. The
  // registry owns this table and is the only place that can satisfy the
  // `runtime NOT NULL` constraint when a settings change arrives before the
  // first message (it resolves/infers the owning runtime).
  // ---------------------------------------------------------------------------

  /**
   * Read a session's persisted settings, or null when no row exists. NULL
   * columns are omitted from the result (not surfaced as explicit values).
   *
   * @param sessionId - Session identifier
   */
  async getSessionSettings(sessionId: string): Promise<SessionSettings | null> {
    const db = this.requireDb('getSessionSettings');
    const row = db
      .select({
        permissionMode: sessionMetadata.permissionMode,
        model: sessionMetadata.model,
        effort: sessionMetadata.effort,
        fastMode: sessionMetadata.fastMode,
      })
      .from(sessionMetadata)
      .where(eq(sessionMetadata.sessionId, sessionId))
      .get();
    return row ? rowToSettings(row) : null;
  }

  /**
   * Persist (UPSERT) the provided settings fields for a session. Only keys that
   * are explicitly present are written; identity columns (`runtime`,
   * `agentPath`, `createdAt`) are left intact on conflict. Creates the row with
   * the resolved/inferred runtime if it does not yet exist (e.g. a settings
   * change before the first message). No-op when no fields are provided.
   *
   * @param sessionId - Session identifier
   * @param settings - Partial settings to persist (omitted keys are untouched)
   */
  async saveSessionSettings(sessionId: string, settings: SessionSettings): Promise<void> {
    const db = this.requireDb('saveSessionSettings');
    const patch = pickSettings(settings);
    if (Object.keys(patch).length === 0) return;
    const runtime = await this.getSessionRuntimeType(sessionId);
    db.insert(sessionMetadata)
      .values({ sessionId, runtime, createdAt: new Date().toISOString(), ...patch })
      .onConflictDoUpdate({ target: sessionMetadata.sessionId, set: patch })
      .run();
  }

  /**
   * Batch-read persisted settings for many sessions in a single query. Used by
   * the session-list route overlay to avoid N+1 reads. Sessions without a row
   * are simply absent from the returned map.
   *
   * @param ids - Session identifiers to read
   */
  getSessionSettingsMany(ids: string[]): Map<string, SessionSettings> {
    const result = new Map<string, SessionSettings>();
    if (ids.length === 0) return result;
    const db = this.requireDb('getSessionSettingsMany');
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

  /**
   * Set the default runtime type.
   *
   * @param type - The runtime type to use as default
   * @throws If the type is not registered
   */
  setDefault(type: string): void {
    if (!this.runtimes.has(type)) throw new Error(`Runtime '${type}' not registered`);
    this.defaultType = type;
  }

  /** List all registered runtimes. */
  listRuntimes(): AgentRuntime[] {
    return Array.from(this.runtimes.values());
  }

  /** Get capabilities for all registered runtimes, keyed by type. */
  getAllCapabilities(): Record<string, RuntimeCapabilities> {
    const caps: Record<string, RuntimeCapabilities> = {};
    for (const [type, runtime] of this.runtimes) {
      caps[type] = runtime.getCapabilities();
    }
    return caps;
  }

  /**
   * Check if a runtime type is registered.
   *
   * @param type - The runtime type to check
   */
  has(type: string): boolean {
    return this.runtimes.has(type);
  }

  /** Get the current default runtime type string. */
  getDefaultType(): string {
    return this.defaultType;
  }

  /** Throw a clear error if a session-scoped method is called before the DB is injected. */
  private requireDb(method: string): Db {
    if (!this.db) {
      throw new Error(
        `RuntimeRegistry.${method}() requires setDb() to be called first — see apps/server/src/index.ts composition root.`
      );
    }
    return this.db;
  }
}

/** Singleton — initialized at server startup. */
export const runtimeRegistry = new RuntimeRegistry();
