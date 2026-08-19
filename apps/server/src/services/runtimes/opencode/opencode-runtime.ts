/**
 * OpenCode Runtime — implements the AgentRuntime interface for OpenCode.
 *
 * One DorkOS session maps to one OpenCode session on the managed
 * `opencode serve` sidecar (ADR-0308), bound by {@link OpenCodeSessionMapper}.
 * A turn is trigger + stream: `session.promptAsync` (204; events ride SSE)
 * starts it, and the ONE per-runtime `client.global.event()` subscription
 * ({@link OpenCodeGlobalEventHub}) supplies raw wire events that are demuxed
 * per session with {@link matchesOpenCodeSession} — keyed on the OPENCODE
 * `ses_*` id and the directory AS STORED BY OPENCODE (`Session.directory`,
 * read back via `session.get`; never the DorkOS cwd, whose trailing-slash or
 * symlink drift would silently drop every event).
 *
 * Live turn state follows the Codex/test-mode pattern: `sendMessage` is a
 * pure StreamEvent producer (the platform's trigger-turn consumes it into the
 * per-session {@link SessionStateProjector}), and `subscribeSession` /
 * `getSessionSnapshot` are served from that projector. Unlike Codex, OpenCode
 * HAS a durable native store — listing and history delegate to the session
 * mapper (SDK reads against the sidecar), with the DorkOS-tracked settings
 * overlaid because OpenCode has no per-session permission mode of its own.
 *
 * Tool approvals are fully supported: the sidecar's ask-ruleset raises
 * `permission.asked` → `approval_required`, `approveTool()` answers through
 * `POST /session/{id}/permissions/{permissionID}` with `once`/`reject` (never
 * `always` — NOTES.md §2), mode enforcement auto-answers under
 * `acceptEdits`/`bypassPermissions`, and every forwarded request carries a
 * server-side auto-deny timer (see `approvals.ts`).
 *
 * @module services/runtimes/opencode/opencode-runtime
 */
import type { OpencodeClient, ProviderListResponse } from '@opencode-ai/sdk';
import type {
  StreamEvent,
  PermissionMode,
  EffortLevel,
  ModelOption,
  SubagentInfo,
  Session,
  HistoryMessage,
  TaskItem,
  CommandRegistry,
  SessionSettings,
} from '@dorkos/shared/types';
import type {
  AgentRuntime,
  RuntimeCapabilities,
  DependencyCheck,
  SessionOpts,
  MessageOpts,
  CommandIntentOpts,
  SseResponse,
  SessionSettingsPort,
  ToolDecisionOptions,
  ManagedMcpServerResolver,
} from '@dorkos/shared/agent-runtime';
import type {
  SessionSnapshot,
  SessionEvent,
  SessionListEvent,
} from '@dorkos/shared/session-stream';
import type { RuntimeCommandIntentId } from '@dorkos/shared/command-intents';
import type { McpServerEntry } from '@dorkos/shared/transport';
import { getOrCreateProjector, peekProjector } from '../../session/session-state-projector.js';
import { readLogBackedHistory } from '../../session/log-backed-history.js';
import { SessionLockManager } from '../../session/session-lock.js';
import { DEFAULT_CWD } from '../../../lib/resolve-root.js';
import { logger, logError } from '../../../lib/logger.js';
import { buildAgentContextAppend } from '../shared/agent-context.js';
import { checkOpenCodeDependencies, getConnectedOpenCodeProvider } from './check-dependencies.js';
import { detectOllama } from './ollama.js';
import {
  createOpenCodeEventContext,
  mapOpenCodeTurn,
  matchesOpenCodeSession,
  matchesOpenCodeSubagentSession,
  type OpenCodeWireEvent,
} from './event-mapper.js';
import { mapOpenCodeTodos } from './session-event-mapper.js';
import {
  OpenCodeSessionMapper,
  unwrap,
  type OpenCodeClientProvider,
  type OpenCodeSessionMapStore,
} from './session-mapper.js';
import { OpenCodeGlobalEventHub, TurnEventQueue } from './global-event-hub.js';
import { OpenCodeSessionRegistry } from './session-registry.js';
import {
  enforceApprovals,
  PendingApprovalStore,
  respondPermission,
  type ApprovalGateDeps,
  type ApprovalRouting,
} from './approvals.js';
import { OPENCODE_CAPABILITIES, STREAM_LIVE_TIMEOUT_MS } from './runtime-constants.js';
import { buildOpenCodeParts, parseModelSelection } from './turn-input.js';
import { projectModelOptions } from './models.js';
import { OpenCodeMcpManager } from './mcp-manager.js';

