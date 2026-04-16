import type { AgentRuntime, RuntimeCapabilities } from '@dorkos/shared/agent-runtime';
import { sessionMetadata, eq, type Db } from '@dorkos/db';
import { logger } from '../../lib/logger.js';

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
        createdAt: new Date(),
      })
      .onConflictDoNothing();
  }

  /**
   * Return the runtime type string for a session.
   *
   * Pure read — never writes. If `session_metadata` has no row for
   * `sessionId`, returns the inferred legacy default `'claude-code'`. The
   * caller is responsible for persisting the inference via
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

    logger.debug(
      `[RuntimeRegistry] Inferring runtime='claude-code' for legacy session '${sessionId}' (not persisted)`
    );
    return 'claude-code';
  }

  /**
   * Resolve the runtime instance that owns a session.
   *
   * Reads `session_metadata`. Legacy sessions without a row are inferred as
   * `'claude-code'` and persisted on first access. If the stored runtime
   * type is not currently registered, throws {@link RuntimeNotRegisteredError}
   * rather than silently routing to the default — masking such mismatches
   * would hide routing bugs (e.g., a `codex` session on a server without
   * the Codex adapter).
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
