/**
 * The single ingress for every turn a caller can start (spec
 * `persistent-session-runtime` §3.4, task 2.3).
 *
 * A message stops being a request and becomes a turn HERE, and nowhere else.
 * Before this module the eight callers that could start a turn each reached
 * {@link triggerTurn} (or {@link triggerCommandIntent}) with their own copy of
 * the runtime port, so each one carried its own copy of the race: two of them
 * could decide independently that a session was free. Now they all ask one
 * object, which decides in one place whether a message runs now or waits, and
 * owns the queue it waits in.
 *
 * ## What it decides
 *
 * 1. **The disposition.** A sender asks for `queue`, `steer` or `stage`; the
 *    dispatcher runs the degradation ladder ({@link deliverByDisposition}) and
 *    answers with a {@link MessageDeliveryOutcome} saying what actually happened.
 *    A `steer` reaches a runtime that declares it and joins the live turn; a
 *    `stage` reaches the transcript or folds into the next dispatch; anything a
 *    runtime cannot do degrades to the queue floor and says why. `queue` is the
 *    floor and always available — the server owns the queue.
 * 2. **Whether it runs now.** A message arriving while the session has a turn
 *    open waits in the durable queue ({@link MessageQueueStore}) instead of
 *    starting a second stream beside it — whichever window sent it. A busy
 *    session is a queue, not a refusal (task 2.4). A caller that would rather
 *    not run at all than run late says so with `whenBusy: 'refuse'`.
 * 3. **When a waiting message runs.** On the signal a turn actually ENDED —
 *    `turn_end` on the projector — never on a bare `result`. Dequeuing on
 *    `result` is how every queue-capable tool has shipped the same bug
 *    (OpenCode #15696): a turn can produce a result and keep going, and the
 *    message behind it fires into work that is still running.
 * 4. **Whether it is safe to run.** Never while
 *    {@link SessionStateProjector.hasPendingInteractions} is true. Firing a
 *    queued prompt into an open permission ask is the other known failure
 *    (Gemini #17719, OpenCode #2609). That probe already exists and is already
 *    shared by the write-lock and the stall watchdog; this reuses it rather
 *    than inventing a third notion of "is this session parked on a person".
 *
 * ## What every window sees (task 2.5)
 *
 * A queue nobody can see is not a queue somebody can trust, so every mutation
 * the dispatcher makes — an acceptance, a dispatch — announces the WHOLE queue
 * on the session's durable stream through {@link emitQueueUpdate}, and the
 * snapshot carries the same list on a cold connect. The queue routes announce
 * theirs the same way. A message therefore appears in the second window the
 * moment it is accepted, and disappears from it the moment it runs.
 *
 * The same reasoning is why {@link announceSteerable} lives here. Whether a
 * session can be CUT INTO is a fact about the session, not about one window's
 * request, and a composer offering a steer no turn could take has promised
 * something that cannot happen (DOR-1268). It rides the same durable stream,
 * from the same ingress, and changes at most once in a session's life.
 *
 * Rows survive a restart; the in-memory entries that pump them do not. That gap
 * is closed by {@link adoptQueuedMessages}, which recreates the entries around
 * the surviving rows **by their existing ids** rather than re-offering them
 * through {@link dispatchMessage} — re-offering would enqueue a duplicate beside
 * every original and hand the person their queue twice.
 *
 * ## When a dispatch answers its caller (task 2.4)
 *
 * At ACCEPTANCE, not at the turn's start. A message that can run now still
 * answers when its turn has started, because that answer is available
 * immediately and carries the canonical id; a message that has to wait answers
 * the moment its row is written. Nothing holds an HTTP socket for a turn ahead
 * of it any more, and no caller is told "no" because the session was busy.
 *
 * The write-lock survives this, retargeted: it is no longer "who may send" but
 * the mutex one turn window holds, and its inactivity TTL (`LockActivity`,
 * DOR-782) is untouched — a turn that goes dark still loses the session a TTL
 * later.
 *
 * ## When a message leaves the queue
 *
 * **When a turn actually STARTS with it** — the `turn_start` the projector
 * ingests — and never at the launch ATTEMPT. The two are not the same moment: a
 * launch can be refused by the write-lock (a holder this module does not track)
 * or throw before any turn exists, and a row dropped at the attempt would take
 * words the sender was told were accepted with it. That is the loss DOR-480
 * named, and after task 2.5 it can also hit a row this process ADOPTED rather
 * than accepted, whose sender is long gone and cannot retype it. A message that
 * did not start goes back in line instead.
 *
 * The one exception is a refusing caller — `whenBusy: 'refuse'` or
 * `'refuse-foreign'` — which is never written to the queue AT ALL. A queue row
 * is a person's words waiting to be said, and a refusing caller's message is
 * neither: it is a trigger a machine generated on somebody's behalf, and it has
 * already said it would rather not run than run late. A row for one would put a
 * prompt nobody typed into somebody's composer, and — because rows outlive the
 * process — would still be there to fire days later, into a conversation that
 * ended. So a refusing dispatch lives in memory only and a restart forgets it,
 * which is the right amount of memory for a trigger whose reason may not have
 * survived the wait. It is the same call {@link dispatchCommandIntent} already
 * makes about a `/compact`, for the same reason.
 *
 * A refusing dispatch that was nonetheless ACCEPTED — a `'refuse-foreign'` that
 * waited out its caller's own turn — is bounded rather than abandoned; see
 * {@link returnToQueue}.
 *
 * Rows earlier builds DID write for a room are swept rather than adopted, so the
 * promise holds for installs that predate this; see {@link adoptQueuedMessages}.
 *
 * One shape of refusing wait is not bounded but DISPOSABLE: a blanket-`'refuse'`
 * caller accepted while a FINISHED turn is still closing its stream (DOR-1239) is
 * waiting on a teardown, not on work, so if it cannot run it is dropped rather
 * than given a second chance. See {@link DispatchPlan.transient}.
 *
 * ## A summary the agent asked for (DOR-2732)
 *
 * An agent can ask for its own conversation to be summarized
 * (`compact_my_session`). It asks from INSIDE a turn, and a compaction run
 * mid-turn would summarize the conversation out from under the work that asked,
 * so the request waits here, in {@link scheduleAgentCompaction}, and the pump
 * starts it at the first free moment: after the calling turn has ended, with no
 * turn open (the dispatcher's own, or one only the RUNTIME can see — a Relay
 * delivery or an unattended scheduled run calls it directly), nothing parked on
 * a person, nothing held for background work, no delivery owed, and the
 * write-lock free. A turn only the runtime sees ends without a boundary this
 * module hears, so while one is open the request looks again on a short clock.
 * It waits at most {@link SESSIONS.AGENT_COMPACTION_MAX_WAIT_MS}, then is dropped
 * and its hourly allowance given back, as it is whenever it ends without
 * running (owner blocked it since, launch failed, session gone). One session
 * holds at most one, so asking twice is "already scheduled", never two.
 *
 * **It goes ahead of a person's queued message**, deliberately. It was asked
 * for in the turn that just ended, it is short, and the message behind it is
 * exactly what the summary makes room for: running the message first would
 * hand it the near-full conversation the agent was trying to get out of. The
 * person's message still runs next, in the order they queued it.
 *
 * Like a person's `/compact` it is never a queue row and a restart forgets it:
 * the agent is told it was scheduled, not that it ran, and can ask again.
 *
 * {@link SessionTurnQueue} (DOR-1088) is kept, underneath: it is the
 * intra-process ordering primitive inside `triggerTurn` and this does not
 * replace it. What changed is that no HTTP request waits on it.
 *
 * @module services/session/message-dispatcher
 */