/** Constructor dependencies for {@link OpenCodeRuntime} (composition root). */
export interface OpenCodeRuntimeOptions {
  /**
   * Sidecar client source — the `openCodeServerManager` singleton in
   * production, a mock in tests (the `opencode` binary is never required).
   */
  provider: OpenCodeClientProvider;
  /**
   * Durable sessionId <-> OpenCode-session-id store (`OpenCodeSessionMap`
   * over the shared Drizzle handle in production). Keeps DorkOS-facing ids
   * stable across server restarts (DOR-251); tests that don't exercise
   * persistence may omit it.
   */
  sessionMap?: OpenCodeSessionMapStore;
}

/** One in-flight turn (identity-matched on teardown, like Codex's controllers). */
interface ActiveTurn {
  ocSessionId: string;
  cwd: string;
}

/** Sleep helper for the stream-liveness race. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * OpenCode runtime implementing the universal AgentRuntime interface.
 */
export class OpenCodeRuntime implements AgentRuntime {
  readonly type = 'opencode' as const;

  private readonly provider: OpenCodeClientProvider;
  private readonly mapper: OpenCodeSessionMapper;
  private readonly hub: OpenCodeGlobalEventHub;
  private readonly registry = new OpenCodeSessionRegistry();
  private readonly locks = new SessionLockManager();
  private readonly approvals = new PendingApprovalStore();
  /** What {@link enforceApprovals} reaches into on every mapped turn event. */
  private readonly approvalGate: ApprovalGateDeps;
  /** One record per in-flight turn (interrupt target). */
  private readonly activeTurns = new Map<string, ActiveTurn>();
  /** In-flight OpenCode session creations, deduped per DorkOS session id. */
  private readonly binding = new Map<string, Promise<string>>();
  /** OpenCode session id → its `Session.directory` (the demux key half). */
  private readonly directoryByOcId = new Map<string, string>();
  /** MCP status + managed injection, keyed by directory (DOR-893). */
  private readonly mcp: OpenCodeMcpManager;
  private settingsPort: SessionSettingsPort | undefined;

  constructor(options: OpenCodeRuntimeOptions) {
    this.provider = options.provider;
    this.mapper = new OpenCodeSessionMapper(options.provider, options.sessionMap);
    this.hub = new OpenCodeGlobalEventHub(options.provider);
    this.mcp = new OpenCodeMcpManager(options.provider);
    this.approvalGate = {
      provider: options.provider,
      approvals: this.approvals,
      registry: this.registry,
    };
  }

  // --- Session lifecycle ---

  /**
   * @inheritdoc
   *
   * Tracks the session's settings and eagerly binds it to a real OpenCode
   * session (fire-and-forget) so it exists in the sidecar's store — and its
   * listing — before the first message. Bind failures are non-fatal here: the
   * first `sendMessage` retries the binding and surfaces real errors.
   */
  ensureSession(sessionId: string, opts: SessionOpts): void {
    this.registry.register(sessionId, {
      permissionMode: opts.permissionMode,
      ...(opts.model !== undefined ? { model: opts.model } : {}),
      ...(opts.fastMode !== undefined ? { fastMode: opts.fastMode } : {}),
      ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
    });
    if (opts.cwd !== undefined) {
      void this.resolveOpenCodeSession(sessionId, opts.cwd).catch((err: unknown) => {
        logger.debug(
          '[OpenCodeRuntime] eager session bind failed (will retry on first message)',
          logError(err)
        );
      });
    }
  }

  hasSession(sessionId: string): boolean {
    return this.registry.has(sessionId);
  }

  /**
   * @inheritdoc
   *
   * OpenCode supports branching natively (`POST /session/{id}/fork`) — the
   * mapper forks the bound session and adopts the fork under a fresh derived
   * DorkOS id. Returns null when the source session has no OpenCode binding.
   */
  async forkSession(
    projectDir: string,
    sessionId: string,
    opts?: { upToMessageId?: string; title?: string }
  ): Promise<Session | null> {
    return this.mapper.forkSession(projectDir, sessionId, opts);
  }

