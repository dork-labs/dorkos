import { OriginalTestModeCapabilityFallback } from './test-mode-capability-fallback.js';
import * as testModeSessionsMethods from './test-mode-sessions-family.js';
import * as testModeInteractionsMethods from './test-mode-interactions-family.js';

import type {
  DeliverIntoTurnOpts,
  RuntimeDeliveryResult,
  SessionOpts,
  SessionWarmth,
  SseResponse,
  McpAppServerConnection,
  InteractionAnswerOptions,
  ToolDecisionOptions,
  SessionUpdateResult,
} from '@dorkos/shared/agent-runtime';
import type { McpServerEntry } from '@dorkos/shared/transport';
import type {
  Session,
  HistoryMessage,
  InterruptReceipt,
  SessionSettings,
} from '@dorkos/shared/types';
import type {
  SessionSnapshot,
  SessionEvent,
  SessionListEvent,
} from '@dorkos/shared/session-stream';

/** Direct original session and interaction methods; opaque keys never leave this instance. */
export class OriginalTestModeSessionInteractionFacade extends OriginalTestModeCapabilityFallback {
  readonly #sessionsOwner: object;
  readonly #interactionsOwner: object;
  constructor(sessionsOwner: object, interactionsOwner: object) {
    super();
    this.#sessionsOwner = sessionsOwner;
    this.#interactionsOwner = interactionsOwner;
  }

