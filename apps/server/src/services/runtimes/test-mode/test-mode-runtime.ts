import type {
  AgentRuntime,
  DependencyCheck,
  RuntimeCapabilities,
  SessionOpts,
  MessageOpts,
  CommandIntentOpts,
  SseResponse,
  ManagedMcpServerResolver,
  McpAppServerConnection,
  ToolDecisionOptions,
} from '@dorkos/shared/agent-runtime';
import type { McpServerEntry } from '@dorkos/shared/transport';
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
import {
  disposeProjector,
  getOrCreateProjector,
  getSessionEventStore,
  peekProjector,
} from '../../session/session-state-projector.js';
import { logger } from '../../../lib/logger.js';
import { reconstructHistoryFromEvents } from '../../session/event-log-history.js';
import { readLogBackedHistory } from '../../session/log-backed-history.js';
import { ScenarioAborted, interactionGate } from './interaction-gate.js';
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
  /** The managed-MCP server resolver, injected at boot; drives {@link getMcpStatus}. */
  private managedMcp: ManagedMcpServerResolver | undefined;

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
   * Full state reset (the `/api/test/reset` control path): for every tracked
   * session, disposes its in-memory projector AND deletes its durable
   * `session_events` rows, then drops the tracked metadata (which emits
   * `session_removed` to live list subscribers).
   *
   * Both persistence tiers must be cleared. The projector is the LIVE tier, but
   * a completed turn is also flushed to the durable SQLite store (DOR-189),
   * which `readLogBackedHistory` reads FIRST when a store is wired (the e2e
   * server). Disposing only the projector would leave those rows behind, so a
   * reused id resurrects pre-reset history straight from SQLite. The store is
   * absent in bare unit tests — then `getSessionEventStore()` is `undefined`
   * and only the projector is disposed, the pre-DOR-189 behavior.
   */
  resetTrackedSessions(): void {
    const store = getSessionEventStore();
    for (const sessionId of this.registry.ids()) {
      disposeProjector(sessionId);
      try {
        store?.deleteSession(sessionId);
      } catch (error) {
        // Warn-and-swallow (the flushTurn pattern): one session's failed durable
        // delete must not abort the loop and leave later projectors un-disposed.
        logger.warn('[TestModeRuntime] durable session delete failed during reset', {
          sessionId,
          error,
        });
      }
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
    // The gate is what makes an interactive scenario possible: it hands the
    // scenario the handle it parks on, and gives `approveTool`/`submitAnswers`/
    // `submitElicitation`/`interruptQuery` something real to resolve.
    const ctx = interactionGate.open(sessionId);
    try {
      yield* scenario(content, ctx);
    } catch (error) {
      // A stop is not a failure, and it must not be reported as one. Anything
      // else IS a failure and has to keep propagating — a scenario that threw a
      // genuine bug would otherwise be laundered into a tidy "interrupted".
      if (!(error instanceof ScenarioAborted)) throw error;
      // The honest terminal shape for an interrupt, mirroring the Claude
      // adapter's: a final status naming why, then the `done` that closes the
      // turn so the projector synthesizes `turn_end` and every window's composer
      // comes back. Without these the turn would hang `streaming` forever and
      // the UI would settle dishonestly — or not at all.
      yield {
        type: 'session_status',
        data: { sessionId: 'test-mode', terminalReason: 'aborted_streaming' },
      } as StreamEvent;
      yield { type: 'done', data: { sessionId: 'test-mode' } } as StreamEvent;
    } finally {
      interactionGate.close(sessionId);
    }
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
    _opts?: CommandIntentOpts
  ): AsyncGenerator<StreamEvent> {
    yield { type: 'compact_boundary', data: { trigger: 'manual' } };
  }

  setRelay(_relay: RelayCore): void {
    // No-op: retained to satisfy the AgentRuntime interface.
  }

  /**
   * Capture the managed-MCP server resolver so {@link getMcpStatus} can report an
   * agent's managed servers. Injected at boot into every runtime (index.ts); the
   * claude-code alias registered under `DORKOS_TEST_RUNTIME_CLAUDE_ALIAS` is the
   * one the managed-MCP OAuth e2e drives, since its seeded agent declares
   * `runtime: 'claude-code'`.
   *
   * @param resolver - The managed-server resolver from the composition root.
   */
  setManagedMcpServers(resolver: ManagedMcpServerResolver): void {
    this.managedMcp = resolver;
  }

  /**
   * @inheritdoc
   *
   * TestModeRuntime opens no real MCP connections, so it synthesizes live status
   * from the injection resolver: an enabled http/sse managed server reports
   * `connected` once DorkOS injects its `Authorization: Bearer` header (the
   * operator signed its OAuth flow in) and `needs-auth` until then; stdio is
   * always `connected`. `null` when no resolver is wired. This is the
   * deterministic stand-in the managed-MCP OAuth e2e (DOR-952) asserts against.
   */
  getMcpStatus(cwd: string): McpServerEntry[] | null {
    const servers = this.managedMcp?.injectableServersForCwd(cwd);
    if (!servers) return null;
    return Object.entries(servers).map(([name, connection]) => ({
      name,
      type: connection.transport,
      status: mcpStatusFor(connection),
      scope: 'managed',
    }));
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

  /**
   * @inheritdoc
   *
   * Answers the pending approval a scenario is parked on, then resolves the
   * projector's interaction so the card is dropped from every window through the
   * same seq'd stream a production runtime uses.
   *
   * The projector resolve is what earns the transcript receipt: without it a
   * decision would unblock the scenario while every window went on showing an
   * answerable card, which is exactly the OpenCode ghost DOR-1148 closed.
   * `false` when nothing was waiting — the signal the `/approve` and `/deny`
   * routes turn into a 409 rather than a silent 200.
   */
  approveTool(
    id: string,
    toolCallId: string,
    approved: boolean,
    opts?: ToolDecisionOptions
  ): boolean {
    const resolved = interactionGate.resolveApproval(id, toolCallId, {
      approved,
      ...(opts?.alwaysAllow !== undefined ? { alwaysAllow: opts.alwaysAllow } : {}),
      ...(opts?.denyReason !== undefined ? { denyReason: opts.denyReason } : {}),
    });
    if (!resolved) return false;
    peekProjector(id)?.resolveInteraction(toolCallId, approved ? 'approved' : 'denied', {
      // Only claimable when the words were actually carried to the scenario,
      // which is precisely when a reason was given.
      ...(opts?.denyReason !== undefined ? { reasonGiven: true } : {}),
    });
    return true;
  }

  /**
   * @inheritdoc
   *
   * Delivers an AskUserQuestion answer to the parked scenario and resolves the
   * projector's interaction. See {@link approveTool} for why both halves matter.
   */
  submitAnswers(id: string, toolCallId: string, answers: Record<string, string>): boolean {
    if (!interactionGate.resolveAnswers(id, toolCallId, answers)) return false;
    peekProjector(id)?.resolveInteraction(toolCallId, 'answered');
    return true;
  }

  /**
   * @inheritdoc
   *
   * Delivers an MCP elicitation response to the parked scenario and resolves the
   * projector's interaction. An `accept` is recorded as `answered`; a decline or
   * a cancel is a refusal, and says so.
   */
  submitElicitation(
    id: string,
    interactionId: string,
    action: 'accept' | 'decline' | 'cancel',
    content?: Record<string, unknown>
  ): boolean {
    const resolved = interactionGate.resolveElicitation(id, interactionId, {
      action,
      ...(content !== undefined ? { content } : {}),
    });
    if (!resolved) return false;
    peekProjector(id)?.resolveInteraction(
      interactionId,
      action === 'accept' ? 'answered' : 'denied'
    );
    return true;
  }

  async stopTask(_sessionId: string, _taskId: string): Promise<boolean> {
    return false;
  }

  /**
   * @inheritdoc
   *
   * Aborts the running scenario: every wait it is parked on rejects with
   * {@link ScenarioAborted}, which {@link sendMessage} turns into a terminal
   * `aborted_streaming` + `done` so the turn closes and the composer comes back.
   *
   * Answers `false` when no turn is open, which is the honest report and what
   * the interrupt route passes through as `ok: false` — a stop that arrives
   * after a turn finished on its own is a race, not an error.
   */
  async interruptQuery(sessionId: string): Promise<boolean> {
    return interactionGate.abort(sessionId);
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
    const projector = getOrCreateProjector(sessionId, ctx.cwd, { persist: 'history' });
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
    return getOrCreateProjector(sessionId, ctx.cwd, { persist: 'history' }).subscribe(
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

/**
 * The synthesized MCP status for one injected managed server: http/sse reads
 * `connected` once a bearer is injected (OAuth signed in) and `needs-auth`
 * otherwise; stdio needs no token and is always `connected`. See
 * {@link TestModeRuntime.getMcpStatus}.
 *
 * @param connection - The injected connection from the managed-server resolver.
 */
function mcpStatusFor(connection: McpAppServerConnection): McpServerEntry['status'] {
  if (connection.transport === 'stdio') return 'connected';
  return hasBearerHeader(connection.headers) ? 'connected' : 'needs-auth';
}

/**
 * Whether a header map carries a non-empty `Authorization: Bearer` (case-insensitive key).
 *
 * "Non-empty" means the TOKEN, not the header: a bare `'Bearer '` passes
 * `startsWith` and would otherwise report a server as connected on a header
 * carrying no credential at all. Not reachable through the injection path today
 * — the OAuth engine injects a token or no header — but the docblock said
 * non-empty and the check did not, and the next caller reads the docblock.
 */
function hasBearerHeader(headers: Record<string, string> | undefined): boolean {
  if (!headers) return false;
  const prefix = 'Bearer ';
  return Object.entries(headers).some(
    ([key, value]) =>
      key.toLowerCase() === 'authorization' &&
      value.startsWith(prefix) &&
      value.length > prefix.length
  );
}