  /**
   * @inheritdoc
   *
   * Auto-creates untracked sessions (the PATCH-before-first-message path) and
   * writes the operator's choice through the durable settings store first
   * (ADR-0260) so it survives restarts. The new mode applies to the very next
   * permission request — enforcement reads the registry live.
   *
   * `effort` is part of the shared signature and is DROPPED here — not tracked,
   * not echoed, and not written to the durable store. OpenCode's prompt API has
   * no effort field, so a persisted value could only ever be read back out at
   * the person as a setting that does nothing; storing it would make "Not
   * supported by OpenCode" false in the one place that matters (spec
   * `execution-defaults` §4).
   */
  async updateSession(
    sessionId: string,
    opts: {
      permissionMode?: PermissionMode;
      model?: string;
      effort?: EffortLevel;
      fastMode?: boolean;
    }
  ): Promise<boolean> {
    const { effort: _unsupported, ...storable } = opts;
    await this.settingsPort?.saveSessionSettings(sessionId, storable);
    this.registry.register(sessionId, {
      ...(opts.permissionMode !== undefined ? { permissionMode: opts.permissionMode } : {}),
      ...(opts.model !== undefined ? { model: opts.model } : {}),
      ...(opts.fastMode !== undefined ? { fastMode: opts.fastMode } : {}),
    });
    return true;
  }

  /**
   * @inheritdoc
   *
   * The title persists in OpenCode's own store (`session.update`); the
   * registry copy keeps the live session list current immediately.
   */
  async renameSession(sessionId: string, title: string, projectDir: string): Promise<void> {
    this.registry.rename(sessionId, title);
    await this.mapper.renameSession(projectDir, sessionId, title);
  }

  // --- Messaging ---

  /**
   * @inheritdoc
   *
   * Resolves the OpenCode session, subscribes a demux tap on the shared
   * global event stream, waits for the stream to be observably live, then
   * triggers the turn with `session.promptAsync` (204 — all delivery rides
   * the SSE stream) and yields the mapped events. {@link mapOpenCodeTurn}
   * guarantees exactly one terminal `done` on every path — completion,
   * failure (`session.error`), interrupt (`MessageAbortedError` → quiet
   * done), and mid-turn sidecar death (the hub fails the turn's queue, which
   * the mapper normalizes to a typed `error` + `done`).
   */
  async *sendMessage(
    sessionId: string,
    content: string,
    opts?: MessageOpts
  ): AsyncGenerator<StreamEvent> {
    const settings = await this.resolveTurnSettings(sessionId, opts);
    const cwd = opts?.cwd ?? this.registry.get(sessionId)?.cwd ?? DEFAULT_CWD;
    this.registry.recordMessage(sessionId, content, {
      cwd,
      ...(opts?.title !== undefined ? { title: opts.title } : {}),
    });

    // Runtime-neutral DorkOS context (identity, persona, safety boundaries,
    // <dorkos_context>, <env>): the same blocks the Claude adapter injects, so an
    // OpenCode agent knows who it is and how to reach its capabilities. It rides
    // the `synthetic` part with the rest of the injected prefix, so it never
    // renders as user-authored text.
    const agentContext = await buildAgentContextAppend(cwd);

    yield* this.runOpenCodeTurn(sessionId, cwd, opts?.title, async (client, ocSessionId) => {
      const model = parseModelSelection(settings.model);
      const prompted = await client.session.promptAsync({
        path: { id: ocSessionId },
        body: {
          parts: buildOpenCodeParts(content, opts, agentContext),
          ...(model !== undefined ? { model } : {}),
        },
      });
      if (prompted.error !== undefined) {
        throw new Error(`OpenCode session.promptAsync failed: ${JSON.stringify(prompted.error)}`);
      }
    });
  }

  /**
   * Fulfill the runtime-fulfilled `compact` intent (ADR-0273) by triggering
   * OpenCode's native sidecar compaction — `client.session.summarize` with the
   * body omitted, so compaction uses the session's own model. OpenCode reports
   * the result out-of-band as `session.compacted`, which the shared per-turn
   * demux tap ({@link runOpenCodeTurn}) maps to `operation_progress` done +
   * `compact_boundary` (event-mapper.ts) and {@link mapOpenCodeTurn} terminates
   * on the trailing `session.idle`. Driving it through the same turn path is
   * REQUIRED, not optional: there is no standing hub→projector subscription
   * outside a turn, so the boundary reaches the durable projector only because
   * this generator yields it. The `@opencode-ai/sdk` import stays confined to
   * this directory (Hard Rule 2). `OPENCODE_CAPABILITIES.commandIntents` gates
   * the route before this is ever called.
   */
  async *executeCommandIntent(
    sessionId: string,
    _intent: RuntimeCommandIntentId,
    opts?: CommandIntentOpts
  ): AsyncGenerator<StreamEvent> {
    // NOTE: `opts.instructions` is deliberately ignored — `session.summarize`
    // takes no instruction parameter, so OpenCode compaction cannot be guided.
    // An honest per-runtime difference (claude-code forwards instructions).
    const cwd = opts?.cwd ?? this.registry.get(sessionId)?.cwd ?? DEFAULT_CWD;
    yield* this.runOpenCodeTurn(sessionId, cwd, undefined, async (client, ocSessionId) => {
      const summarized = await client.session.summarize({ path: { id: ocSessionId } });
      if (summarized.error !== undefined) {
        throw new Error(`OpenCode session.summarize failed: ${JSON.stringify(summarized.error)}`);
      }
    });
  }

