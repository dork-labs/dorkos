import type { AgentRuntime, RuntimeCapabilities } from '@dorkos/shared/agent-runtime';
import type { SessionSettings } from '@dorkos/shared/types';
import { EffortLevelSchema } from '@dorkos/shared/schemas';
// The module directly rather than the `../session/index.js` barrel. There is no
// cycle to dodge today — nothing that barrel exports imports this file, and
// `room-turn-runner.ts` does take the same resolver through it. The reason is
// coupling: the barrel is the whole session surface, and importing it here would
// put every module it re-exports on this one's load path to reach a single leaf
// function — so the first session module that ever imports the registry would
// close a cycle nobody edited. The direct import keeps that more than one
// re-export away.
import {
  resolveSessionDefaults,
  readAgentExecutionDefaults,
  type AgentExecutionDefaults,
} from '../session/resolve-session-defaults.js';
import { sessionMetadata, eq, inArray, isNull, sql, type Db, type SQL } from '@dorkos/db';
import { logger } from '../../lib/logger.js';
import { traceRuntime, watchRuntimeSignin } from '../observability/index.js';

/** Columns read from `session_metadata` for the settings projection. */
type SettingsRow = {
  permissionMode: string | null;
  model: string | null;
  effort: string | null;
  fastMode: boolean | null;
};

/**
 * Map a settings DB row (NULLs) to a `SessionSettings` object (omitted keys).
 *
 * `effort` is the one column parsed rather than cast. It is a free-form TEXT
 * column, so what comes back is whatever was written — including a rung that a
 * later release removed from the ladder, or anything a person put there by hand.
 * A cast made that string travel as an `EffortLevel` all the way into an adapter,
 * where claude-code's own mapper drops it (harmless) and codex's
 * `EFFORT_TO_REASONING` lookup yields `undefined` and sends
 * `modelReasoningEffort: undefined` into the SDK. An unreadable value means "no
 * preference" — the same thing NULL means — so it is dropped here, once, rather
 * than at three adapter edges.
 */
function rowToSettings(row: SettingsRow): SessionSettings {
  const settings: SessionSettings = {};
  if (row.permissionMode != null) settings.permissionMode = row.permissionMode;
  if (row.model != null) settings.model = row.model;
  if (row.effort != null) {
    const effort = EffortLevelSchema.safeParse(row.effort);
    if (effort.success) settings.effort = effort.data;
    else
      logger.warn('[RuntimeRegistry] ignoring an unreadable stored effort level', {
        stored: row.effort,
      });
  }
  if (row.fastMode != null) settings.fastMode = row.fastMode;
  return settings;
}

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
   * True only when `session_metadata` names an owner. False means NOBODY has
   * said which runtime this session runs on yet, and {@link type} is the
   * fallback rather than an answer.
   */
  bound: boolean;
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

/** The settings columns, as UPDATE expressions rather than plain values. */
type SettingsUpdate = { [K in keyof SessionSettings & string]?: SQL };

/**
 * Turn a seed into an UPDATE that fills only the columns still holding NULL.
 *
 * The UPSERT's INSERT branch gets "an explicit value wins" for free by ordering
 * (`...seed, ...patch`). Its UPDATE branch cannot: the value it must not
 * overwrite is already in the row, not in this statement. `coalesce(<column>,
 * <seed>)` is that same rule expressed against the stored row — which is what
 * lets a binding write seed a session whose settings were chosen before it
 * started, without touching one of those choices.
 *
 * **The model and the effort, and deliberately no other column.**
 * `permissionMode` needs more than filling — a stored mode has to be checked
 * against what the runtime being bound declares, so it has its own expression
 * ({@link RuntimeRegistry.claimedPermissionMode}). `fastMode` is never seeded:
 * {@link resolveSessionDefaults} has no tier for it, and it is also the one
 * BOOLEAN here — better-sqlite3 refuses to bind a JS boolean as a raw parameter
 * ("can only bind numbers, strings, bigints, buffers, and null"), so a seed that
 * ever grew a `fastMode` would throw here rather than quietly do nothing. Add it
 * with a driver-encoded value, not by extending this list.
 *
 * @param seed - The columns a newly-created row would have carried.
 */
