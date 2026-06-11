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
  PendingInteractionDTO,
} from '@dorkos/shared/types';
import type {
  SessionSnapshot,
  SessionEvent,
  SessionListEvent,
} from '@dorkos/shared/session-stream';
import type { RelayCore } from '@dorkos/relay';
import {
  disposeProjector,
  getOrCreateProjector,
  peekProjector,
} from '../../session/session-state-projector.js';
import { reconstructHistoryFromEvents } from '../../session/event-log-history.js';
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
  readonly type = 'test-mode' as const;

  private readonly registry = new TestModeSessionRegistry();
  private _relay: RelayCore | null = null;

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

  setRelay(relay: RelayCore): void {
    this._relay = relay;
  }

  watchSession(
    _sessionId: string,
    _projectDir: string,
    callback: (event: StreamEvent) => void,
    clientId?: string
  ): () => void {
    if (!this._relay || !clientId) return () => {};
    // Subscribe to relay.human.console.{clientId} and forward events to the callback.
    // Mirrors the behavior of SessionBroadcaster.registerCallback() used by ClaudeCodeRuntime.
    const subject = `relay.human.console.${clientId}`;
    return this._relay.subscribe(subject, (envelope) => {
      callback({
        type: 'relay_message',
        data: {
          messageId: (envelope as Record<string, unknown>).id,
          payload: (envelope as Record<string, unknown>).payload,
          subject: (envelope as Record<string, unknown>).subject,
        },
      } as StreamEvent);
    });
  }

  async listSessions(projectDir: string): Promise<Session[]> {
    return this.registry.list(projectDir);
  }

  async getSession(_projectDir: string, id: string): Promise<Session | null> {
    return this.registry.get(id);
  }

  /**
   * Completed messages reconstructed from the DorkOS-owned EventLog — the
   * stateless adapter's only history source (no JSONL, no native store).
   * `peekProjector` (not get-or-create): an id that never streamed has no
   * history, and minting a projector for it would pin registry garbage.
   */
  async getMessageHistory(_projectDir: string, id: string): Promise<HistoryMessage[]> {
    const projector = peekProjector(id);
    return projector ? reconstructHistoryFromEvents(projector.replayFrom(0)) : [];
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
    return TEST_MODE_CAPABILITIES;
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

  getPendingInteractions(_sessionId: string): PendingInteractionDTO[] {
    return [];
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
    const projector = getOrCreateProjector(sessionId, ctx.cwd);
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
    return getOrCreateProjector(sessionId, ctx.cwd).subscribe(sinceCursor, signal);
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