  /**
   * Drive one OpenCode turn end to end: resolve the session + its demux key,
   * subscribe a per-turn tap on the ONE shared global event stream, wait for it
   * to be observably live, fire `trigger` (a prompt or a compaction), then yield
   * the mapped events with permission enforcement. {@link mapOpenCodeTurn}
   * guarantees exactly one terminal `done`, and teardown is identity-guarded so a
   * stale turn racing a newer one never clears the newer turn's shared state.
   * Shared by {@link sendMessage} (prompt) and {@link executeCommandIntent}
   * (compact) so both ride the identical trigger → demux → map lifecycle.
   *
   * @param sessionId - DorkOS session id.
   * @param cwd - Working directory used to resolve the client and session.
   * @param title - Optional title used only when a new OpenCode session is created.
   * @param trigger - Fires the turn against the resolved client + `ses_*` id.
   */
  private async *runOpenCodeTurn(
    sessionId: string,
    cwd: string,
    title: string | undefined,
    trigger: (client: OpencodeClient, ocSessionId: string) => Promise<void>
  ): AsyncGenerator<StreamEvent> {
    const ocSessionId = await this.resolveOpenCodeSession(sessionId, cwd, title);
    const client = await this.provider.getClient(cwd);
    // Register the agent's enabled managed MCP servers into the live sidecar for
    // this directory BEFORE the prompt, so their tools are available this turn
    // (spec `mcp-server-management` §6, DOR-893). Ephemeral: the sidecar's
    // `POST /mcp` mutates only its in-memory per-directory registry — no
    // `opencode.json` write — so this never pollutes the user's config.
    await this.mcp.ensureManaged(client, cwd);
    const directory = await this.resolveSessionDirectory(client, ocSessionId);

    const ctx = createOpenCodeEventContext(sessionId);
    const queue = new TurnEventQueue<OpenCodeWireEvent>();
    const subscription = this.hub.subscribe({
      cwd,
      onEvent: (event) => {
        // The turn's own session, plus any child session a `task` tool part has
        // revealed — that is how a subagent's activity reaches its parent card.
        const admit =
          matchesOpenCodeSession(event, directory, ocSessionId) ||
          matchesOpenCodeSubagentSession(event, directory, ctx);
        if (admit) queue.push(event.payload as OpenCodeWireEvent);
      },
      onStreamDrop: (error) => queue.fail(error),
    });

    const turn: ActiveTurn = { ocSessionId, cwd };
    this.activeTurns.set(sessionId, turn);
    try {
      // Trigger only once the stream is observably live (or the bounded wait
      // elapses) — a fast turn must not complete before we can see its idle.
      await Promise.race([subscription.live, delay(STREAM_LIVE_TIMEOUT_MS)]);

      await trigger(client, ocSessionId);

      const routing: ApprovalRouting = { sessionId, ocSessionId, cwd, permissions: ctx };
      for await (const event of mapOpenCodeTurn(queue, ctx)) {
        yield* enforceApprovals(this.approvalGate, routing, event);
      }
    } finally {
      subscription.unsubscribe();
      // Identity guard: only the session's ACTIVE turn may tear down shared
      // per-session state. A stale turn racing a newer one must clear neither
      // the newer turn's record nor its pending approvals — unconditionally
      // clearing would disarm the newer turn's auto-deny timers and dead-end
      // its approveTool() calls.
      if (this.activeTurns.get(sessionId) === turn) {
        this.approvals.clearSession(sessionId);
        this.activeTurns.delete(sessionId);
      }
    }
  }

