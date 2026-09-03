/**
 * SDK query execution -- extracted from ClaudeCodeRuntime.sendMessage()
 * for file size management.
 *
 * Contains the core messaging pipeline: boundary validation, agent manifest loading,
 * tool-group resolution, system prompt building, SDK option configuration, and event
 * streaming.
 *
 * @module services/runtimes/claude-code/message-sender
 */
import { query, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { StreamEvent, ErrorCategory } from '@dorkos/shared/types';
import type { MessageOpts } from '@dorkos/shared/agent-runtime';
import {
  emptyStreamError,
  isContentEvent,
  isInteractiveEvent,
  isReportedFailure,
} from './empty-stream-guard.js';
import { fireLaunchProbes } from './launch-probes.js';
import type { AgentSession } from '../agent-types.js';
import { createToolState, stopWasAimedAt } from '../agent-types.js';
import {
  detectPhantomCancellations,
  buildPhantomCorrectionNote,
  PHANTOM_CORRECTIONS_MAX_PER_TURN,
} from './phantom-cancellation.js';
import { mapSdkMessageWithMedia } from '../media-capture.js';
import { createTurnLiveness } from './turn-liveness.js';
import { createDeferredClose, settleStdinAtDeadline, settleStdinAtResult } from './stdin-hold.js';
import { createHeldUserPrompt } from '../sdk/sdk-utils.js';
import { fetchContextBreakdown } from '../sdk/context-usage.js';
import { fetchSubscriptionUsage } from '../sdk/subscription-usage.js';
import { resolveEffectiveCwd, resolveLaunch } from './launch-resolver.js';
import type { MessageSenderOpts } from './message-sender-shared.js';
// The turn path's boundary rule and the refusal it surfaces, shared with the
// pump's per-dispatch gate so the two cannot drift. Which validator it picks,
// and why an agent's own home under {dorkHome}/agents/* is allowed while
// dork-home's siblings are not, is that module's header.
import { boundaryViolationEvent, validateDispatchBoundary } from '../dispatch-boundary.js';
import { logger } from '../../../../lib/logger.js';
import { recordPhantomCancellation } from '../../../observability/phantom-cancellations.js';
// The projector's own rule for which events REOPEN a turn window, imported
// rather than restated so the loop's idea of "a window is open" cannot drift
// from the normalizer's (DOR-1244).
import { TURN_REOPENING_STREAM_EVENT_TYPES } from '../../../session/session-event-normalizer.js';
import { describeAuthError, detectAuthError } from '@dorkos/shared/runtime-error-classification';
import { CLAUDE_CODE_RUNTIME_TYPE } from '../sdk/sdk-error-mapping.js';

// The vocabulary and the two small helpers both dispatch paths use. Re-exported
// rather than moved-and-rewired: every import site in the tree names this
// module, and the split exists to break a cycle, not to move an API.
export {
  createEditBaselineCapture,
  detectSlashCommandName,
  toMcpAppConnection,
  type MessageSenderOpts,
  type SdkCommandEntry,
  type SdkReportedModel,
} from './message-sender-shared.js';

const RESUME_FAILURE_PATTERNS = [
  'query closed before response',
  'session not found',
  'no such file',
  'enoent',
];

/**
 * Max transparent retries before surfacing the error. A single budget shared by
 * BOTH resume-recovery paths — stale-session-as-new ({@link isResumeFailure})
 * and anchor-not-found ({@link isAnchorNotFound}) — so a turn that spends it on
 * an anchor retry gets no second retry for a stale-session failure that follows.
 */
const MAX_RESUME_RETRIES = 1;

/** Max time to wait for the post-turn `getContextUsage()` control response. */
const CONTEXT_USAGE_TIMEOUT_MS = 8_000;

/** Detect whether an error indicates a failed SDK session resume. */
function isResumeFailure(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  return RESUME_FAILURE_PATTERNS.some((p) => msg.includes(p));
}

/**
 * Detect the CLI's hard failure when a `resumeSessionAt` anchor uuid is not in
 * the (possibly compacted or externally rewritten) transcript — it throws
 * `No message found with message.uuid of: <uuid>`. Distinct from
 * {@link isResumeFailure}: recovery drops the anchor and resumes plainly,
 * preserving history, rather than restarting as a brand-new session.
 */
function isAnchorNotFound(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return /no message found with message\.uuid/i.test(err.message);
}

/**
 * Execute an SDK query and yield StreamEvent objects.
 *
 * This is the core messaging pipeline: validates boundary, loads agent manifest,
 * resolves tool groups, builds system prompt context, configures SDK options,
 * and streams events from the SDK query.
 *
 * @param sessionId - Session identifier
 * @param content - User message text
 * @param session - In-memory session state (mutated during execution)
 * @param opts - Runtime dependencies and configuration
 * @param messageOpts - Optional caller-provided overrides
 */
export async function* executeSdkQuery(
  sessionId: string,
  content: string,
  session: AgentSession,
  opts: MessageSenderOpts,
  messageOpts?: MessageOpts,
  retryDepth = 0
): AsyncGenerator<StreamEvent> {
  session.lastActivity = Date.now();
  session.eventQueue = [];
  // Clear last turn's breakdown so a failed fetch this turn never shows stale data.
  session.contextBreakdown = undefined;
  // A stop stamped in a PREVIOUS turn must not blind this turn's phantom
  // detector (DOR-1087) — the suppression window is scoped to the turn the
  // operator actually interrupted.
  session.interruptRequestedAt = undefined;

  // The ONE cwd resolution for this turn, handed to both the boundary gate and
  // the launch below. Resolved twice by two routes, the gate would answer about
  // one directory while the process ran in another (`dispatch-boundary.ts`).
  const effectiveCwd = resolveEffectiveCwd(opts, messageOpts);
  try {
    await validateDispatchBoundary(effectiveCwd);
  } catch {
    logger.warn('[sendMessage] boundary violation', { session: sessionId, effectiveCwd });
    yield boundaryViolationEvent(effectiveCwd);
    return;
  }

  // Everything this launch is pinned to, resolved by the module the pump path
  // shares — one resolution, so a value the two paths disagreed on could never
  // read as "no change" to the pump's relaunch fingerprint.
  const { sdkOptions, enrichedContent, meshAgentId, statusEvents } = await resolveLaunch({
    sessionId,
    content,
    session,
    opts,
    ...(messageOpts !== undefined ? { messageOpts } : {}),
    effectiveCwd,
  });
  // The auto-permission-mode downgrade notice, which the resolver returns as
  // data rather than yielding. Ahead of every SDK event, exactly where this
  // turn has always emitted it.
  for (const event of statusEvents) yield event;

  // Hold the input stream open so the subprocess survives past the result message
  // and can answer getContextUsage() (closed below once the turn completes).
  const heldPrompt = createHeldUserPrompt(enrichedContent);
  const agentQuery = query({ prompt: heldPrompt.prompt, options: sdkOptions });
  session.activeQuery = agentQuery;

  // Ending the held prompt sends the CLI's stdin an EOF, and from that moment
  // nothing DorkOS writes to this query arrives: the SDK drops the write in
  // silence and a control request waits on an ack that can never come. Record
  // WHICH query that happened to, so a Stop arriving afterwards — the CLI can
  // keep going past the EOF and reopen the turn (DOR-1100) — closes the process
  // at once instead of spending its whole bound on an undeliverable interrupt
  // (DOR-1244). Added to a SET keyed by the query rather than written to a
  // session flag or a single slot, because an overlapping turn shares this
  // session (DOR-1088): a flag would condemn the successor's healthy query, and
  // a slot would let this turn — which may settle after its successor started —
  // overwrite the successor's own record. Weak, so nothing has to clear it.
  const endStdin = (): void => {
    heldPrompt.close();
    (session.stdinEndedQueries ??= new WeakSet()).add(agentQuery);
  };

  // The per-PROCESS probes: what this subprocess supports, asked once per
  // launch and never awaited. Shared with the pump, which launches the same
  // way and owes its session the same answers.
  fireLaunchProbes(agentQuery, opts);

  logger.info('[sendMessage] stream start', {
    session: sessionId,
    hasStarted: session.hasStarted,
    effectiveCwd,
  });

  let emittedDone = false;
  let emittedError = false;
  // Whether a turn WINDOW stands open right now, mirroring `feedProjector`'s own
  // `turnOpen` latch (`session/session-event-normalizer.ts`): the projector opens
  // a window before this stream's first event, `done` closes it, and a reopening
  // event opens a fresh one. Tracked here so the loop can tell, at the end, that
  // it is leaving a window somebody still has to close — which is the DOR-1100
  // wind-down shape and the only case that needs the terminal below.
  let turnWindowOpen = true;
  /** Follow {@link turnWindowOpen} through one event this loop is about to yield. */
  const trackTurnWindow = (event: StreamEvent): void => {
    if (event.type === 'done') turnWindowOpen = false;
    else if (TURN_REOPENING_STREAM_EVENT_TYPES.has(event.type)) turnWindowOpen = true;
  };
  /**
   * Whether a DorkOS Stop has been aimed at THIS query (`session-store.ts`).
   *
   * Read live rather than captured, because a Stop can land at any moment of
   * the stream and both readers below care about the answer AT THE MOMENT they
   * ask: the empty-stream guards ask as a turn closes, the terminal synthesis
   * asks once the stream is over.
   */
  const wasStopped = (): boolean => stopWasAimedAt(session, agentQuery);
  let eventCount = 0;
  let contentEventCount = 0;
  let wasInteractive = false;
  // Anchor for the NEXT turn's resume: the last main-thread assistant uuid seen
  // this turn (undefined until one arrives). Committed to the session in the
  // `finally`, unless a recursion retry already set the authoritative value.
  let lastMainAssistantUuid: string | undefined;
  let retriedViaRecursion = false;
  // Corrective notes steered into this turn after phantom cancellations
  // (DOR-1087) — capped so the correction can never feed itself. There is no
  // separate post-`result` gate: the held prompt being OPEN is the whole
  // condition, because a turn with background work outstanding continues past
  // its first `result` (see `turn-liveness.ts`) and a note pushed then lands in
  // the segment that is still running. Once the stream is closed for good,
  // `push()` refuses on its own (DOR-1149).
  // Separate budgets, because they compete for different reasons (DOR-1150).
  // Subagent phantoms arrive in bursts — one misbehaving helper produced four in
  // the 2026-08-11 session — and a shared pool let them spend every note before
  // the coordinator's OWN cancellation, the one where the recipient is the
  // victim, ever got a correction.
  let mainThreadCorrections = 0;
  let subagentCorrections = 0;
  // What says whether this turn is still alive at a `result`: a background
  // subagent still running, or a settled notification still owed its delivery.
  // One tracker per PROCESS, which on this path is one per turn (DOR-1238).
  const liveness = createTurnLiveness();
  // The bound on the ONE hold nothing else bounds — an owed delivery that never
  // arrives. A hold for a live agent is deliberately never given one.
  const deferredClose = createDeferredClose();
  const streamStart = Date.now();
  const toolState = createToolState();

  try {
    const sdkIterator = agentQuery[Symbol.asyncIterator]();
    let pendingSdkPromise: Promise<{
      sdk: true;
      result: IteratorResult<SDKMessage>;
    }> | null = null;

    while (true) {
      while (session.eventQueue.length > 0) {
        const queuedEvent = session.eventQueue.shift()!;
        if (queuedEvent.type === 'done') emittedDone = true;
        // `interactive-handlers.ts` pushes approval/question/elicitation prompts
        // onto this queue directly — they never reach the guard through
        // `mapSdkMessageWithMedia` below, so this is the ONLY place on this path
        // that can ever see one. Without this check `wasInteractive` could never
        // become true here, and an interactive-only turn (nothing but an unanswered
        // prompt, no content) would misreport as a dead stream (DOR-1240).
        if (isInteractiveEvent(queuedEvent)) wasInteractive = true;
        trackTurnWindow(queuedEvent);
        eventCount++;
        yield queuedEvent;
      }

      const queuePromise = new Promise<'queue'>((resolve) => {
        session.eventQueueNotify = () => resolve('queue');
      });

      if (!pendingSdkPromise) {
        pendingSdkPromise = sdkIterator.next().then((result) => ({ sdk: true as const, result }));
      }

      // An owed-delivery hold must not be able to wedge the turn: while stdin is
      // held the CLI waits on us and we wait on the CLI, so the `finally` is
      // never reached. The deadline is armed ONCE per hold (see `stdin-hold.ts`)
      // rather than re-armed each iteration, so a chatty stream cannot push it
      // back for ever. It is armed only when nothing is live, released the
      // moment a segment starts, and re-checks liveness before it closes
      // anything — so it can no longer fire inside a running segment or under a
      // helper launched since it was armed (DOR-1238).
      const winner = await Promise.race(
        deferredClose.deadline
          ? [queuePromise, pendingSdkPromise, deferredClose.deadline]
          : [queuePromise, pendingSdkPromise]
      );

      if (winner === 'expired') {
        settleStdinAtDeadline({
          sessionId,
          liveness,
          deferredClose,
          close: endStdin,
        });
        continue;
      }

      if (winner === 'queue') {
        continue;
      }

      pendingSdkPromise = null;
      const { result } = winner;
      if (result.done) break;

      // Track the last MAIN-THREAD assistant message uuid so the NEXT turn can
      // anchor its resume at it (see the `resumeSessionAt` note above). Subagent
      // assistant messages carry a `parent_tool_use_id` and live in a separate
      // transcript, so they must never become the main-session anchor.
      if (result.value.type === 'assistant' && result.value.parent_tool_use_id === null) {
        lastMainAssistantUuid = result.value.uuid;
      }

      // Background-task lifecycle drives BOTH decisions below: whether a
      // `result` ends the turn or only a segment of it, and therefore whether a
      // corrective note still has a live channel (DOR-1149, DOR-1238).
      const { segmentRunning } = liveness.observe(result.value);
      // A second `system/init`, or the model speaking, proves a segment is
      // running and that a `result` will close it. Any deadline armed at the
      // previous `result` goes now — expiring it inside a running segment is
      // what cancels that segment's tool calls (DOR-1238).
      if (segmentRunning) deferredClose.release();

      // Phantom cancellation (DOR-1087): the CLI cancelled pending tool calls
      // because a task-notification was queued, writing a sentinel that reads
      // as a user refusal. Tell the model it wasn't the user, and surface a
      // status line for the operator. The notice event carries NO `status`
      // field (the client strip drops any system_status that has one) and is
      // yielded AFTER this message's mapped events below — yielded here, the
      // same message's tool_result events would re-derive the strip and wipe it
      // in the same frame.
      //
      // A SUBAGENT phantom is steered too (DOR-1150). The note cannot reach the
      // subagent — its input stream is not ours — so it goes to the coordinator,
      // which is the party that will otherwise believe the subagent's false "the
      // user declined" and abandon the work. This does push a message into the
      // main thread's queue while a subagent runs, which is itself the mechanism
      // that causes phantoms; `PHANTOM_CORRECTIONS_MAX_PER_TURN` is what stops
      // that from feeding itself, and a coordinator acting on a false refusal is
      // the worse of the two failures.
      const phantoms = detectPhantomCancellations(result.value, session);
      let phantomNotice: string | undefined;
      if (phantoms.length > 0) {
        // A batch is uniformly one or the other: `parent_tool_use_id` is a
        // message-level field (see `detectPhantomCancellations`).
        const mainThread = phantoms.some((p) => p.mainThread);
        const spent = mainThread ? mainThreadCorrections : subagentCorrections;
        const steered =
          spent < PHANTOM_CORRECTIONS_MAX_PER_TURN &&
          heldPrompt.push(buildPhantomCorrectionNote(phantoms));
        if (steered) {
          if (mainThread) mainThreadCorrections++;
          else subagentCorrections++;
        }
        // Counts it and writes the line, both (DOR-1288). The tripwire has to
        // be readable as a RATE for the persistent-session measurement, and the
        // resume path is its flag-off leg.
        recordPhantomCancellation({ sessionId, path: 'turn', phantoms, steered });
        const plural =
          phantoms.length > 1 ? `${phantoms.length} pending tool calls` : 'a pending tool call';
        const where = mainThread ? '' : ' inside one of its helpers';
        phantomNotice = `A background task finished at the wrong moment and cancelled ${plural}${where}. That was a system glitch, not you. The agent has been told.`;
      }

      // The `result` message marks the end of a SEGMENT — which is the end of
      // the turn only when nothing is still running and nothing is still owed a
      // delivery (DOR-1238). The subprocess is alive either way (the prompt
      // stream is held open), so fetch the authoritative context-usage AND the
      // current subscription utilization now — before this message maps to
      // `done`, so the resulting `context_usage` event precedes `done` and the
      // terminal `session_status` carries `usage` (DOR-99).
      //
      // This frame's OWN query, never the session's shared slot (DOR-1088): an
      // overlapping turn can have replaced `activeQuery`, and the usage
      // breakdown has to come from the subprocess that produced THIS result.
      // The guard on `session.activeQuery` that used to sit here also gated the
      // `heldPrompt.close()` below — so a frame whose slot had been cleared
      // never released its own stdin, and the subprocess it owned could not
      // exit. Reading the local removes both problems at once.
      if (result.value.type === 'result') {
        const query = agentQuery;
        const [breakdown, subscriptionUsage] = await Promise.all([
          fetchContextBreakdown(query, CONTEXT_USAGE_TIMEOUT_MS).catch((err: unknown) => {
            logger.debug('[sendMessage] getContextUsage failed', { err });
            return undefined;
          }),
          fetchSubscriptionUsage(query, CONTEXT_USAGE_TIMEOUT_MS).catch((err: unknown) => {
            logger.debug('[sendMessage] get_usage failed', { err });
            return undefined;
          }),
        ]);
        if (breakdown) session.contextBreakdown = breakdown;
        // Hold the freshest utilization on the session so the result mapper
        // stamps it onto the terminal session_status. `undefined` (API-key
        // session, fetch failure) keeps the last known value — the item must
        // never flicker back to cost-only between turns.
        if (subscriptionUsage) session.lastSubscriptionUsage = subscriptionUsage;
        // Release stdin so the process drains its trailing messages and exits —
        // unless the turn is still alive, in which case the EOF would cancel
        // every hook-matched tool the CLI runs from here on and drop every
        // corrective push (DOR-1238; see `stdin-hold.ts`). The `finally` closes
        // unconditionally, so a hold can never leak the subprocess.
        settleStdinAtResult({
          sessionId,
          liveness,
          deferredClose,
          close: endStdin,
        });
      }

      // A mid-session `commands_changed` push carries the full, authoritative
      // command list. Replace the runtime cache here (this loop holds the
      // callback; the pure system-event mapper does not) so `/api/commands`
      // reflects the change without a restart (DOR-108).
      if (
        result.value.type === 'system' &&
        'subtype' in result.value &&
        (result.value as { subtype?: string }).subtype === 'commands_changed' &&
        opts.onCommandsChanged
      ) {
        const changed = result.value as unknown as {
          commands?: Array<{
            name: string;
            description: string;
            argumentHint: string;
            aliases?: string[];
          }>;
        };
        opts.onCommandsChanged(
          (changed.commands ?? []).map((c) => ({
            name: c.name,
            description: c.description,
            argumentHint: c.argumentHint,
            aliases: c.aliases,
          }))
        );
      }

      let prevSdkId = session.sdkSessionId;
      for await (const event of mapSdkMessageWithMedia(
        opts.attachments ?? null,
        result.value,
        session,
        sessionId,
        toolState,
        wasStopped
      )) {
        // BEFORE this event leaves the server. The mapper may have just adopted
        // a new canonical id, and yielding first is what opened the window this
        // closes: `trigger-turn` re-keys the projector on every event it sees,
        // which announces the new id to the cockpit as `retiredSessionId`, and
        // the cockpit's very next message is POSTed under it. That POST reaches
        // `persistSessionRuntime`, which mints a row for an id it has never
        // seen — pre-seeded with the server's default trust stop — and reports
        // a brand-new session. Moving the row first means the POST lands on a
        // row that is already bound: nothing is seeded, nothing is counted
        // twice, and the merge below never has to choose between the operator's
        // mode and a default nobody picked (DOR-493, DOR-838).
        if (session.sdkSessionId !== prevSdkId) {
          const retired = prevSdkId;
          prevSdkId = session.sdkSessionId;
          await opts.onSdkSessionRebind(retired, session.sdkSessionId);
        }
        if (event.type === 'done') {
          emittedDone = true;
          if (opts.meshCore && meshAgentId) {
            opts.meshCore.updateLastSeen(meshAgentId, 'response_complete');
          }
          // Zero-content turn about to close: surface the no-response error
          // BEFORE the terminal done — nothing may follow done (a trailing
          // error would leave the durable snapshot idle with a stale
          // lastError instead of settling the turn to error).
          //
          // A turn the operator STOPPED is not a dead stream, even with nothing
          // in it — the same reason `wasInteractive` is here (DOR-1240). Press
          // Stop before the agent has said anything and this guard called the
          // silence a fault, which reaches the operator as the crash notice
          // "Claude Code stopped unexpectedly" for something they did on
          // purpose (DOR-1244).
          if (contentEventCount === 0 && !emittedError && !wasInteractive && !wasStopped()) {
            logger.warn('[sendMessage] stream completed with zero content events', {
              session: sessionId,
              eventCount,
              durationMs: Date.now() - streamStart,
            });
            emittedError = true;
            yield emptyStreamError();
          }
        }
        // A failure the turn has already reported — a mapped typed error (e.g.
        // a non-success result subtype), or a named operation that resolved
        // `failed` — counts as a prior error for the empty-stream guard below;
        // without this, a failed zero-content turn would get a second, vaguer
        // error appended after its terminal done.
        if (isReportedFailure(event)) emittedError = true;
        // Track content events for empty-stream detection
        if (isContentEvent(event)) contentEventCount++;
        if (isInteractiveEvent(event)) wasInteractive = true;
        trackTurnWindow(event);
        eventCount++;
        yield event;
      }
      // The phantom notice trails this message's own mapped events (see the
      // detection block above) so the strip re-derivation those events trigger
      // cannot wipe it in the same frame.
      if (phantomNotice !== undefined) {
        eventCount++;
        yield { type: 'system_status', data: { message: phantomNotice } };
      }
      // Catch-all for an id adopted after the last event of this message was
      // yielded (nothing does that today, and this costs one comparison if
      // nothing ever does). The in-loop rebind above is the one that carries the
      // ordering guarantee; this one only makes sure a rename can never be
      // missed outright. `rebindSdkSession` is a no-op when the ids match, so
      // the two can never double-apply.
      if (session.sdkSessionId !== prevSdkId) {
        await opts.onSdkSessionRebind(prevSdkId, session.sdkSessionId);
      }
    }
  } catch (err) {
    // A stale/absent `resumeSessionAt` anchor (transcript compacted or rewritten
    // out from under us) makes the CLI hard-fail. Drop the anchor and resume
    // plainly — this preserves history (unlike the resume-as-new path below) and
    // at worst re-admits a single phantom continue this one turn.
    if (sdkOptions.resumeSessionAt && isAnchorNotFound(err) && retryDepth < MAX_RESUME_RETRIES) {
      logger.warn('[sendMessage] resumeSessionAt anchor not found, retrying without anchor', {
        session: sessionId,
        retryDepth,
        anchor: sdkOptions.resumeSessionAt,
      });
      session.lastAssistantUuid = undefined;
      retriedViaRecursion = true;
      yield* executeSdkQuery(sessionId, content, session, opts, messageOpts, retryDepth + 1);
      return;
    }
    if (session.hasStarted && isResumeFailure(err) && retryDepth < MAX_RESUME_RETRIES) {
      logger.warn('[sendMessage] resume failed for stale session, retrying as new', {
        session: sessionId,
        retryDepth,
        error: err instanceof Error ? err.message : String(err),
      });
      // `accountRoot` deliberately survives this reset (spec C2). The retry
      // starts a BRAND-NEW SDK session, whose transcript is written under
      // whatever account the recursion pins — so clearing the account here
      // alongside `hasStarted` would silently move a paying client's
      // conversation onto whichever account happens to be active. The account is
      // a fact about the conversation, not about whether it has started.
      session.hasStarted = false;
      retriedViaRecursion = true;
      yield* executeSdkQuery(sessionId, content, session, opts, messageOpts, retryDepth + 1);
      return;
    }
    const errMsg = err instanceof Error ? err.message : String(err);
    logger.warn('[sendMessage] stream error', {
      session: sessionId,
      error: errMsg,
      durationMs: Date.now() - streamStart,
      eventCount,
      contentEventCount,
      retryDepth,
    });
    // A pre-stream credential failure (the classic first-run "not signed in"
    // case) throws here before any typed error event reaches the mappers, so
    // classify the raw thrown message: an auth failure earns the re-auth
    // category (and its "Fix sign-in" affordance) instead of the generic
    // overloaded copy. The raw message stays reachable via `details`.
    //
    // The sentence is the SHARED one, not a third wording of the same news
    // (DOR-1656): this channel, the assistant channel and the result channel all
    // report the same expiry, and a person should not be able to tell which one
    // caught it.
    const isAuthError = detectAuthError({ message: errMsg });
    yield {
      type: 'error',
      data: {
        message: isAuthError
          ? describeAuthError(CLAUDE_CODE_RUNTIME_TYPE)
          : 'The agent stopped unexpectedly. The service may be temporarily overloaded — try again in a moment.',
        category: (isAuthError ? 'auth_error' : 'execution_error') as ErrorCategory,
        details: errMsg,
      },
    };
    emittedError = true;
  } finally {
    // Always release the held input stream so the subprocess can never leak if we
    // exit before the result message (error, interrupt, empty stream). Idempotent.
    // Clearing the deadline here also covers the path where the race THREW —
    // otherwise a rejected SDK promise would leave a live timer behind.
    deferredClose.release();
    endStdin();
    // Preserve the query reference for post-stream control methods (e.g.
    // reloadPlugins) — but only when this frame still OWNS the active query
    // (DOR-1088). Unconditional, this cleared whatever query happened to be
    // active, so a frame that settled late stranded its successor: the newer
    // turn kept streaming with `activeQuery` set to `undefined`, and every
    // control call that reaches for it (interrupt, model change, context usage)
    // found nothing to talk to. The recursion retry has the same shape — the
    // inner frame installs and clears its own query, and this line then wiped
    // the `lastQuery` the inner frame had just recorded.
    if (session.activeQuery === agentQuery) {
      session.lastQuery = agentQuery;
      session.activeQuery = undefined;
    }
    // Commit this turn's resume anchor for the next turn: the last main-thread
    // assistant uuid, or undefined when the turn produced none (empty/error) so
    // the next resume stays plain and keeps this turn's user message in context.
    // Skipped when a recursion retry ran — that inner call set the correct value
    // and this outer frame's local would clobber it.
    if (!retriedViaRecursion) {
      session.lastAssistantUuid = lastMainAssistantUuid;
    }
  }

  // Detect empty streams that also never produced a done — zero content
  // events with no prior error. The done-bearing zero-content case is handled
  // in-loop (error yielded BEFORE the terminal done); this arm covers streams
  // that died without any terminal at all, where the trailing done below
  // still closes the turn after this error.
  //
  // `wasStopped()` for the same reason as the in-loop arm, and this is the arm
  // a Stop in the STARTING phase actually lands in: the escalation closes the
  // process before the model has said anything and before any `result`, so
  // without this the turn reported "The agent did not respond" and settled
  // `error` — and the error latch set here would suppress the interrupted
  // terminal below on top of that (DOR-1244).
  if (
    contentEventCount === 0 &&
    !emittedError &&
    !emittedDone &&
    !wasInteractive &&
    !wasStopped()
  ) {
    logger.warn('[sendMessage] stream completed with zero content events', {
      session: sessionId,
      eventCount,
      durationMs: Date.now() - streamStart,
    });
    yield emptyStreamError();
    emittedError = true;
  }

  logger.info('[sendMessage] stream done', {
    session: sessionId,
    durationMs: Date.now() - streamStart,
    eventCount,
    contentEventCount,
  });

  // A turn a Stop ENDED settles as interrupted, never as idle (DOR-1244).
  //
  // Nothing else can say so on this path. The CLI names its own terminal in
  // `result.terminal_reason`, which the result mapper puts on the turn's final
  // `session_status` — but a turn ended by `query.close()` produces no further
  // `result`, so the window the CLI reopened (DOR-1100) is closed by
  // `feedProjector`'s `finally` with no reason at all. `deriveTurnEndLifecycle`
  // reads that as idle, which is the same thing it says about a reply that
  // finished by itself: a Stop that had to kill the CLI would tell the operator
  // their agent is fine. So the sender supplies the reason the CLI cannot.
  //
  // All three conditions are load-bearing. `turnWindowOpen` is what keeps a Stop
  // RACING a natural end from rewriting history: a turn whose `result` already
  // closed its window is not open here, so it keeps the CLI's own `completed`,
  // and only a window still standing at the end of the stream — content after
  // the last result, or a turn that never reached one — can be claimed.
  // `wasStopped()` is what keeps every other way a window can be left open
  // (a crash after a reopen) settling as it did before. And an error already
  // reported stays the terminal, because a failure is more specific than a stop
  // — which is also why the empty-stream guards above have to know about a Stop:
  // an error latched there would silently swallow this.
  //
  // Scope: this is the RESUME path only. The persistent pump does not run this
  // loop, and a `query.close()` there is a process death — the windower settles
  // it as `turn_end{terminalReason:'error'}` and the session reports `crashed`
  // (`sessions/session-turn-windows.ts`, `sessions/persistent-dispatch.ts`).
  // `persistentSession` now ships ON (spec `full-power-defaults`, D1), so the
  // pump is the path a default install takes and making its Stop settle
  // honestly — DOR-1244's named follow-up — stopped being a minority case when
  // that default flipped.
  //
  // Carried on a `session_status` because that is where the result mapper puts
  // `terminalReason` too, and the normalizer reads it off either. It projects no
  // status of its own: neither field below is a status field, so `toStatusChange`
  // still yields null and this event moves the terminal reason and touches
  // nothing else.
  //
  // `stopWasRequested: true` is not decoration and not a guess — reaching this
  // line REQUIRES `wasStopped()`, so the intent is proven by the branch itself.
  // Stating it keeps settlement from having to infer intent from the reason:
  // `'interrupted'` is an abort reason like any other, and a reader that has to
  // guess who caused an abort is exactly the hole this field closes.
  if (turnWindowOpen && wasStopped() && !emittedError) {
    logger.debug('[sendMessage] settling a stopped turn as interrupted', { session: sessionId });
    yield {
      type: 'session_status',
      data: { sessionId, terminalReason: 'interrupted', stopWasRequested: true },
    };
  }

  if (!emittedDone) {
    yield {
      type: 'done',
      data: { sessionId },
    };
  }
}