import type { AgentRuntime, RuntimeCapabilities } from '@dorkos/shared/agent-runtime';
import type {
  DispositionDowngradeReason,
  MessageDeliveryOutcome,
  MessageDisposition,
} from '@dorkos/shared/schemas';
import { COMMAND_INTENT_QUEUE_WAIT_MS } from '@dorkos/shared/command-intents';
import { getMessageQueueStore } from './message-queue-store.js';
import {
  onProjectorRekey,
  onProjectorTurnBoundary,
  rekeyProjector,
} from './session-state-projector.js';
import {
  linkSessionId,
  primaryOf,
  queueKeyOf,
  resetSessionKeys,
} from './resolution/session-key-registry.js';
import { onSessionRemoved } from './catalog/session-list-broadcaster.js';
import { holdStagedContext } from './staged-context-store.js';
import type { TriggerTurnDeps, TriggerTurnResult } from './trigger-turn.js';
import { triggerCommandIntent } from './trigger-command-intent.js';
import { emitContextStaged, emitQueueUpdate, emitTurnInput } from './queue-stream-events.js';

export { emitQueueUpdate };
import {
  clearOwedContextWarning,
  noteContextWarningBoundary,
} from './agent-compaction/context-warning.js';
import { SESSIONS } from '../../config/constants.js';
import { isChatClientId } from './chat-messages/chat-client-id.js';
import { logger } from '../../lib/logger.js';
import { getPrivateSessionMessageAcceptanceService } from './private-messages/acceptance.js';
import {
  dispatchMutex,
  inFlight,
  launching,
  orphanedSessions,
  pending,
  pendingCompactions,
  releases,
  runtimeTurns,
  setTurnDepsBuilder,
  sweptWhileLaunching,
  withDispatchMutex,
} from './message-dispatcher/state.js';
import {
  announceSteerable,
  hasOpenTurn,
  isStillProducing,
  refusesOpenTurn,
} from './message-dispatcher/turn-probes.js';
import { launchDispatch } from './message-dispatcher/launch.js';
import { parkDispatch, unwatchedSettle } from './message-dispatcher/park.js';
import { adoptAcceptedPrivateMessages, adoptQueuedMessages } from './message-dispatcher/adopt.js';
import { hasHeldMessage, noteTurnBoundary, schedulePump } from './message-dispatcher/pump.js';
import { clearCompactionTimers } from './message-dispatcher/agent-compaction.js';
import { noteSessionOrphaned } from './message-dispatcher/queue-upkeep.js';
import type {
  DeliverStageOpts,
  DeliverSteerOpts,
  DispatchCommandIntentOpts,
  DispatchMessageOpts,
  DispatchPlan,
  MessageDispatchResult,
  StageDeliveryResult,
  SteerDeliveryResult,
} from './message-dispatcher/types.js';

// The dispatcher's public surface is this module; its parts live in
// `./message-dispatcher/` and are re-exported here so no caller changes.
export {
  isQueuedMessageLaunching,
  onDispatchLifecycle,
  setQueuedChatCeilingResolver,
  withDispatchMutex,
} from './message-dispatcher/state.js';
export { isTurnInFlight } from './message-dispatcher/turn-probes.js';
export {
  adoptAcceptedPrivateMessages,
  adoptQueuedMessages,
  type AdoptQueuedMessagesOpts,
} from './message-dispatcher/adopt.js';
export {
  hasPendingAgentCompaction,
  scheduleAgentCompaction,
  type ScheduleAgentCompactionOpts,
} from './message-dispatcher/agent-compaction.js';
export {
  noteRuntimeTurnClosed,
  noteRuntimeTurnOpen,
  noteTurnBoundary,
} from './message-dispatcher/pump.js';
export {
  cancelPendingDispatch,
  listQueuedMessages,
  noteSessionOrphaned,
  suspendPrivateDispatches,
  sweepOrphanedMessageQueues,
} from './message-dispatcher/queue-upkeep.js';
export type {
  DeliverStageOpts,
  DeliverSteerOpts,
  DispatchCommandIntentOpts,
  DispatchLifecycleEvent,
  DispatchMessageOpts,
  MessageDispatchResult,
  StageDeliveryResult,
  SteerDeliveryResult,
  WhenBusy,
} from './message-dispatcher/types.js';

/**
 * One rung of the degradation ladder: either the disposition LANDED natively (a
 * steer joined the live turn, a stage reached the transcript or folded into the
 * next dispatch) and answers its caller here, or it must DEGRADE to the queue,
 * carrying the reason it could not be delivered as asked.
 */
