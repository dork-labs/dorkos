import type {
  AgentRuntime,
  DependencyCheck,
  DeliverIntoTurnOpts,
  RuntimeCapabilities,
  RuntimeDeliveryResult,
  SessionOpts,
  SessionWarmth,
  MessageOpts,
  CommandIntentOpts,
  SseResponse,
  ManagedMcpServerResolver,
  McpAppServerConnection,
  InteractionAnswerOptions,
  ToolDecisionOptions,
  SessionUpdateResult,
} from '@dorkos/shared/agent-runtime';
import type { McpServerEntry } from '@dorkos/shared/transport';
import type {
  StreamEvent,
  Session,
  HistoryMessage,
  TaskItem,
  ModelOption,
  CommandRegistry,
  EffortLevel,
  InterruptReceipt,
  SessionSettings,
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
import { heldProcesses } from './held-process.js';
import { ScenarioAborted, interactionGate } from './interaction-gate.js';
import { declaredInterruptOutcome, scenarioStore } from './scenario-store.js';
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
   *
   * Held processes go back too (DOR-1326). They are per-session runtime state
   * like the projectors above, so a session id reused after a reset must not
   * inherit the previous test's warmth — which would make a cold session report
   * `warm` and offer a Steer nothing could take.
   */
  resetTrackedSessions(): void {
    heldProcesses.reset();
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

  updateSession(sessionId: string, opts: SessionSettings): SessionUpdateResult {
    return {
      updated: this.registry.applySettings(sessionId, {
        ...(opts.permissionMode !== undefined ? { permissionMode: opts.permissionMode } : {}),
        ...(opts.model !== undefined ? { model: opts.model } : {}),
      }),
    };
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
    // Boots this session's scripted process if it opted in and holds none yet,
    // and counts the turn against it — which is what later makes a warm second
    // turn distinguishable from a fresh one. `undefined` for a session on the
    // resume path: nothing is held, so there is nothing to hand back.
    const heldTurn = heldProcesses.beginTurn(sessionId);
    try {
      yield* scenario(content, ctx, opts);
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
      // Scoped to THIS turn's token. The generator is disposed lazily, so on a
      // busy session this can run after the NEXT turn has already opened its own
      // gate — and closing that one would make its card unanswerable and kill it
      // as `aborted_streaming`. See `InteractionGate.close`.
      interactionGate.close(sessionId, ctx.token);
      // The process survives the turn, however the turn ended — a Stop included,
      // which is what an acked stop does on the real pump. Token-scoped for the
      // same lazy-disposal reason the gate close is.
      if (heldTurn !== undefined) heldProcesses.endTurn(sessionId, heldTurn);
    }
  }

  /**
   * Fulfill the runtime-fulfilled `compact` intent by yielding a synthetic
   * compaction — the deterministic e2e/conformance vehicle, mirroring
   * {@link FakeAgentRuntime}'s final form. Lets the palette-gating + dispatch
   * e2e (Phase 4) and the conformance suite assert a supported runtime's
   * dispatch reached the adapter and produced a boundary the durable projector
   * drives. `TEST_MODE_CAPABILITIES.commandIntents` gates the route before this
   * is ever called.
   *
   * Yields the Claude adapter's full three-event shape (progress `started` →
   * boundary → progress `done`), not a bare boundary — see the note in the body
   * for why the readings matter.
   */
  async *executeCommandIntent(
    _sessionId: string,
    _intent: RuntimeCommandIntentId,
    _opts?: CommandIntentOpts
  ): AsyncGenerator<StreamEvent> {
    // Full-fidelity, in the Claude adapter's own shape: the progress pair its
    // system-event mapper builds from `status:'compacting'` and
    // `compact_result:'success'`, around a boundary carrying the same four
    // camelCased fields it forwards from `compact_metadata`. A bare
    // `{trigger:'manual'}` satisfied the conformance suite but left every
    // reading the boundary row exists to report empty, so nothing downstream
    // was ever driven with real numbers.
    yield {
      type: 'operation_progress',
      data: {
        operation: 'compaction',
        state: 'started',
        determinate: false,
        message: 'Compacting context…',
      },
    };
    yield {
      type: 'compact_boundary',
      data: { trigger: 'manual', preTokens: 51_226, postTokens: 4_151, durationMs: 63_275 },
    };
    yield {
      type: 'operation_progress',
      data: { operation: 'compaction', state: 'done', determinate: false },
    };
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

  /**
   * Whether this session's scripted turn declares itself as carrying the DorkOS
   * room tools (spec `tool-only-room-replies` §D14).
   *
   * **`false` by default, and that default is what keeps the suite green.** Every
   * scenario that predates the flip reaches a room through the auto-post path, so
   * a runtime that claimed tool-capability unconditionally would redden six e2e
   * specs and three eval cases the moment `rooms.toolOnlyReplies` went on. A
   * scenario opts IN instead (`room-reply-scenarios.ts`), so the flip's blast
   * radius on the suite is additive rather than a round of edits.
   *
   * @param session.sessionId - The session about to run a turn; the scenario
   *   selection is per session, unlike the two production runtimes whose MCP
   *   configuration is per directory.
   * @returns Whether the selected scenario opted in.
   */
  async carriesRoomTools(session: { sessionId: string }): Promise<boolean> {
    return scenarioStore.isToolCapable(session.sessionId);
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
      ...(opts?.answeredBy ? { answeredBy: opts.answeredBy } : {}),
    });
    return true;
  }

  /**
   * @inheritdoc
   *
   * Delivers an AskUserQuestion answer to the parked scenario and resolves the
   * projector's interaction. See {@link approveTool} for why both halves matter.
   */
  submitAnswers(
    id: string,
    toolCallId: string,
    answers: Record<string, string>,
    opts?: InteractionAnswerOptions
  ): boolean {
    if (!interactionGate.resolveAnswers(id, toolCallId, answers)) return false;
    peekProjector(id)?.resolveInteraction(toolCallId, 'answered', {
      ...(opts?.answeredBy ? { answeredBy: opts.answeredBy } : {}),
    });
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
    content?: Record<string, unknown>,
    opts?: InteractionAnswerOptions
  ): boolean {
    const resolved = interactionGate.resolveElicitation(id, interactionId, {
      action,
      ...(content !== undefined ? { content } : {}),
    });
    if (!resolved) return false;
    peekProjector(id)?.resolveInteraction(
      interactionId,
      action === 'accept' ? 'answered' : 'denied',
      { ...(opts?.answeredBy ? { answeredBy: opts.answeredBy } : {}) }
    );
    return true;
  }

  /** Test-mode scripts no addressable background tasks — nothing to stop. */
  async stopTask(_sessionId: string, _taskId: string): Promise<InterruptReceipt> {
    return { outcome: 'not-running', reason: 'no-open-turn', runtime: this.type };
  }

  /**
   * @inheritdoc
   *
   * The deterministic double for the two non-turn-opening dispositions
   * (spec `persistent-session-runtime` §2.3, task 4.4). Test-mode declares both
   * capabilities, and since DOR-1326 both ride the session's HELD process —
   * which is what makes the refusals below real rather than decorative.
   *
   * - `'steer'` needs two things, exactly as claude-code does: a held process to
   *   push into, and a turn already running to join. Missing either is
   *   `no-open-turn`, which the dispatcher tells apart for the person — a turn
   *   IS open and could not be joined reads `not-steerable`, no turn open reads
   *   `session-idle`. A session on the resume path therefore refuses a steer
   *   that would once have been accepted here, which is the whole point: that is
   *   the pairing DOR-1268 shipped and nothing above the unit layer could stage.
   *   The steered content SURFACES via the dispatcher's `turn_input` carrier, not
   *   here — a runtime never mints that event (it rides the open turn's stream).
   * - `'stage'` needs no open turn, and it asks exactly the question
   *   {@link canStageSession} answers, so the two can never disagree: a session
   *   that WOULD run its next turn on a held process is staged onto — warming it
   *   first if it holds none yet, which is what claude-code's own native stage
   *   does (`PersistentDispatch.stage` launches the pump before appending). The
   *   words go onto that process and the next scripted answer repeats them, so a
   *   browser can see the stage LANDED rather than that a receipt was emitted.
   *   A session that would NOT is refused as `unsupported`, which is the only
   *   refusal the server is allowed to fold — anything else would put a person's
   *   staged words on the queue, where they provoke a reply.
   *
   * Never throws for an ordinary refusal, per the `deliverIntoTurn` contract.
   *
   * @param sessionId - Target session.
   * @param content - The person's text, kept only by a stage onto a held process.
   * @param opts - The delivery mode and its correlation id.
   */
  async deliverIntoTurn(
    sessionId: string,
    content: string,
    opts: DeliverIntoTurnOpts
  ): Promise<RuntimeDeliveryResult> {
    if (opts.mode === 'stage') {
      // One question, asked the way `canStageSession` asks it. Gating on `holds`
      // instead diverged from that answer in two states this really reaches —
      // opted in before the first turn, and opted in after a reap — and the
      // server, told the session was stageable, would have queued the words
      // rather than folding them (see `ensureHeld`).
      if (!heldProcesses.ensureHeld(sessionId)) {
        return { delivered: false, reason: 'unsupported' };
      }
      heldProcesses.stage(sessionId, content);
      return { delivered: true };
    }
    // A steer needs the process AND a turn already running on it. `holds` rather
    // than `willHold` on purpose: a turn cannot be open on a session that holds
    // nothing (every turn on the held path begins by taking the process), so this
    // only ever refuses a session with no live turn to join.
    if (!heldProcesses.holds(sessionId) || !interactionGate.isOpen(sessionId)) {
      return { delivered: false, reason: 'no-open-turn' };
    }
    return { delivered: true };
  }

  /**
   * @inheritdoc
   *
   * Test-mode's steer rides the session's held process, so the honest answer is
   * the same question the dispatch path asks: will this session's next turn run
   * on one? A session that opted in is steerable before its first turn, and one
   * already holding a process stays steerable after the opt-in is turned off —
   * both mirroring claude-code's `PersistentDispatch.shouldDispatch`.
   *
   * Deliberately NOT {@link getSessionWarmth}: warmth is about this instant
   * (`warm` versus `running`), and an affordance offered only while a turn was
   * already open would flicker with the turn instead of describing the session.
   */
  canSteerSession(sessionId: string): boolean {
    return heldProcesses.willHold(sessionId);
  }

  /**
   * @inheritdoc
   *
   * The same question as {@link canSteerSession}, and here the same answer,
   * because both rides are the same ride: a stage appends to the held process,
   * so a session that will not run its next turn on one has nothing to append
   * to. `false` is not a refusal — the server folds the words into the next
   * dispatch and the person still sees "Added context for the next reply".
   *
   * {@link deliverIntoTurn}'s stage branch asks this SAME question rather than
   * "is a process held right now", so the two cannot disagree — the divergence
   * that would otherwise queue a staged message instead of folding it.
   */
  canStageSession(sessionId: string): boolean {
    return heldProcesses.willHold(sessionId);
  }

  /**
   * @inheritdoc
   *
   * `cold` for every session that holds no scripted process, including one this
   * runtime has never heard of.
   */
  getSessionWarmth(sessionId: string): SessionWarmth {
    return heldProcesses.warmth(sessionId);
  }

  /**
   * @inheritdoc
   *
   * Gives the scripted process back. Invisible to the person: the next message
   * boots a fresh one and answers the same way, which is what conformance C5
   * checks — and what the browser leg drives through
   * `POST /api/test/reap` to reach a warmth that went back to `cold` without
   * waiting out an idle window nothing can hurry.
   */
  async reapSession(sessionId: string): Promise<void> {
    heldProcesses.reap(sessionId);
  }

  /**
   * @inheritdoc
   *
   * Always `false`, and that is the honest answer rather than a stub: a
   * test-mode turn is bounded by the generator {@link sendMessage} hands back on
   * BOTH paths, so there is no way for one to outlive its stream and be left
   * open. The held process is bookkeeping, not a subprocess with an input stream
   * of its own — the thing that can strand a turn on the real pump does not
   * exist here.
   *
   * Implemented rather than omitted because declaring
   * `supportsPersistentSession` is what creates the obligation (conformance C8),
   * and because the server reads the ABSENCE of this method as "this runtime
   * cannot strand a turn" — which is true of test-mode and would then be
   * indistinguishable from a persistent runtime that forgot to wire it.
   */
  async settleOpenTurn(_sessionId: string): Promise<boolean> {
    return false;
  }

  /**
   * @inheritdoc
   *
   * Aborts the running scenario: every wait it is parked on rejects with
   * {@link ScenarioAborted}, which {@link sendMessage} turns into a terminal
   * `aborted_streaming` + `done` so the turn closes and the composer comes back.
   *
   * **Resolves the projector's pending interactions too**, exactly as
   * {@link approveTool}, {@link submitAnswers} and {@link submitElicitation} do.
   * Stopping a turn that is parked on an approval makes that card unanswerable —
   * the scenario waiting on it is gone — so leaving it in `pendingInteractions`
   * would strand an immortal card in every window's snapshot, answerable-looking
   * and answering only 409s. Resolved with NO outcome: nobody approved or denied
   * it, and claiming either would be a lie in the transcript.
   *
   * Answers `not-running` when no turn is open, which is the honest report — a
   * stop that arrives after a turn finished on its own is a race, not an error.
   *
   * **A stopped scripted turn is `closed`, not `acked`, by default** (spec
   * `runtime-interrupt-receipts` D10). `interactionGate.abort` is DorkOS ending
   * the scenario from the outside; nothing in the scripted turn acknowledges
   * anything, so reporting `acked` would make the one runtime the browser tests
   * trust the one runtime that lies.
   *
   * A test that needs a different ending **declares** it
   * (`POST /api/test/interrupt-outcome`), which is how the browser leg reaches
   * `acked`, `unconfirmed` and `failed` deterministically. A declared
   * `unconfirmed` or `failed` leaves the turn running, exactly as it would on a
   * runtime that genuinely could not confirm — the whole point is to stage the
   * shape, not to narrate over an abort that happened anyway.
   */
  async interruptQuery(sessionId: string): Promise<InterruptReceipt> {
    const notRunning: InterruptReceipt = {
      outcome: 'not-running',
      reason: 'no-open-turn',
      runtime: this.type,
    };
    const declared = declaredInterruptOutcome();
    // A declared `unconfirmed` or `failed` means the turn did NOT end, so the
    // abort is deliberately not performed: the test is staging the ending a
    // runtime that could not confirm would produce, and a turn that quietly
    // stopped underneath that copy would prove nothing about it.
    if (declared === 'unconfirmed' || declared === 'failed') {
      if (!interactionGate.isOpen(sessionId)) return notRunning;
      return {
        outcome: declared,
        reason: declared === 'failed' ? 'delivery-failed' : 'runtime-declined',
        runtime: this.type,
      };
    }
    // Read before the abort, which clears them.
    const pending = interactionGate.pendingInteractionIds(sessionId);
    if (!interactionGate.abort(sessionId)) return notRunning;
    const projector = peekProjector(sessionId);
    for (const interactionId of pending) projector?.resolveInteraction(interactionId);
    return { outcome: declared ?? 'closed', runtime: this.type };
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