function fillNullsWith(seed: Partial<typeof sessionMetadata.$inferInsert>): SettingsUpdate {
  const update: SettingsUpdate = {};
  for (const key of ['model', 'effort'] as const) {
    const value = seed[key];
    if (value !== undefined) update[key] = sql`coalesce(${sessionMetadata[key]}, ${value})`;
  }
  return update;
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
    // Wrap at the one registration seam so every runtime call is traced when
    // debug tracing is on, and left untouched (zero overhead) when off — no
    // span code leaks into the runtime adapters.
    //
    // The sign-in watch wraps OUTSIDE the tracing one so it is always present:
    // tracing returns the runtime untouched when it is off, and a credential
    // failure has to reach the operator whether or not anybody turned tracing
    // on. This is the one seam every turn passes through — the interactive
    // composer, a room reply, a scheduled run and a relay delivery all resolve
    // their runtime from here (DOR-1654).
    this.runtimes.set(runtime.type, watchRuntimeSignin(traceRuntime(runtime)));
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
   * Bind a session to its owning runtime in `session_metadata`.
   *
   * **First AUTHORITATIVE write wins (ADR-0255).** A row whose `runtime` is
   * already set is left completely untouched — ownership is immutable once a
   * session has started. A row whose `runtime` is NULL is CLAIMED by this call:
   * that row was minted by a settings change made before the first message, and
   * a preference chosen in a picker is not a binding (DOR-812). Which runtime
   * the session runs on is this call's to say, because this call is the one
   * carrying the person's runtime choice.
   *
   * The server's execution defaults ride the same statement (see
   * {@link RuntimeRegistry.seedForNewRow}), and only ever fill columns that are
   * still NULL — so an explicit choice made before the session started survives
   * being claimed, exactly as it survives the INSERT.
   *
   * @param sessionId - Session identifier (any runtime's session id)
   * @param runtime - Runtime type string (e.g. `'claude-code'`, `'codex'`)
   * @param agentPath - Optional path to the agent that owns this session
   * @param opts.interactive - Whether a PERSON is starting this session and will
   *   be watching it. Only then does the row inherit the configured default trust
   *   stop (spec `trust-dial`, decision 6) — a room, a scheduled task and a relay
   *   binding each carry their own permission mode and their own stricter gates,
   *   and must never be handed the cockpit's. Defaults to `false`, so the
   *   dangerous direction is the one a caller has to ask for by name.
   * @returns `true` when this call BOUND the session — whether it inserted the
   *   row or claimed an unbound one — and `false` when the session was already
   *   bound. Lets the caller fire a once-per-session side effect (e.g. the
   *   `session_created` usage event) without a separate existence check on the
   *   hot path. Binding is the honest moment for that event: a row minted by a
   *   settings change belongs to a session nobody has started yet.
   */
  async persistSessionRuntime(
    sessionId: string,
    runtime: string,
    agentPath?: string,
    opts?: { interactive?: boolean }
  ): Promise<boolean> {
    const db = this.requireDb('persistSessionRuntime');
    // The agent tier is read here, where the owning agent is actually known.
    // Read unconditionally rather than only for a row that turns out to be new:
    // the INSERT is what decides that, and it cannot await mid-statement.
    const agent = await readAgentExecutionDefaults(agentPath);
    const seed = this.seedForNewRow(runtime, { agent, interactive: opts?.interactive === true });
    const result = await db
      .insert(sessionMetadata)
      .values({
        sessionId,
        runtime,
        agentPath: agentPath ?? null,
        createdAt: new Date().toISOString(),
        ...seed,
      })
      .onConflictDoUpdate({
        target: sessionMetadata.sessionId,
        set: {
          runtime,
          // The binding write is what establishes identity, so the agent it
          // names is the session's — but only when it names one, so a caller
          // with no agent never erases a path some other write knew.
          ...(agentPath !== undefined ? { agentPath } : {}),
          ...fillNullsWith(seed),
          ...this.claimedPermissionMode(runtime, seed.permissionMode),
        },
        // The whole guard: claim a row nobody has bound, never re-bind one.
        setWhere: isNull(sessionMetadata.runtime),
      });
    // better-sqlite3 RunResult: `changes` is the number of rows actually written
    // — 1 for a fresh insert, 1 for a claim, and 0 when `setWhere` refused an
    // already-bound row. That is exactly "this call bound the session".
    return result.changes > 0;
  }

  /**
   * Return the runtime type string for a session.
   *
   * **This answer is sometimes a GUESS, and this signature cannot tell you
   * which.** It is {@link RuntimeRegistry.resolveSessionRuntime} with the
   * `bound` flag dropped — fine for routing, where an unbound session has to be
   * sent somewhere and the inference is the tolerant answer that keeps reads
   * working before a session binds.
   *
   * It is the WRONG read for anything that refuses a request. A gate that
   * validates against this string validates against the guess: that is how the
   * model gate came to tell a person picking OpenCode that "the claude-code
   * runtime cannot run" the model they had just chosen from the OpenCode menu
   * — for a session no runtime owned yet. Ask
   * {@link RuntimeRegistry.resolveSessionRuntime} instead and decline to judge
   * when `bound` is false.
   *
   * @param sessionId - Session identifier
   */
  async getSessionRuntimeType(sessionId: string): Promise<string> {
    return (await this.resolveSessionRuntime(sessionId)).type;
  }

  /**
   * Which runtime a session runs on — and whether anything has actually said so.
   *
   * Pure read; never writes. The one place the legacy inference lives, so no
   * caller re-derives it and the two copies cannot drift.
   *
   * Two shapes get the same INFERRED answer, because they are the same state:
   * `session_metadata` has no row for `sessionId` (legacy sessions predate the
   * table), or it has one whose `runtime` is NULL (a settings change arrived
   * before the session started — see
   * {@link RuntimeRegistry.saveSessionSettings}). Neither has an owner yet, so
   * both resolve to `'claude-code'` when that adapter is registered, otherwise
   * the default registered type.
   *
   * The inference is never persisted here. That is the point rather than an
   * optimization: a guess written down becomes the binding, and
   * `persistSessionRuntime` is first-write-wins — which is exactly how an early
   * settings write used to pin a session to the wrong runtime (DOR-812). Only
   * the session-creation path may write an owner.
   *
   * @param sessionId - Session identifier
   */
  async resolveSessionRuntime(sessionId: string): Promise<SessionRuntimeResolution> {
    const db = this.requireDb('resolveSessionRuntime');
    const row = db
      .select({ runtime: sessionMetadata.runtime })
      .from(sessionMetadata)
      .where(eq(sessionMetadata.sessionId, sessionId))
      .get();
    if (row?.runtime) return { type: row.runtime, bound: true };

    // Legacy inference: sessions predating the registry table are Claude Code
    // sessions — but only when that adapter is actually registered. On a
    // DORKOS_TEST_RUNTIME server (test-mode only), inferring 'claude-code'
    // would 503 every PRE-first-message read — `/events` connect, history GET,
    // commands — for a brand-new client-created id (which has no row until the
    // first POST binds one), leaving the client permanently stream-less.
    const inferred = this.runtimes.has('claude-code') ? 'claude-code' : this.getDefaultType();
    logger.debug(
      `[RuntimeRegistry] Inferring runtime='${inferred}' for unbound session '${sessionId}' (not persisted)`
    );
    return { type: inferred, bound: false };
  }

  /**
   * Resolve the runtime instance that owns a session.
   *
   * Reads `session_metadata`; row-less sessions resolve through
   * {@link resolveSessionRuntime}'s inference (no row is written here). If the
   * stored runtime type is not currently registered, throws
   * {@link RuntimeNotRegisteredError} rather than silently routing to the
   * default — masking such mismatches would hide routing bugs (e.g., a `codex`
   * session on a server without the Codex adapter).
   *
   * @param sessionId - Session identifier
   * @throws {RuntimeNotRegisteredError} If the session's stored runtime is not registered.
   */
  async resolveForSession(sessionId: string): Promise<AgentRuntime> {
    return (await this.resolveForSessionWithOwnership(sessionId)).runtime;
  }

  /**
   * {@link RuntimeRegistry.resolveForSession}, plus whether the runtime it
   * returned is the session's OWNER or the inference standing in for one.
   *
   * One read, both facts, for a caller that must not treat the second case as
   * the first — {@link RuntimeRegistry.getSessionRuntimeType} explains which
   * callers those are.
   *
   * @param sessionId - Session identifier
   * @throws {RuntimeNotRegisteredError} If the session's stored runtime is not registered.
   */
  async resolveForSessionWithOwnership(
    sessionId: string
  ): Promise<{ runtime: AgentRuntime; bound: boolean }> {
    const { type, bound } = await this.resolveSessionRuntime(sessionId);
    const runtime = this.runtimes.get(type);
    if (!runtime) throw new RuntimeNotRegisteredError(type, sessionId);
    return { runtime, bound };
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
   * Every session id bound to one agent directory.
   *
   * The bulk sibling of {@link RuntimeRegistry.getSessionAgentPath}, for the
   * session fan-out: it asks once per agent rather than once per row, and the
   * answer is what still says "this conversation is this agent's" when the
   * conversation's own directory says something else — a room turn running in
   * that room's worktree (spec `project-rooms` §3.5).
   *
   * The STORED value, never re-derived from a cwd. Returns an empty set when
   * the registry has no database, so a caller on a bare install degrades to
   * cwd-only membership rather than failing.
   *
   * @param agentPath - The agent's directory, exactly as it was bound.
   */
  listSessionIdsForAgentPath(agentPath: string): Set<string> {
    const db = this.db;
    if (!db) return new Set();
    const rows = db
      .select({ sessionId: sessionMetadata.sessionId })
      .from(sessionMetadata)
      .where(eq(sessionMetadata.agentPath, agentPath))
      .all();
    return new Set(rows.map((row) => row.sessionId));
  }

  /**
   * Read the working directory a session is bound to (`agentPath`), or null when
   * no bound row exists yet. This is the project directory the session's
   * transcript lives under — the one input a transcript read needs beyond the
   * session id (see `lib/transcript-excerpt.ts`). Null when the session has not
   * started (no binding row) or was created without an owning agent path; the
   * caller then falls back to the default working directory.
   *
   * @param sessionId - Session identifier
   */
  async getSessionAgentPath(sessionId: string): Promise<string | null> {
    const db = this.requireDb('getSessionAgentPath');
    const row = db
      .select({ agentPath: sessionMetadata.agentPath })
      .from(sessionMetadata)
      .where(eq(sessionMetadata.sessionId, sessionId))
      .get();
    return row?.agentPath ?? null;
  }

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
   * `agentPath`, `createdAt`) are left intact on conflict. Creates an UNBOUND
   * row if none exists yet (a settings change before the first message). No-op
   * when no fields are provided.
   *
   * **This write never names a runtime, and never seeds a default.** It cannot
   * honestly do either. It knows a session id and nothing else: the session has
   * not started, so nobody has said which runtime it will run on, and every
   * default there is to seed is a per-runtime answer (a model id lives in one
   * runtime's namespace, an effort is dropped where a runtime has none, a trust
   * stop is resolved from the runtime's own declared modes — see
   * {@link resolveSessionDefaults}). Writing either would be writing a guess,
   * and the guess used to become permanent: `persistSessionRuntime` is
   * first-write-wins, so changing a setting before sending the first message
   * pinned the session to the inferred runtime for life (DOR-812).
   *
   * So the row this creates carries the person's explicit choices and nothing
   * else, and the first turn — which does know the runtime — binds it and fills
   * in whatever they said nothing about ({@link persistSessionRuntime}).
   *
   * @param sessionId - Session identifier
   * @param settings - Partial settings to persist (omitted keys are untouched)
   */
  async saveSessionSettings(sessionId: string, settings: SessionSettings): Promise<void> {
    const db = this.requireDb('saveSessionSettings');
    const patch = pickSettings(settings);
    if (Object.keys(patch).length === 0) return;
    db.insert(sessionMetadata)
      .values({
        sessionId,
        // No owner: a preference chosen in a picker is not a binding.
        runtime: null,
        createdAt: new Date().toISOString(),
        ...patch,
      })
      // The UPDATE branch carries the patch alone — it must not disturb a
      // binding, and there is nothing else here to write.
      .onConflictDoUpdate({ target: sessionMetadata.sessionId, set: patch })
      .run();
  }

  /**
   * The `permission_mode` a CLAIM should write: the stored one if the runtime
   * being bound can actually run it, otherwise the seed, otherwise nothing.
   *
   * ## Why the claim has to judge a mode at all
   *
   * `PATCH /api/sessions/:id` already refuses a mode the session's runtime does
   * not declare — that gate is what keeps a session from reporting a safety
   * posture it is not running (a codex session reading "Auto" everywhere while
   * it runs read-only). But an UNBOUND session has no runtime for that gate to
   * ask, so it asks the INFERRED one, and the answer is only as good as the
   * guess. A person who chose Codex in the picker and then set a Claude-only
   * mode before sending gets past the gate honestly and would arrive on a bound
   * codex session holding a mode codex never declared.
   *
   * So the check runs again here, where the runtime is finally known. This is
   * the same rule as the route's, applied at the one other write that can settle
   * it — not a second, competing rule: both read the runtime's own descriptor
   * list, and neither knows a mode id by name.
   *
   * ## What it does in each case
   *
   * - **Declared** → kept. A choice made early is still the person's.
   * - **Not declared** → dropped, and the seed for the runtime being bound lands
   *   in its place (the `coalesce` order). Dropped rather than refused, because
   *   there is no request to refuse — the turn is already starting, and NULL
   *   means "the runtime decides" everywhere else in this table.
   * - **Runtime not registered here** (`undefined` descriptors, not an empty
   *   list) → left alone. No profile is no basis to judge, the same answer
   *   {@link RuntimeRegistry.seedForNewRow} gives; nothing can run such a
   *   session anyway ({@link resolveForSession} throws), so deleting the
   *   person's choice would only lose it.
   *
   * WRITE PATH ONLY, exactly as the route's gate is: this rides the claim, so a
   * session already bound and running in a now-undeclared mode keeps it.
   *
   * @param runtime - The runtime type this call is binding the session to.
   * @param seeded - The mode the seed would have written, if any.
   * @returns A one-key patch for the UPDATE's SET, or `{}` to leave the column
   *   out of the statement entirely.
   */
  private claimedPermissionMode(runtime: string, seeded: unknown): SettingsUpdate {
    const declared = this.runtimes.get(runtime)?.getCapabilities().permissionModes.values;
    const seed = typeof seeded === 'string' ? seeded : undefined;
    if (declared === undefined) {
      return seed === undefined
        ? {}
        : { permissionMode: sql`coalesce(${sessionMetadata.permissionMode}, ${seed})` };
    }
    // A runtime that declares no modes at all declares this one no more than any
    // other, so the stored value cannot survive — `sql`null`` rather than an
    // empty `in ()`, which drizzle refuses to build.
    const kept =
      declared.length > 0
        ? sql`case when ${inArray(
            sessionMetadata.permissionMode,
            declared.map((descriptor) => descriptor.id)
          )} then ${sessionMetadata.permissionMode} end`
        : sql`null`;
    return { permissionMode: seed === undefined ? kept : sql`coalesce(${kept}, ${seed})` };
  }

  /**
   * The execution settings a session BEING BOUND RIGHT NOW should start with,
   * as DB columns.
   *
   * One caller, {@link RuntimeRegistry.persistSessionRuntime}, and that is the
   * whole of the seeding rule: the defaults land on the write that names the
   * runtime, because every one of them is a per-runtime answer. They reach a row
   * a settings change created earlier (E3's pre-launch picker makes that the
   * normal way a session starts) through the UPDATE branch, which fills only the
   * columns still holding NULL — so a person's explicit choice is never
   * overwritten, and a session that has already started is never touched at all.
   *
   * @param runtime - The runtime type the row is being created for.
   * @param opts.agent - The owning agent's manifest model/effort, when the caller
   *   knows which agent that is. Omitted → the server default alone.
   * @param opts.interactive - Whether this row belongs to a session a person is
   *   watching. The permission mode rides ONLY on those: the runtime's declared
   *   modes are what turns a configured stop into a mode id, and withholding
   *   them is how an unattended surface is told "not for you" (see
   *   {@link resolveSessionDefaults}).
   */
  private seedForNewRow(
    runtime: string,
    opts: { agent?: AgentExecutionDefaults; interactive: boolean }
  ): Partial<typeof sessionMetadata.$inferInsert> {
    // Read off the REGISTERED runtime, not a table here: a runtime that is not
    // registered on this server has nothing declared to read, so it gets no
    // stop and no per-runtime section — the same answer as no preference. That
    // is the honest one for the degraded build this happens on: seeding a row
    // for a runtime that is not here would hand the fallback runtime a model id
    // from a namespace it cannot read (see {@link resolveSessionDefaults}).
    const declared = this.runtimes.get(runtime)?.getCapabilities();
    return pickSettings(
      resolveSessionDefaults({
        runtimeType: runtime,
        agent: opts.agent,
        // Which `runtimes.*` section holds this runtime's defaults is the
        // runtime's own declaration, and it has to arrive as an argument: this
        // module imports the resolver, so the resolver cannot import back.
        configSection: declared?.settings.configSection,
        // Same seam, same reason: whether this runtime takes an effort at all is
        // its own declaration. An unregistered runtime says nothing and the
        // resolver reads that as yes, which is where an agent's effort keeps
        // applying rather than vanishing on a build that is missing a runtime.
        supportsEffort: declared?.settings.supportsEffort,
        ...(opts.interactive ? { permissionModes: declared?.permissionModes.values } : {}),
      })
    );
  }

  /**
   * Move a session's `session_metadata` row from one id to another, so the row
   * stays under exactly one key when a runtime rebinds the session to a new
   * canonical id (claude-code, on the first turn of a new session).
   *
   * The whole row moves, not just the settings columns: the row describes ONE
   * session, and that session's id changed — `runtime`, `agentPath` and
   * `createdAt` belong with it. Ownership stays immutable (ADR-0255): when a row
   * already exists under `toId` its `runtime` is left untouched. A destination
   * that has no runtime yet is the one exception, and it is the same rule rather
   * than a hole in it — there is no ownership there to keep, so the source's
   * binding travels with the row it belongs to. The source row is deleted in the
   * same transaction, so the move never leaves a second copy behind.
   *
   * **The property this has to keep: an operator's explicit choice never loses
   * to anything that is not a NEWER operator's explicit choice.** Read that
   * twice before touching the merge, because the rows cannot express it on their
   * own — nothing in `session_metadata` records who wrote a column, so an
   * operator's `plan` and a server-seeded `acceptEdits` are the same shape once
   * written, and recency of the ROW is therefore not a stand-in for provenance.
   * Both merge directions have been measured wrong on some input:
   *
   * - **Source-wins** loses a newer operator choice to the retired row, because
   *   the source row is normally the older of the two.
   * - **Destination-wins** loses a genuine operator choice to a SEEDED default,
   *   because {@link RuntimeRegistry.persistSessionRuntime} INSERTs rows
   *   pre-filled from `runtimes.defaultTrustStop` (see
   *   {@link RuntimeRegistry.seedForNewRow}) — a newer row nobody chose.
   *
   * So the merge is not where the property is kept. It is kept by ORDERING, one
   * layer up: `message-sender` moves this row BEFORE it yields the event that
   * lets `trigger-turn` announce the canonical id, and a caller can only name an
   * id it has been told. By the time any POST or PATCH can arrive under `toId`,
   * the row is already there and already bound — so `persistSessionRuntime`
   * finds a bound row, seeds nothing, and reports no new session. That is what
   * removes the seeded rival from this merge's inputs rather than teaching the
   * merge to guess which value a person picked.
   *
   * Destination-wins per field is what remains, and it is right for the input
   * that is still reachable: two rows that both hold OPERATOR choices, where the
   * destination's is the later one. Keep both facts together — the rule is only
   * sound while the ordering above holds, and a future author who moves the
   * re-key back after the announcement re-opens the seeded direction. The
   * `session-settings-rekey` tests fail in exactly that case.
   *
   * What this does NOT promise: that a session can never have two rows again. A
   * stale client still holding the retired id and POSTing under it makes
   * {@link RuntimeRegistry.persistSessionRuntime} mint a fresh row for that id —
   * this moves the row, it does not reserve the id it left. Re-minting is
   * tracked separately (DOR-837); do not read this as a uniqueness guarantee the
   * schema does not enforce.
   *
   * @param fromId - The id the row is stored under today
   * @param toId - The canonical id the session is now known by
   */
  async rekeySessionSettings(fromId: string, toId: string): Promise<void> {
    if (fromId === toId) return;
    const db = this.requireDb('rekeySessionSettings');
    const source = db
      .select()
      .from(sessionMetadata)
      .where(eq(sessionMetadata.sessionId, fromId))
      .get();
    if (!source) return;
    const destination = db
      .select()
      .from(sessionMetadata)
      .where(eq(sessionMetadata.sessionId, toId))
      .get();
    db.transaction((tx) => {
      tx.delete(sessionMetadata).where(eq(sessionMetadata.sessionId, fromId)).run();
      if (!destination) {
        tx.insert(sessionMetadata)
          .values({ ...source, sessionId: toId })
          .run();
        return;
      }
      tx.update(sessionMetadata)
        .set({
          runtime: destination.runtime ?? source.runtime,
          permissionMode: destination.permissionMode ?? source.permissionMode,
          model: destination.model ?? source.model,
          effort: destination.effort ?? source.effort,
          fastMode: destination.fastMode ?? source.fastMode,
          agentPath: destination.agentPath ?? source.agentPath,
        })
        .where(eq(sessionMetadata.sessionId, toId))
        .run();
    });
    logger.debug(
      `[RuntimeRegistry] Re-keyed session_metadata '${fromId}' -> '${toId}'${destination ? ' (merged into existing row)' : ''}`
    );
  }

  /**
   * Batch-read the binding of each of these sessions — which runtime owns it
   * and when the row was written — with no inference whatsoever.
   *
   * The deliberate opposite of {@link getSessionRuntimeType}, which answers
   * every unbound session with the registered default so a read never 503s. A
   * caller about to DELETE something needs the other answer: a session with no
   * row, or a row whose `runtime` is still NULL, is owned by nobody as far as
   * this table is concerned, and it is simply absent from this map rather than
   * quietly attributed to claude-code. The boot reconcile
   * (`reconcile-session-rows.ts`) is that caller: an absent id keeps its rows.
   *
   * `boundAt` travels with it because the same caller must be able to tell a
   * binding older than this process from one this process just wrote — the
   * second is a session being created right now, whatever the disk says yet.
   *
   * Chunked, because every id spends one of SQLite's bound variables and the
   * caller's list is as long as the backlog it is reconciling. The chunking
   * lives here rather than at the caller so no future caller has to remember it.
   *
   * @param ids - Session identifiers to read
   */
  getSessionBindings(ids: string[]): Map<string, SessionBinding> {
    const result = new Map<string, SessionBinding>();
    if (ids.length === 0) return result;
    const db = this.requireDb('getSessionBindings');
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

/**
 * Apply the user's configured default runtime (`runtimes.default`) once all
 * production runtimes are registered. An unregistered value (disabled runtime,
 * typo) keeps the built-in default rather than failing boot. Returns whether
 * the configured value was applied so the caller can log the outcome.
 *
 * The default is shape-neutral: nothing reads `getDefault()` expecting a
 * Claude-shaped runtime. Callers use only the `AgentRuntime` interface, so
 * `codex` or `opencode` is a legitimate `runtimes.default` — the surfaces that
 * fall back to it (models, commands, subagents, MCP config) report that
 * runtime's own truth, and MCP config degrades to "no servers" rather than
 * reading Claude's `.mcp.json`. `claude-code` remains the *shipped* default;
 * that is a product choice, not a structural constraint.
 *
 * The relay is the one genuinely Claude-specific consumer, and it does not read
 * the default at all: the composition root binds it to the concrete claude-code
 * runtime (`relayAgentRuntime` in `index.ts`). {@link getDefaultType} is still
 * consulted once inside the relay — the binding subsystem prefers the default
 * when choosing which runtime to create chat-originated sessions on — but a
 * default the relay does not hold now falls back to the runtime it does hold and
 * logs the mismatch, instead of aborting binding initialization.
 *
 * @param registry - The registry with all production runtimes registered
 * @param configured - The `runtimes.default` config value
 */
export function applyConfiguredDefaultRuntime(
  registry: RuntimeRegistry,
  configured: string
): boolean {
  if (registry.has(configured)) {
    registry.setDefault(configured);
    return true;
  }
  return false;
}

/**
 * The settings this module reads, and the news that it changed — the whole of
 * `ConfigManager` this needs, named as a port so the watcher is testable without
 * a config file.
 */
export interface DefaultRuntimeConfigSource {
  /** The `runtimes.default` value as it stands right now. */
  read(): string;
  /** Subscribe to settings writes; returns an unsubscribe function. */
  onChange(listener: (change: { sections: readonly string[] }) => void): () => void;
}

/**
 * Apply `runtimes.default` now, and keep applying it when it changes.
 *
 * The default runtime is the one execution setting that is APPLIED rather than
 * read at use: the registry holds it, and everything that mints a session asks
 * the registry. Without this, changing it in Settings would agree with the person
 * and then do nothing until they restarted the server — which is the reason the
 * change-subscription primitive exists at all (spec `execution-defaults` §3.2).
 *
 * The model and effort defaults need nothing like this. They are read at the
 * moment a session is created, so a change simply governs the next session.
 *
 * @param registry - The registry with all production runtimes registered.
 * @param source - Where the value is read from and where the news comes from.
 * @returns An unsubscribe function.
 */
export function applyAndWatchConfiguredDefaultRuntime(
  registry: RuntimeRegistry,
  source: DefaultRuntimeConfigSource
): () => void {
  const apply = (): void => {
    const configured = source.read();
    if (applyConfiguredDefaultRuntime(registry, configured)) return;
    // An unregistered value keeps the built-in default rather than failing —
    // silently, when the two already agree (a fresh install naming 'claude-code'
    // before the adapter registers is not news).
    if (configured !== registry.getDefaultType()) {
      logger.warn('[Runtime] configured runtimes.default is not registered; keeping built-in', {
        configured,
        active: registry.getDefaultType(),
      });
    }
  };

  apply();
  return source.onChange((change) => {
    if (!change.sections.includes('runtimes')) return;
    const before = registry.getDefaultType();
    apply();
    const after = registry.getDefaultType();
    if (before !== after) {
      logger.info('[Runtime] default runtime changed without a restart', { before, after });
    }
  });
}

/**
 * Construct and register an optional runtime (Codex, OpenCode), tolerating a
 * synchronous construction failure. The Codex and OpenCode SDKs resolve their
 * CLI binary at `new` time and throw if it isn't found — the norm in the
 * packaged desktop app, which bundles only the claude-code SDK. Left
 * unguarded, that throw rejects `start()` and kills the whole server process
 * (the launch-blocking crash this exists to prevent). Mirrors the "keep
 * built-in default rather than fail boot" tolerance in
 * {@link applyConfiguredDefaultRuntime} and the per-runtime degradation
 * principle already established for session listing (ADR-0310): one optional
 * runtime failing to initialize must never take the others — or the server —
 * down with it.
 *
 * @param name - Human-readable runtime name for the warning log (e.g. `'CodexRuntime'`)
 * @param remedy - Plain-language hint naming what to install or disable to silence the warning
 * @param init - Synchronous callback that constructs, registers, and wires up the runtime; its return value passes through on success
 * @returns The initialized runtime, or `undefined` if construction/registration failed
 */
export function registerOptionalRuntime<T>(
  name: string,
  remedy: string,
  init: () => T
): T | undefined {
  try {
    return init();
  } catch (err) {
    logger.warn(
      `[Runtime] ${name} failed to initialize — this runtime is disabled for this session; ${remedy}`,
      {
        err,
      }
    );
    return undefined;
  }
}

/** Singleton — initialized at server startup. */
export const runtimeRegistry = new RuntimeRegistry();
