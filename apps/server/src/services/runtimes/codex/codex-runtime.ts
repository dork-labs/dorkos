/**
 * Codex Runtime — implements the AgentRuntime interface for OpenAI Codex.
 *
 * One DorkOS session maps to one Codex thread (ADR-0309), bound durably via
 * {@link CodexThreadMap}. Each turn spawns a fresh `codex exec` subprocess
 * through the SDK: an unbound session starts a new thread, a bound one
 * resumes it — both with EXPLICIT sandbox/approval options projected from the
 * session's permission mode ({@link projectThreadOptions}).
 *
 * Live turn state follows the test-mode pattern: `sendMessage` is a pure
 * StreamEvent producer (the platform's trigger-turn consumes it into the
 * per-session {@link SessionStateProjector}), and `subscribeSession` /
 * `getSessionSnapshot` / `getMessageHistory` are served from that projector's
 * DorkOS-owned EventLog. The Codex SDK exposes NO thread listing or reading
 * API (`Codex` is exactly `startThread`/`resumeThread`), so session discovery
 * comes from the in-memory {@link CodexSessionRegistry}, and restart survival
 * comes from DorkOS itself: display metadata (title/preview/updatedAt) is
 * written through to the `codex_threads` rows alongside the durable
 * sessionId↔threadId binding, and {@link CodexRuntime.hydrateSessions}
 * re-seeds the registry from those rows at startup. Sessions that never bound
 * a thread (no completed `thread.started`) have no durable row and are not
 * rediscovered — a documented limitation of the SDK surface, not a shortcut.
 *
 * Tool approvals are structurally unsupported (`supportsToolApproval: false`):
 * `codex exec` closes stdin after the prompt and auto-cancels approval-needing
 * calls (NOTES.md Verdict 1), so `approveTool` honestly reports `false`.
 *
 * @module services/runtimes/codex/codex-runtime
 */
import { Codex, type CodexOptions } from '@openai/codex-sdk';
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
  SseResponse,
  SessionSettingsPort,
} from '@dorkos/shared/agent-runtime';
import type {
  SessionSnapshot,
  SessionEvent,
  SessionListEvent,
} from '@dorkos/shared/session-stream';
import type { McpServerEntry } from '@dorkos/shared/transport';
import { getOrCreateProjector, peekProjector } from '../../session/session-state-projector.js';
import { reconstructHistoryFromEvents } from '../../session/event-log-history.js';
import { SessionLockManager } from '../../session/session-lock.js';
import { logger } from '../../../lib/logger.js';
import { checkCodexDependencies } from './check-dependencies.js';
import { createCodexEventContext, mapCodexThread } from './event-mapper.js';
import { CodexSessionRegistry } from './session-registry.js';
import { CodexThreadMap, type CodexThreadMetadataPatch } from './thread-map.js';
import { CODEX_CAPABILITIES, CODEX_MODELS } from './runtime-constants.js';
import { CODEX_UI_MCP_SERVER } from './codex-ui-mcp-server.js';
import { buildCodexPrompt, projectThreadOptions } from './turn-input.js';
import { enumerateCodexMcpServers } from './enumerate-mcp-servers.js';
import { scanSkillCommands } from './scan-skill-commands.js';

/**
 * How long a warmed Codex MCP-status cache stays fresh before {@link CodexRuntime.getMcpStatus}
 * kicks a background re-warm. Codex MCP config changes out-of-band (`codex mcp
 * add/remove`), so a lifetime cache would never reflect edits without a server
 * restart; a short TTL surfaces them on the next poll while keeping the getter
 * synchronous.
 */
const MCP_STATUS_TTL_MS = 60_000;

/** Constructor dependencies for {@link CodexRuntime} (composition root). */
export interface CodexRuntimeOptions {
  /** Durable sessionId ↔ threadId binding (backed by the `codex_threads` table). */
  threadMap: CodexThreadMap;
  /**
   * Absolute path to the `codex` binary (`runtimes.codex.binaryPath` config).
   * `null`/omitted lets the SDK resolve its own vendored binary.
   */
  binaryPath?: string | null;
  /**
   * Loopback URL of the scoped `dorkos_ui` MCP server
   * ({@link ./codex-ui-mcp-server}) that exposes `control_ui` to Codex for
   * canvas parity. Wired into `CodexOptions.config.mcp_servers` when present.
   * Derived from the server port in the composition root — not user config.
   */
  mcpUiUrl?: string;
}