  /**
   * Effective settings for one turn: per-send override → tracked session →
   * persisted store (hydrated once for untracked sessions, e.g. resume after
   * a server restart) → runtime default.
   */
  private async resolveTurnSettings(
    sessionId: string,
    opts?: MessageOpts
  ): Promise<SessionSettings> {
    if (!this.registry.has(sessionId)) {
      const persisted = await this.settingsPort?.getSessionSettings(sessionId);
      this.registry.register(sessionId, {
        permissionMode: opts?.permissionMode ?? persisted?.permissionMode ?? 'default',
        ...(persisted?.model !== undefined ? { model: persisted.model } : {}),
        ...(persisted?.fastMode !== undefined ? { fastMode: persisted.fastMode } : {}),
        ...(opts?.cwd !== undefined ? { cwd: opts.cwd } : {}),
      });
    }
    const tracked = this.registry.get(sessionId)!;
    const model = opts?.model ?? tracked.model;
    const fastMode = opts?.fastMode ?? tracked.fastMode;
    return {
      // `tracked.permissionMode` reads off the shared `Session` shape, whose
      // field carries any id a runtime declares (DOR-851). Safe to narrow back
      // to `PermissionMode` HERE: opencode only ever writes one of its own
      // enum-shaped ids into this registry, so the wider type never actually
      // holds anything else for this runtime.
      permissionMode: (opts?.permissionMode ?? tracked.permissionMode) as PermissionMode,
      ...(model !== undefined ? { model } : {}),
      ...(fastMode !== undefined ? { fastMode } : {}),
    };
  }

  // --- Interactive flows ---

  /**
   * @inheritdoc
   *
   * Resolves the pending request tracked by the turn stream and forwards the
   * decision as `once`/`reject`. `alwaysAllow` is deliberately ignored:
   * OpenCode's `always` would persist a rule in ITS store and diverge from
   * DorkOS's approval model (NOTES.md §2) — the mapper already advertises
   * `hasSuggestions: false` so the client never offers it.
   *
   * The projector is told directly rather than waiting for the sidecar's
   * `permission.replied` echo. The echo is a courtesy, not a guarantee: if it
   * is dropped (a resubscribed stream, a sidecar restart) the operator's card
   * would hang forever and the session would stay `blocked`, which also holds
   * the write-lock probe the next turn runs. When the echo does arrive it maps
   * to a resolve for an id already gone, which the projector no-ops.
   *
   * `denyReason` is dropped for a structural reason, not an oversight: the
   * sidecar's respond endpoint takes `once`/`reject` and carries no free-text
   * channel, so there is nowhere to put the person's words. What matters is
   * that this path therefore never tells the projector a reason was given, so
   * an OpenCode denial's receipt does not claim the agent was told why —
   * silence here is the honest outcome rather than a lost promise.
   */
  approveTool(
    sessionId: string,
    toolCallId: string,
    approved: boolean,
    options?: ToolDecisionOptions
  ): boolean {
    const pending = this.approvals.take(sessionId, toolCallId);
    if (!pending) return false;
    peekProjector(sessionId)?.resolveInteraction(toolCallId, approved ? 'approved' : 'denied', {
      ...(options?.answeredBy ? { answeredBy: options.answeredBy } : {}),
    });
    void respondPermission(this.provider, pending, toolCallId, approved ? 'once' : 'reject').catch(
      (err: unknown) => logger.warn('[OpenCodeRuntime] permission respond failed', logError(err))
    );
    return true;
  }

  /** OpenCode has no AskUserQuestion-equivalent surface on the v1 API. */
  submitAnswers(): boolean {
    return false;
  }

  /** OpenCode has no MCP elicitation surface DorkOS can answer. */
  submitElicitation(): boolean {
    return false;
  }

  /** OpenCode exposes no addressable background tasks — nothing to stop. */
  async stopTask(): Promise<boolean> {
    return false;
  }

  /**
   * @inheritdoc
   *
   * Aborts the in-flight turn via `POST /session/{id}/abort`. The wire then
   * carries `session.error{MessageAbortedError}` + `session.idle`, which the
   * mapper normalizes to a quiet `done` — user-initiated, not an error.
   */
  async interruptQuery(sessionId: string): Promise<boolean> {
    const turn = this.activeTurns.get(sessionId);
    if (!turn) return false;
    try {
      const client = await this.provider.getClient(turn.cwd);
      const aborted = unwrap(
        await client.session.abort({ path: { id: turn.ocSessionId } }),
        'session.abort'
      );
      logger.debug('[OpenCodeRuntime] interrupted in-flight turn', { sessionId });
      return aborted === true;
    } catch (err) {
      logger.warn('[OpenCodeRuntime] interrupt failed', logError(err));
      return false;
    }
  }

