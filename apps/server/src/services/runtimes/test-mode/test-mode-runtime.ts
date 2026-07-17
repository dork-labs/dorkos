import type {
  AgentRuntime,
  DependencyCheck,
  RuntimeCapabilities,
  SessionOpts,
  MessageOpts,
  SseResponse,
} from '@dorkos/shared/agent-runtime';
import type {
  StreamEvent,
  Session,
  HistoryMessage,
  TaskItem,
  ModelOption,
  CommandRegistry,
  PermissionMode,
  EffortLevel,
} from '@dorkos/shared/types';
import type {
  SessionSnapshot,
  SessionEvent,
  SessionListEvent,
} from '@dorkos/shared/session-stream';
import type { RuntimeCommandIntentId } from '@dorkos/shared/command-intents';
import type { RelayCore } from '@dorkos/relay';
import { disposeProjector, getOrCreateProjector } from '../../session/session-state-projector.js';
import { reconstructHistoryFromEvents } from '../../session/event-log-history.js';
import { readLogBackedHistory } from '../../session/log-backed-history.js';
import { scenarioStore } from './scenario-store.js';
import { TestModeSessionRegistry } from './session-registry.js';
import { TEST_MODE_CAPABILITIES } from './runtime-constants.js';

/**
 * A zero-latency, STATELESS AgentRuntime that yields StreamEvents from the
 * scenario store and persists NOTHING natively: completed history is
 * reconstructed from the DorkOS-owned EventLog (via the session projector),
 * live events come from the projector's seq'd stream, and session discovery
 * comes from an in-memory tracked set with no filesystem watch. This is the
 * end-to-end proof that the snapshot/subscribe/list contract has no baked-in
 * JSONL/file assumptions (spec chat-stream-reconnection task #15, ADR-0263
 * Decision 1). Registered instead of ClaudeCodeRuntime when
 * DORKOS_TEST_RUNTIME=true.
 *
 * Never imported in production — index.ts only imports this module when the
 * env var is set. There is no tree-shaking concern because the condition is
 * evaluated at server startup, not at build time.
 */
export class TestModeRuntime implements AgentRuntime {
  readonly type: string;

  private readonly registry: TestModeSessionRegistry;
  private readonly capabilities: RuntimeCapabilities;

  /**
   * Create a test-mode runtime instance registered under `type`.
   *
   * @param type - Runtime type identifier this instance registers under.
   *   Defaults to `'test-mode'`. e2e servers register a SECOND instance under
   *   a distinct type (`DORKOS_TEST_RUNTIME_SECONDARY=true` in index.ts) so
   *   multi-runtime UI — the status-bar picker, `?runtime=` launch binding,
   *   session-list runtime marks — is testable with zero real agent binaries.
   */
  constructor(type = 'test-mode') {
    this.type = type;
    // Sessions must carry their owning instance's type, not a hardcoded
    // 'test-mode', so session-list marks distinguish the two instances.
    this.registry = new TestModeSessionRegistry(type);
    // Capabilities are identical across instances except the identity field;
    // the default instance returns the shared constant BY REFERENCE (the
    // capabilities contract test pins that).
    this.capabilities =
      type === TEST_MODE_CAPABILITIES.type
        ? TEST_MODE_CAPABILITIES
        : { ...TEST_MODE_CAPABILITIES, type };
  }

  ensureSession(sessionId: string, opts: SessionOpts): void {
    this.registry.register(sessionId, {
      permissionMode: opts.permissionMode,
      ...(opts.model !== undefined ? { model: opts.model } : {}),
      ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
    });
  }

  hasSession(sessionId: string): boolean {
    return this.registry.has(sessionId);
  }

  /**
   * Full state reset (the `/api/test/reset` control path): disposes every
   * tracked session's projector — the runtime's ONLY persistence, so leaving
   * them would resurrect pre-reset history on the next snapshot for a reused
   * id — then drops the tracked metadata (which emits `session_removed` to
   * live list subscribers).
   */
  resetTrackedSessions(): void {
    for (const sessionId of this.registry.ids()) {
      disposeProjector(sessionId);
    }
    this.registry.reset();
  }

  async forkSession(): Promise<Session | null> {
    return null;
  }

  async reloadPlugins(): Promise<null> {
    return null;
  }

  updateSession(
    sessionId: string,
    opts: {
      permissionMode?: PermissionMode;
      model?: string;
      effort?: EffortLevel;
      fastMode?: boolean;
    }
  ): boolean {
    return this.registry.applySettings(sessionId, {
      ...(opts.permissionMode !== undefined ? { permissionMode: opts.permissionMode } : {}),
      ...(opts.model !== undefined ? { model: opts.model } : {}),
    });
  }

  async *sendMessage(
    sessionId: string,
    content: string,
    opts?: MessageOpts
  ): AsyncGenerator<StreamEvent> {
    // Track the session the moment DorkOS observes it — the discovery source
    // for subscribeSessionList (no filesystem watch, no native store).
    this.registry.recordMessage(sessionId, content, {
      ...(opts?.cwd !== undefined ? { cwd: opts.cwd } : {}),
    });
    const scenario = scenarioStore.getScenario(sessionId);
    yield* scenario(content);
  }