type LadderRung = { landed: MessageDispatchResult } | { degrade: DispositionDowngradeReason };

/**
 * The degradation ladder (spec `persistent-session-runtime` §P4, task 4.4).
 *
 * ```
 * steer -> supportsSteer AND no pending interaction AND a turn is open
 *            -> deliverIntoTurn({ mode: 'steer' })   (joins the live turn)
 *          else -> queue, and say why
 * stage -> supportsContextStaging AND canStageSession(id) is not false
 *            -> deliverIntoTurn({ mode: 'stage' })   (reaches the transcript)
 *          else -> fold into the next dispatch as additional context
 * ```
 *
 * `queue` is the floor and never reaches here — the server owns the queue, so it
 * is always available. This resolves the two dispositions that need a runtime to
 * declare them, reusing the primitives {@link deliverSteer} and
 * {@link deliverStage} rather than re-deciding what they already decide: the flag
 * is the ROUTING authority (which rung to try), the receipt is the DELIVERY
 * authority (what actually happened).
 *
 * The one downgrade the person is not told about is `session-idle`: a steer on an
 * idle session simply runs now, which lost nothing. Every other degrade sets
 * `degradedBecause` so the sender's window can say what happened instead of it.
 *
 * @param opts - The dispatch request (session, client, content, projector, runtime)
 * @param requested - The disposition asked for; never `queue` (the caller gates that)
 * @param caps - The resolved runtime's declared capabilities
 */
async function deliverByDisposition(
  opts: DispatchMessageOpts,
  requested: Exclude<MessageDisposition, 'queue'>,
  caps: RuntimeCapabilities
): Promise<LadderRung> {
  const { sessionId, clientId, content, projector, runtime } = opts;
  const messageId = crypto.randomUUID();
  const canonicalId = runtime.getInternalSessionId(sessionId) ?? sessionId;
  const queueKey = queueKeyOf(sessionId);
  const landed = (outcome: MessageDeliveryOutcome): LadderRung => ({
    landed: { accepted: true, queued: false, canonicalId, outcome, queuePosition: 0 },
  });

  if (requested === 'steer') {
    // The flag is the routing authority, and it is checked FIRST so a runtime
    // that cannot steer reads `unsupported` rather than whatever the session
    // happens to be doing (AC2). A steer it cannot take rides the queue instead.
    if (!caps.supportsSteer) return { degrade: 'unsupported' };
    // Firing a steer into an open approval or question is the failure the pump's
    // own gate exists for — the agent is parked on a person, and words arriving
    // now are read as their reply. So a steer never reaches a turn parked on an
    // interaction; it queues and waits for the resolution, exactly as a queued
    // message does (AC4). {@link deliverSteer} does not probe this, so the router
    // must.
    if (projector.hasPendingInteractions()) return { degrade: 'pending-interaction' };
    const result = await deliverSteer({ sessionId, clientId, content, messageId, runtime });
    if (result.delivered) return landed({ messageId, requested, applied: 'steer' });
    // Declared the capability but could not deliver it — a declaration arriving
    // ahead of its mechanism is an adapter bug, logged as one, and degraded
    // honestly rather than lost.
    if (result.reason === 'unsupported') {
      logger.error('[MessageDispatcher] runtime declares steer but did not deliver it', {
        runtime: caps.type,
      });
      return { degrade: 'unsupported' };
    }
    // Whatever the refusal was, the server does not get to GUESS what the session
    // is doing — that is the whole of DOR-1315, and the probe below is the only
    // authority on it. `hasOpenTurn` reads the session's own projection: a turn
    // opens at `turn_start` and closes at `turn_end`, which is exactly "something
    // is producing right now".
    const sessionKey = primaryOf(canonicalId);
    const turnIsOpen = hasOpenTurn(sessionKey, projector);
    // SOMEBODY ELSE holds the live write-lock, so this sender may not write into
    // the turn. Ownership is a real, separate fact and gets its own word — but it
    // is NOT on its own evidence that a turn is running: a lock outlives its turn
    // until the release, the SSE close, or `SESSIONS.LOCK_TTL_MS` (five minutes).
    // Asserting a running turn off the lock alone would be the same unchecked
    // claim the ticket exists to remove, one refusal to the left, so the probe
    // gates it — exactly as `refusesOpenTurn` pairs ownership with a producing
    // check rather than trusting the lock by itself.
    if (!result.authorized) {
      return { degrade: turnIsOpen ? 'turn-owned-elsewhere' : 'session-idle' };
    }
    // The caller WAS allowed to steer and the runtime still did not deliver:
    // either it found no turn to join, or the process's input stream had closed
    // under one. Neither answer is evidence about the session either, so the same
    // probe decides:
    //
    // - No turn open — the session was idle, or its turn ended between the click
    //   and the POST. Nothing was there to cut into, so nothing was lost by not
    //   cutting in, and this is the one downgrade the UI stays quiet about (AC3).
    // - A turn IS open and the steer still could not join it — the mechanism that
    //   cuts in is not under this session (claude-code on the resume path), or it
    //   went away mid-turn. Nothing ran early; the words went to the back of the
    //   line, and the sender is told so.
    return { degrade: turnIsOpen ? 'not-steerable' : 'session-idle' };
  }

  // stage. The flag routes: a runtime that declares staging is asked to append to
  // its transcript natively; one that does not folds the words into the next
  // dispatch (ADR-0273) WITHOUT a native attempt that would contradict the flag.
  if (!caps.supportsContextStaging) {
    return landed(foldStage({ sessionId, content, messageId, queueKey, reason: 'unsupported' }));
  }
  // The flag is not the whole truth, for the same reason it was not for a steer
  // (DOR-1268): claude-code's native stage rides a process held between turns, so
  // a session on the resume path — how a default install ships — has no
  // transcript to append to. Asking anyway is what made Add context BOOT an agent
  // and move the session onto the persistent path behind the operator's back
  // (DOR-1307), because the adapter's only way to answer yes was to start one.
  // A runtime whose staging is uniform omits the method and its flag stands.
  if (runtime.canStageSession?.(sessionId) === false) {
    return landed(foldStage({ sessionId, content, messageId, queueKey, reason: 'not-stageable' }));
  }
  // {@link deliverStage} is the native primitive, reused whole. It should deliver
  // natively here (flag true, the session says yes, method present); a fold
  // receipt would mean the adapter declared ahead of its mechanism BOTH times, so
  // it is logged and recorded as one. This is now the ONLY route to that log: a
  // fold the design intends never reaches it (DOR-1307).
  const result = await deliverStage({ sessionId, clientId, content, messageId, runtime });
  if (result.delivered) {
    if (result.foldedBecause !== undefined) {
      // deliverStage ALREADY folded — it held the text and emitted the
      // `context_staged` receipt before returning. Do NOT fold again (that would
      // hold the words twice and send two receipts); only announce the downgrade
      // the fold produced, and say which of the two it was.
      if (result.foldedBecause === 'unsupported') {
        // Declared the capability, said this session could take it, and then
        // could not: an adapter bug, and now the only route to this log. A reap
        // that landed under the gate answers `not-stageable` instead (DOR-1325),
        // because a designed fold logged as a defect buries the real ones.
        logger.error('[MessageDispatcher] runtime declares context staging but had to fold', {
          runtime: caps.type,
        });
      }
      const outcome: MessageDeliveryOutcome = {
        messageId,
        requested,
        applied: 'stage',
        degradedBecause: result.foldedBecause,
      };
      emitQueueUpdate(queueKey, outcome);
      return landed(outcome);
    }
    return landed({ messageId, requested, applied: 'stage' });
  }
  // A DIFFERENT window owns the live turn, so the runtime refused the write. The
  // message waits in line rather than being lost — a rare cross-client race, and
  // named for what it is rather than as a turn that is not there (DOR-1315).
  return { degrade: 'turn-owned-elsewhere' };
}

