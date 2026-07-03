/**
 * Codex Runtime — implements the AgentRuntime interface for OpenAI Codex.
 *
 * One DorkOS session maps to one Codex thread (ADR-0307), bound durably via
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
 * comes from the in-memory {@link CodexSessionRegistry}: sessions are visible
 * for the server's lifetime, resume survives restarts via the thread map, but
 * a restarted server does not rediscover past Codex sessions — a documented
 * limitation of the SDK surface, not a shortcut.
 *
 * Tool approvals are structurally unsupported (`supportsToolApproval: false`):
 * `codex exec` closes stdin after the prompt and auto-cancels approval-needing
 * calls (NOTES.md Verdict 1), so `approveTool` honestly reports `false`.
 *
 * @module services/runtimes/codex/codex-runtime
 */
import { Codex } from '@openai/codex-sdk';
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
import { getOrCreateProjector, peekProjector } from '../../session/session-state-projector.js';
import { reconstructHistoryFromEvents } from '../../session/event-log-history.js';
import { SessionLockManager } from '../../session/session-lock.js';
import { logger } from '../../../lib/logger.js';
import { checkCodexDependencies } from './check-dependencies.js';
import { createCodexEventContext, mapCodexThread } from './event-mapper.js';
import { CodexSessionRegistry } from './session-registry.js';
import { CodexThreadMap } from './thread-map.js';
import { CODEX_CAPABILITIES, CODEX_MODELS } from './runtime-constants.js';
import { buildCodexPrompt, projectThreadOptions } from './turn-input.js';

/** Constructor dependencies for {@link CodexRuntime} (composition root). */
export interface CodexRuntimeOptions {
  /** Durable sessionId ↔ threadId binding (backed by the `codex_threads` table). */
  threadMap: CodexThreadMap;
  /**
   * Absolute path to the `codex` binary (`runtimes.codex.binaryPath` config).
   * `null`/omitted lets the SDK resolve its own vendored binary.
   */
  binaryPath?: string | null;
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

  constructor(options: CodexRuntimeOptions) {
    this.threadMap = options.threadMap;
    // NEVER set CodexOptions.env: when provided the subprocess does NOT
    // inherit process.env (PATH/HOME/CODEX_HOME would all vanish). Omitting
    // it inherits everything — NOTES.md §Additional live-verified facts.
    this.codex = new Codex(options.binaryPath ? { codexPathOverride: options.binaryPath } : {});
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
   * tracked-session metadata (server lifetime).
   */
  async renameSession(sessionId: string, title: string): Promise<void> {
    this.registry.rename(sessionId, title);
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

    const boundThreadId = this.threadMap.getThreadId(sessionId);
    const cwd = opts?.cwd ?? this.registry.get(sessionId)?.cwd;
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
        // turn stays resumable. First-write-wins keeps re-binds benign.
        if (!bound && ctx.threadId !== undefined) {
          this.threadMap.setThreadId(sessionId, ctx.threadId);
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

  /** Codex exposes no DorkOS-invocable slash commands. */
  async getCommands(): Promise<CommandRegistry> {
    return { commands: [], lastScanned: new Date().toISOString() };
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
   * ADR-0307). Returning the thread id here would trip trigger-turn's C1
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