  ensureSession(sessionId: string, opts: SessionOpts): void {
    return testModeSessionsMethods.ensureSession(this.#sessionsOwner, sessionId, opts);
  }

  hasSession(sessionId: string): boolean {
    return testModeSessionsMethods.hasSession(this.#sessionsOwner, sessionId);
  }

  /** @inheritdoc Counted per session: a turn is open from its first line to its `finally`. */
  isTurnOpen(sessionId: string): boolean {
    return testModeSessionsMethods.isTurnOpen(this.#sessionsOwner, sessionId);
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
   * Held processes go back too (DOR-1326), and so do declared first-turn
   * renames. They are per-session runtime state like the projectors above, so a
   * session id reused after a reset must not inherit the previous test's warmth
   * — which would make a cold session report `warm` and offer a Steer nothing
   * could take — or its rename.
   */
  resetTrackedSessions(): void {
    return testModeSessionsMethods.resetTrackedSessions(this.#sessionsOwner);
  }

  updateSession(sessionId: string, opts: SessionSettings): Promise<SessionUpdateResult> {
    return testModeSessionsMethods.updateSession(this.#sessionsOwner, sessionId, opts);
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
    return testModeSessionsMethods.getMcpStatus(this.#sessionsOwner, cwd);
  }

  /** Read the same boot-injected connection used for current managed-server membership. */
  getMcpServerConfig(cwd: string, serverName: string): McpAppServerConnection | null {
    return testModeSessionsMethods.getMcpServerConfig(this.#sessionsOwner, cwd, serverName);
  }

  listSessions(projectDir: string): Promise<Session[]> {
    return testModeSessionsMethods.listSessions(this.#sessionsOwner, projectDir);
  }

  getSession(_projectDir: string, id: string): Promise<Session | null> {
    return testModeSessionsMethods.getSession(this.#sessionsOwner, _projectDir, id);
  }

  /** Discover tracked identities without falling back to another scripted runtime. */
  findSession(id: string): Promise<Session | null> {
    return testModeSessionsMethods.findSession(this.#sessionsOwner, id);
  }

  /**
   * Completed messages reconstructed from the DorkOS-owned event stream, read
   * DURABLY from the `session_events` store (DOR-189) when wired so history
   * survives a restart; falls back to the live projector's EventLog when no
   * store is injected (bare unit tests). No JSONL, no native store.
   */
  getMessageHistory(_projectDir: string, id: string): Promise<HistoryMessage[]> {
    return testModeSessionsMethods.getMessageHistory(this.#sessionsOwner, _projectDir, id);
  }

  /**
   * Set a session's title, as the Claude adapter does in its transcript: the
   * list, the sidebar and `GET /api/sessions/:id` all read it from now on, and
   * a later message never replaces it.
   */
  renameSession(sessionId: string, title: string): Promise<void> {
    return testModeSessionsMethods.renameSession(this.#sessionsOwner, sessionId, title);
  }

  /**
   * Declare the canonical id this session's FIRST turn will rename it to.
   *
   * The scripted stand-in for the one thing about a real first turn that no
   * browser test can otherwise reach: a brand-new claude-code session streams
   * under the request UUID the client minted and is renamed to the SDK's own id
   * mid-turn, which moves the projector, the lock, the route the window is on —
   * and the session's canvas. Test mode has no SDK to mint an id, so a test
   * names one instead and this promises to answer it.
   *
   * **Declared now, revealed on the first `sendMessage`.** Until the turn
   * starts, {@link getInternalSessionId} keeps answering `undefined`, so the
   * turn begins under the id the client minted exactly as a real one does and
   * the rename happens mid-turn rather than before it. Declaring it is otherwise
   * inert: nothing else in this runtime reads the map.
   *
   * @param sessionId - The id the client minted and is streaming under.
   * @param canonicalId - The id the first turn will rename it to.
   */
  declareCanonicalSessionId(sessionId: string, canonicalId: string): void {
    return testModeSessionsMethods.declareCanonicalSessionId(
      this.#sessionsOwner,
      sessionId,
      canonicalId
    );
  }

  getInternalSessionId(id: string): string | undefined {
    return testModeSessionsMethods.getInternalSessionId(this.#sessionsOwner, id);
  }

  acquireLock(id: string, clientId: string, res: SseResponse, token?: symbol): boolean {
    return testModeSessionsMethods.acquireLock(this.#sessionsOwner, id, clientId, res, token);
  }

  releaseLock(id: string, clientId: string, token?: symbol): void {
    return testModeSessionsMethods.releaseLock(this.#sessionsOwner, id, clientId, token);
  }

  isLocked(id: string, clientId?: string): boolean {
    return testModeSessionsMethods.isLocked(this.#sessionsOwner, id, clientId);
  }

  getLockInfo(id: string): { clientId: string; acquiredAt: number } | null {
    return testModeSessionsMethods.getLockInfo(this.#sessionsOwner, id);
  }

  /**
   * @inheritdoc
   *
   * Built ENTIRELY from the DorkOS-owned projection: completed `messages` are
   * reconstructed from the EventLog (the injected loader — "own the boundary,
   * not the bytes", ADR-0263), and the live turn/status/pending/cursor come
   * from the same projector. No JSONL, no native transcript.
   */
  getSessionSnapshot(ctx: SessionOpts, sessionId: string): Promise<SessionSnapshot> {
    return testModeSessionsMethods.getSessionSnapshot(this.#sessionsOwner, ctx, sessionId);
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
    return testModeSessionsMethods.subscribeSession(
      this.#sessionsOwner,
      ctx,
      sessionId,
      sinceCursor,
      signal
    );
  }

  /**
   * @inheritdoc
   *
   * The registry answers directly here: test-mode keys its projectors by the
   * DorkOS session id and holds no second id to resolve through, so this reads
   * the same entry {@link subscribeSession} binds to. Peek-only — asking which
   * counter serves a session must not mint one, and the fresh projector a
   * subsequent subscribe would mint refuses every cursor above 0 anyway.
   */
  streamGeneration(_ctx: SessionOpts, sessionId: string): string {
    return testModeSessionsMethods.streamGeneration(this.#sessionsOwner, _ctx, sessionId);
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
    return testModeSessionsMethods.subscribeSessionList(this.#sessionsOwner, _ctx);
  }

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
    return testModeInteractionsMethods.approveTool(
      this.#interactionsOwner,
      id,
      toolCallId,
      approved,
      opts
    );
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
    return testModeInteractionsMethods.submitAnswers(
      this.#interactionsOwner,
      id,
      toolCallId,
      answers,
      opts
    );
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
    return testModeInteractionsMethods.submitElicitation(
      this.#interactionsOwner,
      id,
      interactionId,
      action,
      content,
      opts
    );
  }

  /** Test-mode scripts no addressable background tasks — nothing to stop. */
  stopTask(_sessionId: string, _taskId: string): Promise<InterruptReceipt> {
    return testModeInteractionsMethods.stopTask(this.#interactionsOwner, _sessionId, _taskId);
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
  deliverIntoTurn(
    sessionId: string,
    content: string,
    opts: DeliverIntoTurnOpts
  ): Promise<RuntimeDeliveryResult> {
    return testModeInteractionsMethods.deliverIntoTurn(
      this.#interactionsOwner,
      sessionId,
      content,
      opts
    );
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
    return testModeInteractionsMethods.canSteerSession(this.#interactionsOwner, sessionId);
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
    return testModeInteractionsMethods.canStageSession(this.#interactionsOwner, sessionId);
  }

  /**
   * @inheritdoc
   *
   * `cold` for every session that holds no scripted process, including one this
   * runtime has never heard of.
   */
  getSessionWarmth(sessionId: string): SessionWarmth {
    return testModeInteractionsMethods.getSessionWarmth(this.#interactionsOwner, sessionId);
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
  reapSession(sessionId: string): Promise<void> {
    return testModeInteractionsMethods.reapSession(this.#interactionsOwner, sessionId);
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
  settleOpenTurn(_sessionId: string): Promise<boolean> {
    return testModeInteractionsMethods.settleOpenTurn(this.#interactionsOwner, _sessionId);
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
  interruptQuery(sessionId: string): Promise<InterruptReceipt> {
    return testModeInteractionsMethods.interruptQuery(this.#interactionsOwner, sessionId);
  }
}