/**
 * Fold a staged message into the next dispatch and build its receipt — the
 * fallback for a runtime that cannot append to its own transcript (spec
 * `persistent-session-runtime` §2.5, ADR-0273). The words are held
 * ({@link holdStagedContext}) to ride the next turn as a `staged_context` entry,
 * the `context_staged` receipt is emitted so a successful fold is not
 * indistinguishable from a dropped message, and the outcome is announced on the
 * durable stream because no queue row backs a fold.
 *
 * The same two steps {@link deliverStage} takes on its own fallback, reached here
 * by the routing decision instead of by a native attempt. To the person a stage
 * landed either way; the receipt's reason is only how, and it is a DESIGNED fold
 * rather than an adapter bug — nothing here is logged as one.
 *
 * @param opts - The staged message and why it took this route
 */
function foldStage(opts: FoldStageOpts): MessageDeliveryOutcome {
  const { sessionId, content, messageId, queueKey, reason } = opts;
  holdStagedContext(sessionId, content, messageId);
  emitContextStaged(sessionId, content, messageId);
  const outcome: MessageDeliveryOutcome = {
    messageId,
    requested: 'stage',
    applied: 'stage',
    degradedBecause: reason,
  };
  emitQueueUpdate(queueKey, outcome);
  return outcome;
}

/** Inputs for {@link foldStage}. */
interface FoldStageOpts {
  /** Either id a caller might hold (request uuid or canonical). */
  sessionId: string;
  /** The person's staged text, pristine. */
  content: string;
  /** The server-minted correlation id for the staged message. */
  messageId: string;
  /** The session's queue key, for the durable-stream announcement. */
  queueKey: string;
  /**
   * Why the native path was not taken: `unsupported` when the adapter cannot
   * stage at all, `not-stageable` when it can but this session's seam is not
   * live (DOR-1307). Never conflated — the second would otherwise contradict a
   * capability the runtime openly declares.
   */
  reason: Extract<DispositionDowngradeReason, 'unsupported' | 'not-stageable'>;
}

/** Build the runtime-neutral port `triggerTurn` needs from a resolved runtime. */
function turnDeps(runtime: AgentRuntime): TriggerTurnDeps {
  const privateMessages = getPrivateSessionMessageAcceptanceService();
  return {
    acquireLock: (sid, cid, lifecycle, token) => runtime.acquireLock(sid, cid, lifecycle, token),
    releaseLock: (sid, cid, token) => runtime.releaseLock(sid, cid, token),
    sendMessage: (sid, text, opts) => runtime.sendMessage(sid, text, opts),
    // Omitted rather than stubbed when the runtime cannot strand a turn: the
    // absence is what `triggerTurn` reads as "nothing to settle", and a stub
    // answering `false` would only hide which runtimes have the exposure.
    ...(runtime.settleOpenTurn !== undefined
      ? { settleOpenTurn: (sid: string) => runtime.settleOpenTurn!(sid) }
      : {}),
    interruptQuery: (sid) => runtime.interruptQuery(sid),
    // Omitted for the same reason as `settleOpenTurn`: a runtime with no
    // helpers has no answer to give.
    ...(runtime.isHelperWorking !== undefined
      ? { isHelperWorking: (sid: string) => runtime.isHelperWorking!(sid) }
      : {}),
    ...(runtime.liveHelperIds !== undefined
      ? { liveHelperIds: (sid: string) => runtime.liveHelperIds!(sid) }
      : {}),
    getInternalSessionId: (sid) => runtime.getInternalSessionId(sid),
    rekeyProjector: (oldId, newId) => rekeyProjector(oldId, newId),
    getCapabilities: () => runtime.getCapabilities(),
    // Switch now is the marker that a runtime answers the hold handshake.
    answersDispatchHold: runtime.switchWhenReady !== undefined,
    ...(privateMessages
      ? {
          preparePrivateMessage: (receiptId: string) => privateMessages.prepare(receiptId),
          claimPrivateMessage: (
            receiptId: string,
            prepared: Parameters<typeof privateMessages.claim>[1],
            sessionId?: string
          ) =>
            privateMessages.claim(
              receiptId,
              prepared,
              sessionId ? { sessionId, runtime: runtime.type } : undefined
            ),
          cancelPrivateMessage: (receiptId: string, reason: string) =>
            privateMessages.cancel(receiptId, reason),
          isPrivatePreclaimRefusal: (receiptId: string, error: unknown) =>
            privateMessages.isPreclaimRefusal(receiptId, error),
          markPrivateOutcomeUnknown: (receiptId: string, reason: string) =>
            privateMessages.markOutcomeUnknown(receiptId, reason),
        }
      : {}),
  };
}