  // --- Session queries (storage) ---

  /**
   * @inheritdoc
   *
   * The sidecar's listing (via the mapper — fast `[]` on a cold sidecar) is
   * the source of truth, unioned with tracked-but-unlisted sessions (created
   * while the sidecar was cold, or still binding). Listed sessions hardcode
   * `permissionMode: 'default'` (OpenCode has no per-session mode), so the
   * DorkOS-tracked settings are overlaid; restart-persisted settings are
   * overlaid one layer up from `session_metadata` (ADR-0260).
   */
  async listSessions(projectDir: string): Promise<Session[]> {
    const listed = await this.mapper.listSessions(projectDir);
    const byId = new Map(listed.map((session) => [session.id, session]));
    for (const tracked of this.registry.list(projectDir)) {
      if (!byId.has(tracked.id)) byId.set(tracked.id, tracked);
    }
    const sessions = [...byId.values()];
    for (const session of sessions) this.overlayTrackedSettings(session);
    return sessions;
  }

  /**
   * @inheritdoc
   *
   * The cheap path reads the sidecar listing + tracked registry. On a miss
   * with a KNOWN durable binding (post-restart, cold sidecar — `listSessions`
   * never boots), falls through to the mapper's targeted single-session read,
   * which boots the sidecar: a bookmarked id must resolve after a restart
   * instead of 404ing until something else warms the sidecar (DOR-251).
   */
  async getSession(projectDir: string, sessionId: string): Promise<Session | null> {
    const sessions = await this.listSessions(projectDir);
    const listed = sessions.find((session) => session.id === sessionId);
    if (listed) return listed;
    const session = await this.mapper.getSession(projectDir, sessionId);
    if (session) this.overlayTrackedSettings(session);
    return session;
  }

  /**
   * @inheritdoc
   *
   * OpenCode's store is durable — history comes from the sidecar through the
   * mapper (booting it when needed), so revisits survive both DorkOS and
   * sidecar restarts. When the sidecar is unreachable (or the session was
   * never bound) this falls back to the DorkOS-owned event stream, read
   * durably from the `session_events` store (DOR-189) so the fallback now
   * survives a DorkOS restart too — the contract ("array, never a throw").
   */
  async getMessageHistory(projectDir: string, sessionId: string): Promise<HistoryMessage[]> {
    try {
      return await this.mapper.getMessageHistory(projectDir, sessionId);
    } catch (err) {
      logger.debug(
        '[OpenCodeRuntime] native history read failed — serving durable EventLog fallback',
        logError(err)
      );
      return readLogBackedHistory(sessionId);
    }
  }

  /**
   * @inheritdoc
   *
   * Completed `messages` load from the durable native store (same source as
   * `getMessageHistory`, with its EventLog fallback); the live turn, status,
   * pending interactions, and cursor come from the projector — the pattern
   * ADR-0263 prescribes for adapters that own a real history source.
   */
  async getSessionSnapshot(ctx: SessionOpts, sessionId: string): Promise<SessionSnapshot> {
    const projector = getOrCreateProjector(sessionId, ctx.cwd, { persist: 'history' });
    return projector.buildSnapshot(() => this.getMessageHistory(ctx.cwd ?? DEFAULT_CWD, sessionId));
  }

  /**
   * @inheritdoc
   *
   * Delegates to the projector's resumable seq'd stream — the SAME projector
   * the trigger path feeds, so `/events` serves an OpenCode turn through
   * exactly the code path the Claude adapter uses.
   */
  subscribeSession(
    ctx: SessionOpts,
    sessionId: string,
    sinceCursor?: number,
    signal?: AbortSignal
  ): AsyncIterable<SessionEvent> {
    return getOrCreateProjector(sessionId, ctx.cwd, { persist: 'history' }).subscribe(
      sinceCursor,
      signal
    );
  }

  /**
   * @inheritdoc
   *
   * Emits the tracked-session inventory then live upserts (create, rename,
   * message activity through DorkOS). Sessions created outside DorkOS (the
   * OpenCode TUI) surface through `listSessions`; watching the sidecar's
   * `session.created/updated` global events for true external discovery is a
   * flagged follow-up. `session_status` liveness fans out runtime-neutrally
   * from the projector via the session-list broadcaster.
   */
  subscribeSessionList(_ctx: SessionOpts): AsyncIterable<SessionListEvent> {
    return this.registry.subscribe();
  }