/**
 * Build the {@link CodexOptions} for the SDK `Codex` client.
 *
 * `codexPathOverride` is set only when a binary path is configured (otherwise
 * the SDK resolves its own vendored binary). `config.mcp_servers.dorkos_ui` is
 * added only when a UI MCP URL is provided, registering the scoped
 * `control_ui` server so Codex agents can open the canvas. `env` is
 * deliberately NEVER set — see the constructor note.
 *
 * @param binaryPath - Absolute path to the `codex` binary, or null/undefined
 * @param mcpUiUrl - Loopback URL of the scoped `dorkos_ui` MCP server, or undefined
 */
export function buildCodexOptions(binaryPath?: string | null, mcpUiUrl?: string): CodexOptions {
  return {
    ...(binaryPath ? { codexPathOverride: binaryPath } : {}),
    ...(mcpUiUrl ? { config: { mcp_servers: { [CODEX_UI_MCP_SERVER]: { url: mcpUiUrl } } } } : {}),
  };
}

/**
 * Codex runtime implementing the universal AgentRuntime interface.
 */
export class CodexRuntime implements AgentRuntime {
  readonly type = 'codex' as const;

  private readonly codex: Codex;
  private readonly threadMap: CodexThreadMap;
  private readonly registry = new CodexSessionRegistry();
  private readonly locks = new SessionLockManager();
  /** One AbortController per in-flight turn (NOTES.md Verdict 3). */
  private readonly activeTurns = new Map<string, AbortController>();
  private settingsPort: SessionSettingsPort | undefined;
  /**
   * Last enumerated Codex MCP servers, or `null` until the first successful
   * enumeration. `getMcpStatus` is synchronous (the interface contract), so the
   * async `codex mcp list` probe warms this cache lazily and out-of-band.
   */
  private mcpStatusCache: McpServerEntry[] | null = null;
  /** In-flight MCP warm, so concurrent `getMcpStatus` calls trigger at most one probe. */
  private mcpWarmPromise: Promise<void> | null = null;
  /**
   * Wall-clock ms of the last successful warm, or `null` until the first
   * success. Drives the {@link MCP_STATUS_TTL_MS} re-warm so config edits made
   * via `codex mcp add/remove` surface without a server restart.
   */
  private mcpStatusWarmedAt: number | null = null;

  constructor(options: CodexRuntimeOptions) {
    this.threadMap = options.threadMap;
    // NEVER set CodexOptions.env: when provided the subprocess does NOT
    // inherit process.env (PATH/HOME/CODEX_HOME would all vanish). Omitting
    // it inherits everything — NOTES.md §Additional live-verified facts.
    this.codex = new Codex(buildCodexOptions(options.binaryPath, options.mcpUiUrl));
  }

  // --- Session lifecycle ---

  ensureSession(sessionId: string, opts: SessionOpts): void {
    this.registry.register(sessionId, {
      permissionMode: opts.permissionMode,
      ...(opts.model !== undefined ? { model: opts.model } : {}),
      ...(opts.effort !== undefined ? { effort: opts.effort } : {}),
      ...(opts.fastMode !== undefined ? { fastMode: opts.fastMode } : {}),
      ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
    });
    // Pre-warm the MCP-status cache the first time Codex is actually used, so
    // the Agent Profile MCP list is usually populated before the UI's first
    // (synchronous) `getMcpStatus` call instead of empty until a later refetch.
    this.maybeWarmMcpStatus();
  }

  hasSession(sessionId: string): boolean {
    return this.registry.has(sessionId);
  }

  /** Codex has no fork surface — a thread can only be resumed, not branched. */
  async forkSession(): Promise<Session | null> {
    return null;
  }