/**
 * Accept a message and decide when it runs.
 *
 * Resolves at ACCEPTANCE (task 2.4): immediately for a message that has to
 * wait, and — for one that can run now — as soon as its turn has started and the
 * canonical id is known. Nothing here waits for a turn ahead of it.
 *
 * The message is persisted before anything else, so from the moment this returns
 * it survives a refresh, a second window, a failed turn and a restart. It leaves
 * the queue when a turn actually STARTS with it; see the module doc for why that
 * is not the same moment as the launch attempt.
 *
 * @param opts - The message, its sender, the session's projector and runtime
 * @returns The delivery outcome, the queue position it was accepted at, whether
 *   it is waiting, and the `{ accepted, canonicalId }` every caller has read
 */
export async function dispatchMessage(opts: DispatchMessageOpts): Promise<MessageDispatchResult> {
  const { sessionId, clientId, content, projector, runtime } = opts;
  const requested = opts.disposition ?? 'queue';
  const caps = runtime.getCapabilities();
  const sessionKey = primaryOf(runtime.getInternalSessionId(sessionId) ?? sessionId);
  const queueKey = queueKeyOf(sessionId);
  const budgetMs = opts.queueWaitMs ?? SESSIONS.LOCK_TTL_MS;
  const whenBusy = opts.whenBusy ?? 'queue';

  // Before anything is decided: tell every window whether this session can be
  // cut into at all, so the composer stops offering a Steer that could only
  // become a silent follow-up turn (DOR-1268).
  announceSteerable(opts, sessionKey);

  // The degradation ladder (task 4.4). A steer or stage that can land natively
  // does so here and answers its caller without ever becoming a queue row;
  // everything else — and every downgrade — falls through to the queue below,
  // carrying the reason it could not be delivered as asked.
  let degradedBecause: DispositionDowngradeReason | undefined;
  if (requested !== 'queue') {
    const rung = await deliverByDisposition(opts, requested, caps);
    if ('landed' in rung) return rung.landed;
    degradedBecause = rung.degrade;
  }

  // Asked and answered before anything is written: a caller that refuses rather
  // than waits must not leave a row behind for a message it is about to disown.
  const open = inFlight.get(sessionKey);
  if (open && refusesOpenTurn({ whenBusy, open, clientId, sessionKey, projector })) {
    return {
      accepted: false,
      queued: false,
      outcome: {
        messageId: crypto.randomUUID(),
        requested,
        applied: 'queue',
        ...(degradedBecause ? { degradedBecause } : {}),
      },
      queuePosition: 0,
      // The turn this was refused for, named by the same authority that refused
      // it — so a 409 built from this cannot invent a holder (DOR-1239).
      refusedBy: { clientId: open.clientId, since: open.startedAt },
    };
  }

  // Anything a previous server process left queued is picked up first, so this
  // message joins a queue that is whole rather than jumping a person's own
  // older words that nothing else would ever run again.
  adoptQueuedMessages({
    sessionId,
    projector,
    runtime,
    ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
  });
  adoptAcceptedPrivateMessages({
    sessionId,
    projector,
    runtime,
    excludeDocumentMessages: true,
    ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
  });

  // A blanket-`'refuse'` caller that got past the gate with the slot still held
  // got past it for exactly one reason — the turn holding it has ENDED — so it is
  // waiting out a stream that is closing rather than queueing behind work. That
  // is what makes it DISPOSABLE rather than deferrable; see
  // {@link DispatchPlan.transient}. Rowlessness it shares with every refusing
  // caller, below.
  const transient =
    whenBusy === 'refuse' && open !== undefined && !isStillProducing(open, sessionKey, projector);

  // **Only a queueing caller gets a row** (DOR-1242), which subsumes the rowless
  // half of `transient`. A refusing caller's message is a machine-generated
  // trigger, and a row for it is a prompt nobody typed sitting in somebody's
  // composer — one that outlives the process and fires into a conversation that
  // ended days ago. See the module doc; the in-memory plan below is all the
  // memory such a trigger gets.
  const record =
    whenBusy === 'queue'
      ? getMessageQueueStore()?.enqueue({
          ...(opts.messageId !== undefined ? { id: opts.messageId } : {}),
          sessionId: queueKey,
          content,
          clientId,
          disposition: requested,
          context: opts.context ?? null,
        })
      : undefined;
  // **The person first** (spec `spin-off-chats` §3): a message a person (or
  // anything but another chat) queues goes ahead of every row another chat
  // sent, so a busy agent answers its person before its peers. Done as a real
  // move, so the queue a window shows is the order it runs in, and a person can
  // still reorder by hand afterwards.
  if (record && !isChatClientId(clientId)) {
    const store = getMessageQueueStore();
    const firstChatRow = store
      ?.list(queueKey)
      .find((row) => row.id !== record.id && isChatClientId(row.enqueuedBy));
    if (store && firstChatRow) store.move(record.id, { before: firstChatRow.id });
  }
  const messageId = record?.id ?? opts.messageId ?? crypto.randomUUID();
  // A row gives a real position. Without one the answer depends on WHY there is
  // no row: a refusing caller is deliberately rowless and reports `0` (it is on
  // no queue at all, transient or not), while a host with no store wired — as
  // in most unit tests — still has a notional queue of one and
  // reports `1`.
  const queuePosition = record
    ? (getMessageQueueStore()
        ?.list(queueKey)
        .findIndex((row) => row.id === messageId) ?? 0) + 1
    : whenBusy === 'queue'
      ? 1
      : 0;
  const outcome: MessageDeliveryOutcome = {
    messageId,
    requested,
    applied: 'queue',
    ...(degradedBecause ? { degradedBecause } : {}),
  };
  // The acceptance is a queue change like any other, and it carries the outcome:
  // this is what lets the sender's window say "queued, because Codex cannot take
  // messages mid-turn" instead of silently doing something else.
  if (record) emitQueueUpdate(queueKey, outcome);

  const plan: DispatchPlan = {
    sessionId,
    sessionKey,
    clientId,
    content,
    messageId,
    projector,
    runtime,
    budgetMs,
    startedWaitingAt: Date.now(),
    whenBusy,
    answered: false,
    transient,
    turn: opts,
  };

  /** Accepted, waiting: the answer for every message that does not start now. */
  const waiting = (): MessageDispatchResult => ({
    accepted: true,
    queued: true,
    canonicalId: runtime.getInternalSessionId(sessionId) ?? sessionId,
    outcome,
    queuePosition,
  });

  // A session with a turn open takes the message and holds it — whoever sent it.
  // Racing a second stream into one session is what left a live session showing
  // an idle composer (DOR-1088), and refusing the second window instead is what
  // task 2.4 retires.
  if (inFlight.has(sessionKey)) {
    // Told it was accepted, so it can no longer be quietly dropped — including
    // for the refusing caller that reaches here, which is a `'refuse-foreign'`
    // waiting out its own turn. See {@link DispatchPlan.answered}.
    plan.answered = true;
    parkDispatch(plan, unwatchedSettle(plan));
    return waiting();
  }

  // A report the runtime already owes is on its way, and it arrives as a segment
  // of its own (spec `warm-process-lifecycle` D6). The session looks IDLE while
  // that is true — the turn it belonged to has ended and nothing holds the
  // in-flight slot yet — so without this the person's message launches straight
  // into the gap and their words share a turn with a background helper's report.
  // That is the shape of the incident this spec exists to fix, and the gate in
  // `pumpLocked` cannot see it: a message on an idle session never goes through
  // the pump at all.
  //
  // Only a caller that QUEUES waits here. A refusing trigger answers for itself
  // exactly as it always has. The wait is bounded by the runtime's own
  // owed-delivery clock, whose release reaches this module through
  // `onDispatchGateChange`, so a report that never arrives cannot wedge the queue.
  //
  // A message already held for the agent's background work keeps its place the
  // same way (DOR-2065): a later message starting on the idle session would
  // jump it. A refusing trigger is not queued behind it and tries on its own.
  if (
    whenBusy === 'queue' &&
    (runtime.isSegmentPending?.(sessionKey) === true || hasHeldMessage(sessionKey))
  ) {
    plan.answered = true;
    parkDispatch(plan, unwatchedSettle(plan));
    return waiting();
  }

  let result: TriggerTurnResult;
  try {
    result = await launchDispatch(plan, { budgetExhausted: false });
  } catch (err) {
    // The launch threw rather than being refused. `returnToQueue` has already
    // decided what becomes of the message; a caller that asked to refuse still
    // wants the throw, and one that is queueing has an accepted message either
    // way and learns about the failure through `onError`.
    if (whenBusy !== 'queue') throw err;
    return waiting();
  }
  if (result.accepted) return { ...result, queued: false, outcome, queuePosition };
  // The write-lock said no. For a refusing caller that is the answer — and for
  // `'refuse-foreign'` too, because the lock is the one place a caller's OWN
  // turn never refuses it: a same-client trigger waits in `SessionTurnQueue`
  // before it ever reaches the lock, so a refusal here is a stranger by
  // construction. For everybody else the message kept its place in the queue and
  // runs when the holder lets go.
  if (whenBusy !== 'queue') {
    // Named from the lock that just said no, asked under the id it is actually
    // keyed by — the canonical one, which a route does not necessarily hold.
    const held = runtime.getLockInfo(runtime.getInternalSessionId(sessionId) ?? sessionId);
    return {
      accepted: false,
      queued: false,
      outcome,
      queuePosition: 0,
      ...(held ? { refusedBy: { clientId: held.clientId, since: held.acquiredAt } } : {}),
    };
  }
  return waiting();
}