  /**
   * @inheritdoc
   *
   * Reads the sidecar's own todo store (`GET /session/{id}/todo` — the same
   * Todo shape `todo.updated` streams). Peek-only: a cold sidecar has no live
   * session whose tasks could be non-empty.
   */
  async getSessionTasks(_projectDir: string, sessionId: string): Promise<TaskItem[]> {
    const ocSessionId = this.mapper.getOpenCodeSessionId(sessionId);
    const client = this.provider.peekClient();
    if (!ocSessionId || !client) return [];
    try {
      const todos = unwrap(
        await client.session.todo({ path: { id: ocSessionId } }),
        'session.todo'
      );
      return mapOpenCodeTodos(todos);
    } catch (err) {
      logger.debug('[OpenCodeRuntime] todo read failed', logError(err));
      return [];
    }
  }

  async getSessionETag(): Promise<string | null> {
    return null;
  }

  async getLastMessageIds(): Promise<{ user: string; assistant: string } | null> {
    return null;
  }

  /** No byte-addressable transcript exists — OpenCode's store is opaque (ADR-0308). */
  async readFromOffset(): Promise<{ content: string; newOffset: number }> {
    return { content: '', newOffset: 0 };
  }

  // --- Session locking ---

  acquireLock(sessionId: string, clientId: string, res: SseResponse, token?: symbol): boolean {
    return this.locks.acquireLock(sessionId, clientId, res, token);
  }

  releaseLock(sessionId: string, clientId: string, token?: symbol): void {
    this.locks.releaseLock(sessionId, clientId, token);
  }

  isLocked(sessionId: string, clientId?: string): boolean {
    return this.locks.isLocked(sessionId, clientId);
  }

  getLockInfo(sessionId: string): { clientId: string; acquiredAt: number } | null {
    return this.locks.getLockInfo(sessionId);
  }

  // --- Capabilities ---

  /**
   * @inheritdoc
   *
   * Live from the sidecar's provider catalog — the open-source-model surface
   * (Anthropic/OpenAI/Ollama/OpenAI-compatible endpoints, whatever the user
   * configured). Boots the sidecar when needed; an unreachable sidecar yields
   * an empty picker rather than an error.
   */
  async getSupportedModels(): Promise<ModelOption[]> {
    try {
      const client = await this.provider.getClient(DEFAULT_CWD);
      const listed = unwrap(await client.provider.list(), 'provider.list');
      const installedOllamaTags = await this.resolveInstalledOllamaTags(listed);
      return projectModelOptions(listed, { installedOllamaTags });
    } catch (err) {
      logger.warn('[OpenCodeRuntime] provider catalog unavailable', logError(err));
      return [];
    }
  }

  /**
   * Installed Ollama tags for the honest-local-availability filter (spec §10),
   * or `null` to skip filtering. Probes Ollama's `/api/tags` only when the
   * catalog actually exposes the ollama provider; an unreachable Ollama
   * (`running: false`) returns `null` so the menu degrades to the full catalog
   * rather than emptying. A reachable Ollama returns its installed tag names
   * (possibly empty — honestly no local models installed yet).
   */
  private async resolveInstalledOllamaTags(
    payload: ProviderListResponse
  ): Promise<string[] | null> {
    const OLLAMA_PROVIDER_ID = 'ollama';
    if (!payload.all.some((entry) => entry.id === OLLAMA_PROVIDER_ID)) return null;
    const status = await detectOllama();
    if (!status.running) return null;
    return status.models.map((tag) => tag.name);
  }

  /**
   * @inheritdoc
   *
   * OpenCode's auth is provider-agnostic — the connected source is DorkOS's
   * persisted `runtimes.opencode.provider`. Surfaced so the client can label a
   * "Change power source" affordance with the current source. `null` when the
   * runtime was authenticated outside DorkOS (e.g. the OpenCode CLI logged in
   * directly), so there is no DorkOS provider to switch.
   */
  getConnectedProvider(): string | null {
    return getConnectedOpenCodeProvider();
  }

  /** OpenCode agents are prompt-scoped, not a DorkOS-dispatchable subagent registry. */
  async getSupportedSubagents(): Promise<SubagentInfo[]> {
    return [];
  }

  getCapabilities(): RuntimeCapabilities {
    return OPENCODE_CAPABILITIES;
  }

  async checkDependencies(): Promise<DependencyCheck[]> {
    return checkOpenCodeDependencies();
  }

  // --- Commands ---