  /**
   * @inheritdoc
   *
   * Auto-creates untracked sessions (the PATCH-before-first-message path) and
   * writes the operator's choice through the durable settings store first
   * (ADR-0260) so it survives restarts; the new mode/model applies on the
   * next turn's ThreadOptions projection.
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
    await this.settingsPort?.saveSessionSettings(sessionId, opts);
    this.registry.register(sessionId, {
      ...(opts.permissionMode !== undefined ? { permissionMode: opts.permissionMode } : {}),
      ...(opts.model !== undefined ? { model: opts.model } : {}),
      ...(opts.effort !== undefined ? { effort: opts.effort } : {}),
      ...(opts.fastMode !== undefined ? { fastMode: opts.fastMode } : {}),
    });
    return true;
  }

  /**
   * Codex has no writable native session store, so the title lives in the
   * tracked-session metadata and is written through to the session's durable
   * `codex_threads` row (when one exists) so it survives a server restart.
   */
  async renameSession(sessionId: string, title: string): Promise<void> {
    this.registry.rename(sessionId, title);
    this.persistSessionMetadata(sessionId);
  }

  /**
   * Re-seed the in-memory session registry from the durable `codex_threads`
   * rows (title/preview/cwd written through by past turns), joining each
   * session's persisted settings (permissionMode/model/effort/fastMode) from
   * the core settings store (ADR-0260) where available.
   *
   * Idempotent: {@link CodexSessionRegistry.hydrate} inserts only untracked
   * ids, so fresher in-memory state is never clobbered and repeat calls are
   * no-ops. The composition root calls this fire-and-forget after
   * `setSessionSettings` — restart survival must not delay server listen, and
   * the registry's per-session upserts let live list subscribers self-heal
   * even when hydration completes after the broadcaster subscribed.
   */
  async hydrateSessions(): Promise<void> {
    const sessions: Session[] = [];
    for (const record of this.threadMap.listAll()) {
      let settings: SessionSettings | null = null;
      try {
        settings = (await this.settingsPort?.getSessionSettings(record.sessionId)) ?? null;
      } catch (err) {
        // Degrade to defaults rather than dropping the session: the metadata
        // row alone is enough to put it back on the list.
        logger.warn('[CodexRuntime] settings join failed during hydration; using defaults', {
          sessionId: record.sessionId,
          err,
        });
      }
      sessions.push({
        id: record.sessionId,
        title: record.title ?? '',
        createdAt: record.createdAt,
        updatedAt: record.updatedAt ?? record.createdAt,
        permissionMode: settings?.permissionMode ?? 'default',
        runtime: 'codex',
        ...(record.lastMessagePreview !== undefined
          ? { lastMessagePreview: record.lastMessagePreview }
          : {}),
        ...(record.cwd !== undefined ? { cwd: record.cwd } : {}),
        ...(settings?.model !== undefined ? { model: settings.model } : {}),
        ...(settings?.effort !== undefined ? { effort: settings.effort } : {}),
        ...(settings?.fastMode !== undefined ? { fastMode: settings.fastMode } : {}),
      });
    }
    this.registry.hydrate(sessions);
  }

  // --- Messaging ---