/**
 * Dispatch a runtime-fulfilled command intent through the same ingress a message
 * uses.
 *
 * A `/compact` is not a special case of contention: for claude-code
 * `executeCommandIntent` is literally `sendMessage('/compact')`, so it contends
 * for the session's single writer exactly like a turn and has to be serialized
 * by the same thing. It is deliberately NOT persisted as a queue row — a queue
 * row is a person's words waiting to be said, and a command intent is neither
 * words nor something a person would want to find sitting in their composer.
 *
 * @param opts - The intent, its sender, the session's projector and runtime
 * @returns `{ accepted: false }` when the session is locked by another client
 */
export async function dispatchCommandIntent(
  opts: DispatchCommandIntentOpts
): Promise<{ accepted: boolean }> {
  const { sessionId, clientId, intent, projector, runtime } = opts;
  const sessionKey = primaryOf(runtime.getInternalSessionId(sessionId) ?? sessionId);
  const token = Symbol('dispatcher-command-intent');
  // A `/compact` opens a turn like any other, so the same window may be offered a
  // Steer while it runs — and must only be offered one this session could take
  // (DOR-1268).
  announceSteerable(opts, sessionKey);
  // Claim the session only if nothing already holds it. A compact arriving on a
  // busy session answers for itself at the chain and the lock; overwriting the
  // running turn's claim here would tell the pump that turn had ended.
  //
  // `sawTurnStart` stays false for the whole run, which is the conservative
  // answer and the deliberate one: a command intent reports no turn start to
  // this module, so nothing could ever flip it, and a slot that never claims to
  // have started reads as producing for as long as it is held
  // ({@link isStillProducing}). A refusing caller therefore keeps meeting a
  // refusal across a compact — which is what a compact is.
  if (!inFlight.has(sessionKey))
    inFlight.set(sessionKey, { clientId, token, startedAt: Date.now(), sawTurnStart: false });
  const clearIfOurs = (): void => {
    if (inFlight.get(sessionKey)?.token === token) inFlight.delete(sessionKey);
    schedulePump(sessionKey);
  };
  try {
    const result = await triggerCommandIntent({
      sessionId,
      clientId,
      intent,
      ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
      ...(opts.instructions !== undefined ? { instructions: opts.instructions } : {}),
      ...(opts.permissionCeiling !== undefined
        ? { permissionCeiling: opts.permissionCeiling }
        : {}),
      ...(opts.stallTimeoutMs !== undefined ? { stallTimeoutMs: opts.stallTimeoutMs } : {}),
      projector,
      deps: {
        acquireLock: (sid, cid, lifecycle, tok) => runtime.acquireLock(sid, cid, lifecycle, tok),
        releaseLock: (sid, cid, tok) => runtime.releaseLock(sid, cid, tok),
        executeCommandIntent: (sid, i, o) => runtime.executeCommandIntent(sid, i, o),
        // Omitted rather than stubbed, for the reason `turnDeps` gives.
        ...(runtime.settleOpenTurn !== undefined
          ? { settleOpenTurn: (sid: string) => runtime.settleOpenTurn!(sid) }
          : {}),
        interruptQuery: (sid) => runtime.interruptQuery(sid),
        getInternalSessionId: (sid) => runtime.getInternalSessionId(sid),
      },
      queueWaitMs: opts.queueWaitMs ?? COMMAND_INTENT_QUEUE_WAIT_MS,
      ...(opts.boundaryTag !== undefined ? { boundaryTag: opts.boundaryTag } : {}),
      onError: opts.onError,
      // The run is detached and the 202 has gone out long before it ends, so
      // this is the only moment the dispatcher can learn the session is free.
      onSettled: clearIfOurs,
    });
    // A refused run never settles at all, so nothing else will hand it back.
    if (!result.accepted) clearIfOurs();
    // A summary is under way, so a context warning owed from the reading before
    // it would describe a conversation that no longer exists (DOR-2732).
    else if (intent === 'compact') clearOwedContextWarning(sessionKey);
    return result;
  } catch (err) {
    clearIfOurs();
    throw err;
  }
}