  /** OpenCode exposes no DorkOS-invocable slash commands. */
  async getCommands(): Promise<CommandRegistry> {
    return { commands: [], lastScanned: new Date().toISOString() };
  }

  // --- MCP (read-only status + managed injection, delegated to OpenCodeMcpManager) ---

  /**
   * @inheritdoc
   *
   * Surfaces the MCP servers OpenCode loaded for a directory from its OWN config
   * (the merged global + per-project `opencode.json` `mcp` map), read-only:
   * `supportsMcp` stays false, so these render as discovered, non-editable rows
   * in the profile's Tools & MCP roster. Delegated to {@link OpenCodeMcpManager}, which warms
   * a per-cwd cache out-of-band and peek-only (never boots the sidecar just to
   * populate a read-only roster).
   */
  getMcpStatus(cwd: string): McpServerEntry[] | null {
    return this.mcp.getStatus(cwd);
  }

  // --- Lifecycle ---

  /**
   * No-op: there are no per-session processes to evict — session lifetime
   * belongs to the sidecar, whose process health the server-manager owns.
   */
  checkSessionHealth(): void {}

  /**
   * Always `undefined`: the DorkOS session id IS the canonical id for
   * OpenCode sessions (the mapper keeps the `ses_*` id adapter-internal).
   * Returning the OpenCode id here would trip trigger-turn's C1 rekey and
   * re-key the projector — and the 202's canonical id — to the OpenCode id,
   * orphaning the client's subscription (same reasoning as Codex).
   */
  getInternalSessionId(_sessionId: string): string | undefined {
    return undefined;
  }

  // --- Dependency injection ---

  /** Inject the core session-settings store for durable hydrate/write-through (ADR-0260). */
  setSessionSettings(port: SessionSettingsPort): void {
    this.settingsPort = port;
  }

  /**
   * Accept the managed-MCP-server resolver so a turn can register the agent's
   * enabled managed servers into the live sidecar (DOR-892 seam; the injection
   * runs per turn via {@link OpenCodeMcpManager.ensureManaged}). The composition
   * root calls this on every runtime that implements it; gated by
   * `supportsManagedMcpServers: true`.
   *
   * @param resolver - The managed-server resolver from the composition root.
   */
  setManagedMcpServers(resolver: ManagedMcpServerResolver): void {
    this.mcp.setResolver(resolver);
  }

  // --- Internals ---

  /**
   * The OpenCode session bound to a DorkOS session, creating one when needed.
   * Concurrent callers (an eager `ensureSession` bind racing the first
   * `sendMessage`) share one in-flight creation, so a session can never bind
   * to two OpenCode sessions.
   */
  private resolveOpenCodeSession(sessionId: string, cwd: string, title?: string): Promise<string> {
    const existing = this.mapper.getOpenCodeSessionId(sessionId);
    if (existing !== undefined) return Promise.resolve(existing);
    const inflight = this.binding.get(sessionId);
    if (inflight) return inflight;
    const creating = this.mapper
      .ensureSession(sessionId, { cwd, ...(title !== undefined ? { title } : {}) })
      .finally(() => {
        if (this.binding.get(sessionId) === creating) this.binding.delete(sessionId);
      });
    this.binding.set(sessionId, creating);
    return creating;
  }

  /**
   * The directory AS STORED BY OPENCODE for a session — the demux key half
   * that must never be substituted with the DorkOS cwd (strict string
   * equality; trailing-slash or symlink drift would silently drop every
   * event). Read once via `session.get` and cached; failure is loud — a turn
   * without a trustworthy demux key must not run.
   */
  private async resolveSessionDirectory(
    client: OpencodeClient,
    ocSessionId: string
  ): Promise<string> {
    const cached = this.directoryByOcId.get(ocSessionId);
    if (cached !== undefined) return cached;
    const session = unwrap(await client.session.get({ path: { id: ocSessionId } }), 'session.get');
    this.directoryByOcId.set(ocSessionId, session.directory);
    return session.directory;
  }

  /**
   * Overlay DorkOS-tracked settings onto a listed session — OpenCode has no
   * per-session permission mode, so the mapper hardcodes `'default'` and the
   * tracked value (kept current by `updateSession`) wins.
   */
  private overlayTrackedSettings(session: Session): void {
    const tracked = this.registry.get(session.id);
    if (!tracked) return;
    session.permissionMode = tracked.permissionMode;
    if (tracked.model !== undefined) session.model = tracked.model;
    if (tracked.fastMode !== undefined) session.fastMode = tracked.fastMode;
  }
}