  /**
   * @inheritdoc
   *
   * Resolves the thread (resume when bound, start otherwise), runs one
   * `codex exec` turn, and yields the mapped StreamEvents. The event mapper
   * guarantees exactly one terminal `done` on every path — completion,
   * failure, abort (a fired `TurnOptions.signal` makes the SDK generator
   * throw AbortError, normalized to a quiet `done`), and crash — so no
   * additional done-guard is layered here.
   */
  async *sendMessage(
    sessionId: string,
    content: string,
    opts?: MessageOpts
  ): AsyncGenerator<StreamEvent> {
    const settings = await this.resolveTurnSettings(sessionId, opts);
    this.registry.recordMessage(sessionId, content, {
      ...(opts?.cwd !== undefined ? { cwd: opts.cwd } : {}),
      ...(opts?.title !== undefined ? { title: opts.title } : {}),
    });
    // Write the refreshed preview/updatedAt (and first-turn title) through to
    // the durable row. A no-op before the first bind — the setThreadId below
    // carries the first turn's metadata with the row instead.
    this.persistSessionMetadata(sessionId);

    const binding = this.threadMap.get(sessionId);
    const boundThreadId = binding?.threadId;
    // Resolution order (post-restart safe): per-send override → in-memory
    // registry → the persisted binding's cwd. The registry is empty after a
    // restart, so the persisted cwd is what keeps `codex exec` in the right dir.
    const cwd = opts?.cwd ?? this.registry.get(sessionId)?.cwd ?? binding?.cwd;
    const threadOptions = projectThreadOptions(settings, cwd);
    const thread =
      boundThreadId !== undefined
        ? this.codex.resumeThread(boundThreadId, threadOptions)
        : this.codex.startThread(threadOptions);

    const controller = new AbortController();
    this.activeTurns.set(sessionId, controller);
    const ctx = createCodexEventContext(sessionId);
    let bound = boundThreadId !== undefined;
    try {
      const { events } = await thread.runStreamed(buildCodexPrompt(content, opts), {
        signal: controller.signal,
      });
      for await (const event of mapCodexThread(events, ctx)) {
        // Persist the binding the moment thread.started reveals the id —
        // before the terminal done — so even an interrupted or crashed first
        // turn stays resumable. The cwd is persisted with it so a post-restart
        // resume runs in the right dir, and the registry's current display
        // metadata rides along so the first turn's title/preview land with the
        // row. First-write-wins keeps re-binds benign.
        if (!bound && ctx.threadId !== undefined) {
          const tracked = this.registry.get(sessionId);
          this.threadMap.setThreadId(
            sessionId,
            ctx.threadId,
            cwd,
            tracked ? this.toMetadataPatch(tracked) : undefined
          );
          bound = true;
        }
        yield event;
      }
    } finally {
      // Guard against clearing a NEWER turn's controller: this turn's entry
      // may already have been replaced if a second send raced in.
      if (this.activeTurns.get(sessionId) === controller) {
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
        ...(persisted?.effort !== undefined ? { effort: persisted.effort } : {}),
        ...(persisted?.fastMode !== undefined ? { fastMode: persisted.fastMode } : {}),
        ...(opts?.cwd !== undefined ? { cwd: opts.cwd } : {}),
      });
    }
    const tracked = this.registry.get(sessionId)!;
    const model = opts?.model ?? tracked.model;
    const effort = opts?.effort ?? tracked.effort;
    const fastMode = opts?.fastMode ?? tracked.fastMode;
    return {
      permissionMode: opts?.permissionMode ?? tracked.permissionMode,
      ...(model !== undefined ? { model } : {}),
      ...(effort !== undefined ? { effort } : {}),
      ...(fastMode !== undefined ? { fastMode } : {}),
    };
  }

  /**
   * Project a tracked session's display metadata into the thread map's patch
   * shape. An unset title (the registry's `''` default) is omitted so a blank
   * never overwrites a previously persisted title (or lands as `''` in a
   * fresh row — NULL hydrates back to the same blank default).
   */
  private toMetadataPatch(session: Session): CodexThreadMetadataPatch {
    return {
      ...(session.title !== '' ? { title: session.title } : {}),
      updatedAt: session.updatedAt,
      ...(session.lastMessagePreview !== undefined
        ? { lastMessagePreview: session.lastMessagePreview }
        : {}),
    };
  }

  /**
   * Write the registry's current title/updatedAt/preview through to the
   * session's durable `codex_threads` row. A no-op until `thread.started`
   * binds the row. Failures are logged, never thrown — durable metadata is
   * best-effort and the in-memory registry already holds the fresh state.
   */
  private persistSessionMetadata(sessionId: string): void {
    const tracked = this.registry.get(sessionId);
    if (!tracked) return;
    try {
      this.threadMap.updateMetadata(sessionId, this.toMetadataPatch(tracked));
    } catch (err) {
      logger.warn('[CodexRuntime] failed to persist session metadata', { sessionId, err });
    }
  }

  // --- Interactive flows (structurally unsupported — NOTES.md Verdict 1) ---

  /**
   * Codex exec mode has no approval channel, so no pending approval can ever
   * exist to act on — `false` is the honest contract answer, and the approval
   * UI is already gated off via `supportsToolApproval: false`.
   */
  approveTool(): boolean {
    return false;
  }

  submitAnswers(): boolean {
    return false;
  }

  submitElicitation(): boolean {
    return false;
  }

  /** Codex has no addressable background tasks — nothing to stop. */
  async stopTask(): Promise<boolean> {
    return false;
  }

  /**
   * @inheritdoc
   *
   * Aborts the in-flight turn's AbortController, which SIGTERMs the per-turn
   * `codex exec` subprocess (the SDK's only interrupt primitive). The events
   * generator then throws AbortError, which the mapper normalizes to a quiet
   * `done` — user-initiated, not an error.
   */
  async interruptQuery(sessionId: string): Promise<boolean> {
    const controller = this.activeTurns.get(sessionId);
    if (!controller) return false;
    this.activeTurns.delete(sessionId);
    controller.abort();
    logger.debug('[CodexRuntime] interrupted in-flight turn', { sessionId });
    return true;
  }

  // --- Session queries (storage) ---

  async listSessions(projectDir: string): Promise<Session[]> {
    return this.registry.list(projectDir);
  }

  async getSession(_projectDir: string, sessionId: string): Promise<Session | null> {
    return this.registry.get(sessionId);
  }

  /**
   * Completed messages reconstructed from the DorkOS-owned EventLog — the
   * SDK has no thread-read API, so the projector is the only history source.
   * `peekProjector` (not get-or-create): an id that never streamed has no
   * history, and minting a projector for it would pin registry garbage.
   */
  async getMessageHistory(_projectDir: string, sessionId: string): Promise<HistoryMessage[]> {
    const projector = peekProjector(sessionId);
    return projector ? reconstructHistoryFromEvents(projector.replayFrom(0)) : [];
  }

  /**
   * @inheritdoc
   *
   * Built entirely from the DorkOS-owned projection: completed `messages` are
   * reconstructed from the EventLog, and the live turn/status/pending/cursor
   * come from the same projector — the exact test-mode pattern (ADR-0263).
   */
  async getSessionSnapshot(ctx: SessionOpts, sessionId: string): Promise<SessionSnapshot> {
    const projector = getOrCreateProjector(sessionId, ctx.cwd);
    return projector.buildSnapshot(() =>
      Promise.resolve(reconstructHistoryFromEvents(projector.replayFrom(0)))
    );
  }

  /**
   * @inheritdoc
   *
   * Delegates to the projector's resumable seq'd stream — the SAME projector
   * the trigger path feeds, so `/events` serves a Codex turn through exactly
   * the code path the Claude adapter uses.
   */
  subscribeSession(
    ctx: SessionOpts,
    sessionId: string,
    sinceCursor?: number,
    signal?: AbortSignal
  ): AsyncIterable<SessionEvent> {
    return getOrCreateProjector(sessionId, ctx.cwd).subscribe(sinceCursor, signal);
  }

  /**
   * @inheritdoc
   *
   * Emits the tracked-session inventory then live upserts. Discovery is
   * bounded by what this server observed (the SDK exposes no thread listing);
   * `session_status` liveness fans out runtime-neutrally from the projector
   * via the session-list broadcaster, same as every runtime.
   */
  subscribeSessionList(_ctx: SessionOpts): AsyncIterable<SessionListEvent> {
    return this.registry.subscribe();
  }

  /** Todo state streams live as task_update events; Codex persists no task store. */
  async getSessionTasks(): Promise<TaskItem[]> {
    return [];
  }

  async getSessionETag(): Promise<string | null> {
    return null;
  }

  async getLastMessageIds(): Promise<{ user: string; assistant: string } | null> {
    return null;
  }

  /** No byte-addressable transcript exists — rollout files are SDK-internal. */
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

  async getSupportedModels(): Promise<ModelOption[]> {
    return CODEX_MODELS;
  }

  /** Codex exposes no subagent registry. */
  async getSupportedSubagents(): Promise<SubagentInfo[]> {
    return [];
  }

  getCapabilities(): RuntimeCapabilities {
    return CODEX_CAPABILITIES;
  }

  async checkDependencies(): Promise<DependencyCheck[]> {
    return checkCodexDependencies();
  }

  // --- Commands ---

  /**
   * @inheritdoc
   *
   * Codex's built-in TUI commands can't run under `codex exec` and the SDK has
   * no command-discovery API, so instead of faking them this surfaces the
   * project's authored skills (`<cwd>/.agents/skills`) as `/<name>` slash
   * commands — the same skills Claude's SDK exposes from `.claude/skills`. With
   * no `cwd` (cold discovery, no session context) there is no project to scan,
   * so the palette is empty.
   */
  async getCommands(_forceRefresh?: boolean, cwd?: string): Promise<CommandRegistry> {
    const commands = cwd ? scanSkillCommands(cwd) : [];
    return { commands, lastScanned: new Date().toISOString() };
  }

  // --- MCP ---

  /**
   * @inheritdoc
   *
   * Surfaces the MCP servers Codex loads from its own config
   * (`$CODEX_HOME/config.toml`), enumerated via `codex mcp list --json`. The
   * interface is synchronous, so the async CLI probe warms {@link mcpStatusCache}
   * out-of-band and this returns the last-known list (`null` until the first
   * successful enumeration — "not yet available"). Codex sessions pre-warm the
   * cache on {@link ensureSession}, so it is usually populated by the first call.
   * A stale cache (older than {@link MCP_STATUS_TTL_MS}) triggers a background
   * re-warm and returns the current value immediately. `cwd` is ignored: Codex
   * MCP config is user-global, not per-project.
   */
  getMcpStatus(_cwd: string): McpServerEntry[] | null {
    this.maybeWarmMcpStatus();
    return this.mcpStatusCache;
  }

  /**
   * Kick a background MCP-status warm when one is warranted: never warmed yet,
   * or last warmed longer than {@link MCP_STATUS_TTL_MS} ago. A warm already in
   * flight ({@link mcpWarmPromise}) dedupes so at most one `codex mcp list`
   * probe runs at a time. Fire-and-forget — callers stay synchronous and read
   * the last-known cache.
   */
  private maybeWarmMcpStatus(): void {
    if (this.mcpWarmPromise !== null) return;
    const isFresh =
      this.mcpStatusWarmedAt !== null && Date.now() - this.mcpStatusWarmedAt < MCP_STATUS_TTL_MS;
    if (isFresh) return;
    this.mcpWarmPromise = this.warmMcpStatus();
  }

  /**
   * Warm {@link mcpStatusCache} from `codex mcp list --json`. A genuine
   * enumeration failure (returns `null`) leaves the cache cold and unstamped so
   * the next `getMcpStatus` retries immediately; success (including an empty
   * list) caches the result and stamps {@link mcpStatusWarmedAt} to start the TTL.
   */
  private async warmMcpStatus(): Promise<void> {
    try {
      const servers = await enumerateCodexMcpServers();
      if (servers !== null) {
        this.mcpStatusCache = servers;
        this.mcpStatusWarmedAt = Date.now();
      }
    } finally {
      this.mcpWarmPromise = null;
    }
  }

  // --- Lifecycle ---

  /**
   * No-op: there are no long-lived per-session processes to evict — each turn
   * is a fresh `codex exec` subprocess that exits with the turn.
   */
  checkSessionHealth(): void {}

  /**
   * Always `undefined`: the DorkOS session id IS the canonical id for Codex
   * sessions (the thread map keeps the SDK thread id adapter-internal,
   * ADR-0309). Returning the thread id here would trip trigger-turn's C1
   * rekey and re-key the projector — and the 202's canonical id — to the
   * Codex thread id, orphaning the client's subscription.
   */
  getInternalSessionId(_sessionId: string): string | undefined {
    return undefined;
  }

  // --- Dependency injection ---

  /** Inject the core session-settings store for durable hydrate/write-through (ADR-0260). */
  setSessionSettings(port: SessionSettingsPort): void {
    this.settingsPort = port;
  }
}