/**
 * Steer a message into a session's live turn, through the same ingress and the
 * same authorization a turn passes (spec `persistent-session-runtime` §2.3,
 * task 4.1).
 *
 * **A steer is a WRITE.** A live turn is owned by exactly one client — the one
 * holding its write-lock — and injecting a message into that turn is as much a
 * write as starting it. So the authorization is the identical gate `sendMessage`
 * passes, asked of the identical authority: the runtime's real write-lock, via
 * {@link AgentRuntime.isLocked}. It is deliberately NOT the dispatcher's
 * {@link inFlight} mirror, which is lossy — a budget-exhausted launch holds the
 * real lock from its acquire, but claims `inFlight` only once its turn starts
 * ({@link launchDispatch}), so `inFlight` can be empty while the lock is held,
 * and gating on it would let ANY
 * client — including one that could not send right now — steer that turn.
 * `isLocked(key, clientId)` closes that hole: true only when a DIFFERENT client
 * holds the live lock, false for the owner, and false when no turn is open (the
 * lock is free and every client may send, so the runtime just reports
 * `no-open-turn`).
 *
 * Held under the dispatch mutex so the lock check and the delivery cannot
 * straddle a turn ending: the same mutex every turn boundary takes, so a steer
 * racing one does not interleave with it. A REAP is not serialized by it (see
 * {@link withDispatchMutex}) — a steer that races one reads `no-open-turn` from
 * the spent pump, which is the honest answer either way.
 *
 * This is the ONE server path to a runtime's `deliverIntoTurn` for a steer —
 * one of exactly two, the other being {@link deliverStage} for a stage — just
 * as {@link dispatchMessage} is the one path to `sendMessage`. The
 * single-ingress audit (`dispatcher-single-ingress.test.ts`) holds both to
 * that, so no caller can reach the write around this gate.
 *
 * @param opts - The session, the steering client, the message, and the runtime
 * @returns Whether the caller was authorized, whether the steer was delivered,
 *   and why not when it was not
 */
export async function deliverSteer(opts: DeliverSteerOpts): Promise<SteerDeliveryResult> {
  const { sessionId, clientId, runtime } = opts;
  // The lock is keyed by the canonical id when one is known — the same `turnKey`
  // `triggerTurn` acquires it under — so ask under that id, not the request uuid.
  const lockKey = runtime.getInternalSessionId(sessionId) ?? sessionId;
  const sessionKey = primaryOf(lockKey);
  return withDispatchMutex(sessionKey, async () => {
    // A DIFFERENT client holds the live write-lock: this client could not send
    // now, so it may not steer now. The only refusal that is authorization's.
    if (runtime.isLocked(lockKey, clientId)) {
      return { authorized: false, delivered: false };
    }
    // A runtime that declares neither steer nor stage simply omits the method;
    // the ladder degrades around a missing implementation rather than failing.
    if (runtime.deliverIntoTurn === undefined) {
      return { authorized: true, delivered: false, reason: 'unsupported' };
    }
    const result = await runtime.deliverIntoTurn(sessionId, opts.content, {
      mode: 'steer',
      messageId: opts.messageId,
      ...(opts.additionalContext !== undefined
        ? { additionalContext: opts.additionalContext }
        : {}),
    });
    // A delivered steer reached the model but carries no turn-shaped events of
    // its own — mint the `turn_input` carrier so the person's words render
    // inline in the open turn and survive a reconnect and a cold hydrate. Only
    // on delivery: a degraded or refused steer joined no turn, so there is
    // nothing to show inside one (task 4.3). Under the same mutex as the lock
    // check, so the ingest cannot straddle a turn ending.
    if (result.delivered) emitTurnInput(sessionKey, opts.content, opts.messageId);
    return { authorized: true, ...result };
  });
}