  /**
   * Fulfill the runtime-fulfilled `compact` intent by yielding a synthetic
   * `compact_boundary` — the deterministic e2e/conformance vehicle, mirroring
   * {@link FakeAgentRuntime}'s final form. Lets the palette-gating + dispatch
   * e2e (Phase 4) and the conformance suite assert a supported runtime's
   * dispatch reached the adapter and produced a boundary the durable projector
   * drives. `TEST_MODE_CAPABILITIES.commandIntents` gates the route before this
   * is ever called.
   */
  async *executeCommandIntent(
    _sessionId: string,
    _intent: RuntimeCommandIntentId,
    _opts?: MessageOpts
  ): AsyncGenerator<StreamEvent> {
    yield { type: 'compact_boundary', data: { trigger: 'manual' } };
  }

  setRelay(_relay: RelayCore): void {
    // No-op: retained to satisfy the AgentRuntime interface.
  }

  async listSessions(projectDir: string): Promise<Session[]> {
    return this.registry.list(projectDir);
  }

  async getSession(_projectDir: string, id: string): Promise<Session | null> {
    return this.registry.get(id);
  }

  /**
   * Completed messages reconstructed from the DorkOS-owned event stream, read
   * DURABLY from the `session_events` store (DOR-189) when wired so history
   * survives a restart; falls back to the live projector's EventLog when no
   * store is injected (bare unit tests). No JSONL, no native store.
   */
  async getMessageHistory(_projectDir: string, id: string): Promise<HistoryMessage[]> {
    return readLogBackedHistory(id);
  }

  async getSessionTasks(_projectDir: string, _id: string): Promise<TaskItem[]> {
    return [];
  }

  async getSessionETag(_projectDir: string, _id: string): Promise<string | null> {
    return null;
  }

  async getLastMessageIds(_sessionId: string): Promise<{ user: string; assistant: string } | null> {
    return null;
  }

  async readFromOffset(
    _projectDir: string,
    _id: string,
    _offset: number
  ): Promise<{ content: string; newOffset: number }> {
    return { content: '', newOffset: 0 };
  }

  acquireLock(_id: string, _clientId: string, _res: SseResponse): boolean {
    return true;
  }

  releaseLock(_id: string, _clientId: string): void {}

  isLocked(_id: string, _clientId?: string): boolean {
    return false;
  }

  getLockInfo(_id: string): { clientId: string; acquiredAt: number } | null {
    return null;
  }

  getCapabilities(): RuntimeCapabilities {
    return this.capabilities;
  }

  async getSupportedModels(): Promise<ModelOption[]> {
    return [];
  }

  async getSupportedSubagents(): Promise<import('@dorkos/shared/types').SubagentInfo[]> {
    return [];
  }

  async renameSession(): Promise<void> {
    // No-op in test mode
  }

  getInternalSessionId(_id: string): string | undefined {
    return undefined;
  }

  /** Required by AgentRuntimeLike (relay package) for SDK session ID lookup. */
  getSdkSessionId(_id: string): string | undefined {
    return undefined;
  }

  async getCommands(_forceRefresh?: boolean, _cwd?: string): Promise<CommandRegistry> {
    return { commands: [], lastScanned: '' };
  }

  async checkDependencies(): Promise<DependencyCheck[]> {
    return [
      {
        name: 'Test Mode Runtime',
        description: 'No external dependencies required.',
        status: 'satisfied',
      },
    ];
  }

  checkSessionHealth(): void {}

  approveTool(_id: string, _toolCallId: string, _approved: boolean): boolean {
    return false;
  }

  submitAnswers(_id: string, _toolCallId: string, _answers: Record<string, string>): boolean {
    return false;
  }

  submitElicitation(
    _id: string,
    _interactionId: string,
    _action: 'accept' | 'decline' | 'cancel',
    _content?: Record<string, unknown>
  ): boolean {
    return false;
  }

  async stopTask(_sessionId: string, _taskId: string): Promise<boolean> {
    return false;
  }

  async interruptQuery(_sessionId: string): Promise<boolean> {
    return false;
  }

  /**
   * @inheritdoc
   *
   * Built ENTIRELY from the DorkOS-owned projection: completed `messages` are
   * reconstructed from the EventLog (the injected loader — "own the boundary,
   * not the bytes", ADR-0263), and the live turn/status/pending/cursor come
   * from the same projector. No JSONL, no native transcript.
   */
  async getSessionSnapshot(ctx: SessionOpts, sessionId: string): Promise<SessionSnapshot> {
    const projector = getOrCreateProjector(sessionId, ctx.cwd, { persist: true });
    return projector.buildSnapshot(() =>
      Promise.resolve(reconstructHistoryFromEvents(projector.replayFrom(0)))
    );
  }

  /**
   * @inheritdoc
   *
   * Delegates to the projector's resumable seq'd stream — the SAME projector
   * the trigger path feeds (`triggerTurn` → `feedProjector`), so `/events`
   * serves a test-mode turn through exactly the code path the Claude adapter
   * uses. Throws {@link StaleResumeCursorError} eagerly via the projector's
   * cursor validation.
   */
  subscribeSession(
    ctx: SessionOpts,
    sessionId: string,
    sinceCursor?: number,
    signal?: AbortSignal
  ): AsyncIterable<SessionEvent> {
    return getOrCreateProjector(sessionId, ctx.cwd, { persist: true }).subscribe(
      sinceCursor,
      signal
    );
  }

  /**
   * @inheritdoc
   *
   * Emits the tracked-session inventory then live upserts from the in-memory
   * registry — NO filesystem watch, proving the list contract is satisfiable
   * without any native store. `session_status` liveness is not emitted here:
   * it fans out runtime-neutrally from the projector via the session-list
   * broadcaster, same as every runtime.
   */
  subscribeSessionList(_ctx: SessionOpts): AsyncIterable<SessionListEvent> {
    return this.registry.subscribe();
  }
}