/**
 * Stage a message onto a session WITHOUT provoking a turn, through the same
 * ingress and the SAME authorization a steer and a turn pass (spec
 * `persistent-session-runtime` §2.5, task 4.2).
 *
 * **A stage is a WRITE**, so its authorization is identical to {@link
 * deliverSteer}'s: the runtime's real write-lock via {@link
 * AgentRuntime.isLocked}, refusing only when a DIFFERENT client owns the live
 * turn. The one difference from a steer is what a FREE lock means. A steer with
 * no open turn has nothing to join, and the runtime answers `no-open-turn` (its
 * own vocabulary, not the downgrade reason a person reads). A stage needs no open
 * turn at all: a free lock is the ordinary case, and a cold session is warmed so
 * the message can reach a transcript. So this never reports `no-open-turn`, and
 * its ONE undelivered path is the lock refusal above — which the ladder reports
 * as `turn-owned-elsewhere` when a turn is really open under it (DOR-1315).
 *
 * **Native, then fallback.** The runtime is asked to stage natively
 * ({@link AgentRuntime.deliverIntoTurn} with `mode: 'stage'`). A runtime that
 * cannot — it does not implement the method, or answers `unsupported` — degrades
 * to the fold-into-next fallback: the text is held ({@link holdStagedContext})
 * and rides the next dispatch as a `staged_context` entry, so nothing the person
 * staged is lost. Both paths emit the same `context_staged` receipt. This mirrors
 * the way {@link deliverSteer} degrades around a missing implementation rather
 * than reading a capability flag — the flag is the routing layer's concern (task
 * 4.4), not this gate's.
 *
 * Held under the dispatch mutex so the lock check and the delivery cannot
 * straddle a turn boundary, and so a stage that warms a cold session does not
 * interleave with a dispatch on the same session. A REAP is not serialized by it
 * ({@link withDispatchMutex}), which is why the fallback below re-asks the
 * session whether it could still have staged (DOR-1325).
 *
 * This is the ONE server path to a runtime's `deliverIntoTurn` for a stage, the
 * same single ingress {@link deliverSteer} is for a steer — the single-ingress
 * audit holds both to it.
 *
 * @param opts - The session, the staging client, the message, and the runtime
 * @returns Whether the caller was authorized, whether the stage was delivered,
 *   whether it went via the fallback, and why not when it did not land
 */
export async function deliverStage(opts: DeliverStageOpts): Promise<StageDeliveryResult> {
  const { sessionId, clientId, runtime, content, messageId } = opts;
  // Keyed exactly as `deliverSteer` and `triggerTurn` key it — the canonical id
  // when known — so the lock check asks the same authority a turn would.
  const lockKey = runtime.getInternalSessionId(sessionId) ?? sessionId;
  const sessionKey = primaryOf(lockKey);
  return withDispatchMutex(sessionKey, async () => {
    // A DIFFERENT client holds the live write-lock: this client could not send
    // now, so it may not stage now. A FREE lock is NOT a refusal — a stage needs
    // no open turn — which is the whole difference from a steer's gate.
    if (runtime.isLocked(lockKey, clientId)) {
      return { authorized: false, delivered: false };
    }
    const native = runtime.deliverIntoTurn
      ? await runtime.deliverIntoTurn(sessionId, content, {
          mode: 'stage',
          messageId,
          ...(opts.additionalContext !== undefined
            ? { additionalContext: opts.additionalContext }
            : {}),
        })
      : { delivered: false, reason: 'unsupported' as const };
    if (native.delivered) {
      emitContextStaged(sessionId, content, messageId);
      return { authorized: true, delivered: true };
    }
    if (native.reason === 'unsupported') {
      // The runtime cannot append to its own transcript. Hold the person's words
      // and fold them into the next dispatch (ADR-0273); the same receipt goes
      // out, because to the person a stage landed either way.
      //
      // WHY THE SESSION IS ASKED AGAIN, AND ONLY NOW (DOR-1325). The router asks
      // `canStageSession` before this mutex is taken, and the idle reaper does
      // NOT take this mutex — so a reap can land in that window, and the refusal
      // above is then the designed answer of a session whose seam has gone,
      // rather than an adapter that declared ahead of its mechanism. Asking
      // AFTER the refusal closes the window by construction: any reap that
      // happened, whenever it happened, is visible in this answer. Asking again
      // before the native call would only move the race.
      const stillStageable = runtime.canStageSession?.(sessionId) !== false;
      holdStagedContext(sessionId, content, messageId);
      emitContextStaged(sessionId, content, messageId);
      return {
        authorized: true,
        delivered: true,
        foldedBecause: stillStageable ? 'unsupported' : 'not-stageable',
      };
    }
    // A transient the runtime named (a stream that closed under a warm process, a
    // boundary a cwd failed). Report it; the caller decides what to say. Not
    // folded into the fallback — that is for a runtime that CANNOT stage, not one
    // that momentarily could not.
    return { authorized: true, ...native };
  });
}

/**
 * Drop every scrap of in-memory dispatcher state.
 *
 * @internal Exported for testing only — a dispatcher outlives one test file.
 */
export function resetMessageDispatcher(): void {
  for (const entry of pending.values()) clearTimeout(entry.timer);
  inFlight.clear();
  releases.clear();
  runtimeTurns.clear();
  pending.clear();
  for (const entry of pendingCompactions.values()) clearCompactionTimers(entry);
  pendingCompactions.clear();
  launching.clear();
  resetSessionKeys();
  dispatchMutex.clear();
  orphanedSessions.clear();
  sweptWhileLaunching.clear();
}

// Wired on import rather than from the composition root, deliberately. The
// dispatcher is only correct while it is listening: a host that forgot the
// wiring — including a test harness — would get a
// queue that accepts messages and never runs them, which is the worst possible
// way to fail. There is nothing to configure and nothing to tear down, so
// there is nothing for a root to decide.
setTurnDepsBuilder(turnDeps);
onProjectorTurnBoundary(noteTurnBoundary);
// The early context warning reads each turn's final reading (DOR-2732). Wired
// here for the same reason, and after the pump's listener, which only defers.
onProjectorTurnBoundary(noteContextWarningBoundary);
onProjectorRekey(linkSessionId);
onSessionRemoved(noteSessionOrphaned);
