/**
 * Starting one accepted message's turn: claim the session, hand the message to
 * `triggerTurn`, take it off the queue once the turn is really running, and
 * route every way the launch can end.
 *
 * @module services/session/message-dispatcher/launch
 */
import {
  getMessageQueueStore,
  setQueuedWaitingOn,
  type QueuedMessageRecord,
} from '../message-queue-store.js';
import { triggerTurn, type TriggerTurnResult } from '../trigger-turn.js';
import { emitQueueUpdate } from '../queue-stream-events.js';
import { TURN_NO_ANSWER } from '../launch/turn-not-started.js';
import { noteRoomTurnWords } from '../../core/turn-power/outside-words.js';
import {
  forgetOwnersCleanSend,
  noteOwnersCleanSend,
} from '../../core/turn-power/held-chat-mark.js';
import { isExtensionClientId } from '../../extensions/agent-send/extension-client-id.js';
import {
  getPrivateSessionMessageAcceptanceService,
  PrivateSessionMessageRefusalError,
} from '../private-messages/acceptance.js';
import {
  emitLifecycle,
  inFlight,
  launchCarriesHold,
  launchCarriesWords,
  launchCeiling,
  launching,
  pending,
  privateLaunches,
  releases,
  runtimeTurns,
  steering,
  sweptWhileLaunching,
  buildTurnDeps,
} from './state.js';
import {
  holdInQueue,
  parkDispatch,
  reparkBehindLiveRun,
  returnToQueue,
  unwatchedSettle,
} from './park.js';
import { rearmLockWaiters, schedulePump } from './pump.js';
import {
  forgetRecordedHolds,
  holdForPause,
  forgetRuntimeMessageId,
  holdStartedForPause,
  pausedAgentOfPlan,
  runtimeMessageIdFor,
} from './pause-hold.js';
import { logger } from '../../../lib/logger.js';
import type { PausedAgentRef } from '../../mesh/pause/agent-pause.js';
import type { DispatchPlan, InFlightTurn } from './types.js';
import { joinWaitingChatRows } from './join-chat-rows.js';
import { isOwnersCleanSend } from './owner-send.js';
import { withKeptCeiling } from './carried-limits.js';
import { feedRun, launchVerdictOf } from './run-feed.js';
import { forgetHeldRuns, holdRun, releaseRun } from '../turn-port/facts.js';
import {
  putBackForPause,
  recordTurnDelivered,
  recordTurnSettled,
  recordTurnStart,
} from './run-turn.js';

/** How many times a recovered row may fail to start before it is given up (DOR-3287). */
export const RECOVERED_START_TRIES = 3;

/** Failed starts of recovered rows, by row id; kept across adoptions, cleared once one runs. */
const recoveryFailures = new Map<string, number>();

/**
 * Forget every recovered row's failed starts, and which pause holds were recorded.
 *
 * @internal Exported for testing only, through `resetMessageDispatcher`.
 */
export function forgetLaunchMemory(): void {
  recoveryFailures.clear();
  forgetRecordedHolds();
  forgetHeldRuns();
  steering.clear();
}

/**
 * Count one failed start of a recovered row. Rows this process accepted itself
 * are never counted: their sender is still here to see the failure.
 *
 * @param plan - The message whose start failed
 */
function countRecoveredFailure(plan: DispatchPlan): void {
  if (!plan.recovered) return;
  recoveryFailures.set(plan.messageId, (recoveryFailures.get(plan.messageId) ?? 0) + 1);
}

/**
 * Give up on a recovered row that has failed to start {@link RECOVERED_START_TRIES}
 * times: take it off the queue and tell its sender it will not run. Without this
 * a row whose chat was deleted while the server was down retries, and warns, on
 * every health tick for the life of the process.
 *
 * @param plan - The message about to start, or whose start just failed
 * @returns True when it was given up, so the caller neither launches nor re-parks it
 */
function giveUpIfSpent(plan: DispatchPlan): boolean {
  if (!plan.recovered || (recoveryFailures.get(plan.messageId) ?? 0) < RECOVERED_START_TRIES) {
    return false;
  }
  recoveryFailures.delete(plan.messageId);
  pending.delete(plan.messageId);
  setQueuedWaitingOn(plan.messageId, undefined);
  // Its run is cancelled with the row: from `queued` before a launch, from `starting` after one.
  if (getMessageQueueStore()?.remove(plan.messageId, undefined, 'cancelled')) {
    emitQueueUpdate(plan.sessionKey);
  }
  logger.warn('[MessageDispatcher] gave up on a recovered message that kept failing to start', {
    sessionId: plan.sessionKey,
    messageId: plan.messageId,
    tries: RECOVERED_START_TRIES,
  });
  emitLifecycle({ phase: 'dropped', messageId: plan.messageId, reason: 'session_gone' });
  plan.turn.onSettled?.('failed');
  return true;
}

/**
 * Start one accepted message's turn: claim the session, hand it to
 * {@link triggerTurn}, and take it off the queue once the turn is really
 * running.
 *
 * Shared by every way a message reaches this point — accepted onto an idle
 * session, released from the queue by the pump, or a row
 * {@link adoptQueuedMessages} recovered after a restart — so all of them leave
 * the queue on the same signal, announce that the queue moved, and hand the
 * session back the same way however they got here.
 *
 * **The message leaves the queue at `turn_start`, not here at the attempt.** See
 * the module doc: an attempt the write-lock refuses must leave the words where
 * they were, and {@link returnToQueue} puts the message back in line.
 *
 * @param plan - The message, its session, and the turn's passthroughs
 * @param opts.budgetExhausted - The wait bound fired: launch anyway, with no
 *   budget left and WITHOUT claiming the in-flight slot, so this message meets
 *   the write-lock exactly as a stranger would rather than telling the pump the
 *   turn ahead of it had ended. It claims the slot once its turn starts.
 */
export function launchDispatch(
  plan: DispatchPlan,
  opts: { budgetExhausted: boolean }
): Promise<TriggerTurnResult> {
  const signal = plan.turn.privateDispatchSignal;
  const started = launchDispatchInner(plan, opts);
  if (!signal) return started;
  const launches = privateLaunches.get(signal) ?? new Set<Promise<TriggerTurnResult>>();
  privateLaunches.set(signal, launches);
  const completion = started.finally(() => {
    launches.delete(completion);
    if (launches.size === 0) privateLaunches.delete(signal);
  });
  launches.add(completion);
  return completion;
}

/**
 * The launch itself, for {@link launchDispatch}, which only tracks it against a
 * protected host lifetime.
 *
 * @param plan - The message, its session, and the turn's passthroughs
 * @param opts.budgetExhausted - See {@link launchDispatch}
 */
export function launchDispatchInner(
  plan: DispatchPlan,
  opts: { budgetExhausted: boolean }
): Promise<TriggerTurnResult> {
  if (plan.turn.privateDispatchSignal?.aborted)
    return Promise.resolve({ accepted: false, suspended: true });
  if (giveUpIfSpent(plan)) return Promise.resolve({ accepted: false });
  // Its agent is paused: keep the row and start nothing, rather than feed it to
  // a turn the pause refuses and lose it at that turn's start (DOR-4327).
  const paused = pausedAgentOfPlan(plan);
  if (paused) {
    feedRun(plan, 'pause hold', (feed, runId) => feed.waiting(runId, 'paused'));
    holdForPause(plan, paused);
    // The messages behind it meet the same check and are held too, so none is
    // left armed in memory where a resume could not reach it.
    schedulePump(plan.sessionKey);
    return Promise.resolve({ accepted: false });
  }
  // One writer per chat (spec `turns-survive-restarts` §4.7, §5): a launch that
  // finds another run of its chat `started` or `running` in the record waits
  // for that run to settle, whichever path launched it. The in-memory slot
  // cannot say this alone: a runtime's own turn, a turn whose write-lock went
  // quiet past its timeout, or a launch still in `SessionTurnQueue` may hold
  // the chat with no slot. Otherwise the run is `starting` now (transition 4).
  const verdict = launchVerdictOf(plan);
  if (verdict.kind === 'busy') {
    // A known gap, accepted (spec §4.7, beside DOR-2346): between a Claude Code
    // SDK rebind and the running turn's next event, the in-memory slot can be
    // keyed under the new SDK id while the turn's settle wakes the old key, so
    // a launch re-parked here waits out its bound.
    reparkBehindLiveRun(plan, opts.budgetExhausted, verdict.retryAt);
    return Promise.resolve({ accepted: false });
  }
  const { sessionKey, clientId, messageId } = plan;
  let turnStarted = false;
  // Set when a pause landed between the check above and this turn's start: the
  // turn will be refused, so its row is kept and held once it settles.
  let heldByPause: PausedAgentRef | undefined;
  // The row as this turn's start took it off the queue (DOR-4353).
  let startedRow: QueuedMessageRecord | undefined;
  const remainingMs = opts.budgetExhausted
    ? 0
    : Math.max(0, plan.budgetMs - (Date.now() - plan.startedWaitingAt));
  const token = Symbol('dispatcher-turn');
  const releasesAtStart = releases.get(sessionKey) ?? 0;
  const claim: InFlightTurn = { clientId, token, startedAt: Date.now(), sawTurnStart: false };
  if (!opts.budgetExhausted) inFlight.set(sessionKey, claim);
  // Held from here until this launch is done with the message, whichever way it
  // ends. Every exit below routes through `clearIfOurs` — the sync throw, the
  // rejection, the refusal, and the settle — so there is no path that leaves an
  // id behind, and each of them hands the message back to `pending` (or to
  // nobody, if it ran) in the same synchronous beat.
  launching.add(messageId);
  joinWaitingChatRows(sessionKey, messageId);
  const clearIfOurs = (opts?: { keepHold?: true }): void => {
    // A launch that started no turn: its words go back in line (transition 8),
    // unless something on the way out already cancelled its run.
    if (!turnStarted) feedRun(plan, 'back in line', (feed, runId) => feed.backInLine(runId));
    if (plan.runId !== undefined && opts?.keepHold !== true) releaseRun(plan.runId);
    launching.delete(messageId);
    if (inFlight.get(sessionKey)?.token === token) inFlight.delete(sessionKey);
    schedulePump(sessionKey);
  };
  const { turn } = plan;
  // A sender's outside words go with its message into the turn it starts (DOR-4029), noted
  // before the turn runs so memory, the browser and the narrowing gate read them on its first
  // call. Only ever adds: a refused launch leaves the chat noted, the stricter reading. Under the
  // runtime's own id too: a chat renamed on an earlier turn, sent to by its born id, runs its tool
  // calls under the id it was renamed to (Security M1 on #3587).
  // The note is the turn's, not the chat's: the owner's own clean send ends it (DOR-4693). Every
  // other turn keeps it, and a room turn sets and ends its own (`room-turn-runner.ts`).
  const carriesWords = launchCarriesWords(clientId, messageId);
  // What the row kept of the turn's limits (DOR-4350): a plan rebuilt after a pause or a restart
  // carries none of its own, so the row's go with it. They only add.
  const kept = getMessageQueueStore()?.get(messageId)?.carriedLimits ?? null;
  const ownersClean = isOwnersCleanSend(plan);
  // The one verdict the turn seam reads to clear a held chat (DOR-4515), by the id the runtime gets.
  // Every launch decides afresh, so a verdict never outlives the attempt it was found for.
  if (ownersClean) noteOwnersCleanSend(runtimeMessageIdFor(messageId), plan.sessionId);
  else forgetOwnersCleanSend(runtimeMessageIdFor(messageId));
  if (carriesWords || ownersClean) {
    const canonical = plan.runtime.getInternalSessionId(plan.sessionId) ?? plan.sessionId;
    for (const id of new Set([plan.sessionId, sessionKey, canonical])) {
      noteRoomTurnWords(id, carriesWords);
    }
  }
  let started: Promise<TriggerTurnResult>;
  // This process holds the run's owner until the launch is done with it: every
  // exit releases it through `clearIfOurs`, the settle only after its run ended.
  if (plan.runId !== undefined) holdRun(plan.runId);
  try {
    started = triggerTurn({
      sessionId: plan.sessionId,
      ...(turn.turnStarter !== undefined ? { turnStarter: turn.turnStarter } : {}),
      clientId,
      // The ROW's words, not the ones the plan was built with: a message that
      // waited may have been reworded while it waited, and running what the
      // person first typed instead of what they left in the queue would make
      // the edit a lie.
      content: getMessageQueueStore()?.get(messageId)?.content ?? plan.content,
      ...(turn.cwd !== undefined ? { cwd: turn.cwd } : {}),
      ...(turn.context ? { context: turn.context } : {}),
      ...(turn.roomContext ? { roomContext: turn.roomContext } : {}),
      ...(turn.roomTurn ? { roomTurn: turn.roomTurn } : {}),
      ...(turn.forAgent !== undefined ? { forAgent: turn.forAgent } : {}),
      ...(turn.seedContext ? { seedContext: turn.seedContext } : {}),
      ...(turn.approvalVerdict ? { approvalVerdict: turn.approvalVerdict } : {}),
      ...(turn.systemPromptAppend !== undefined
        ? { systemPromptAppend: turn.systemPromptAppend }
        : {}),
      ...(turn.additionalDirectories !== undefined
        ? { additionalDirectories: turn.additionalDirectories }
        : {}),
      ...(turn.prepareLaunch !== undefined ? { prepareLaunch: turn.prepareLaunch } : {}),
      ...(turn.accountHint ? { accountHint: turn.accountHint } : {}),
      ...(turn.settings ? { settings: turn.settings } : {}),
      ...(turn.newSessionPermissionMode !== undefined
        ? { newSessionPermissionMode: turn.newSessionPermissionMode }
        : {}),
      ...(() => {
        const ceiling = launchCeiling(
          clientId,
          messageId,
          withKeptCeiling(turn.permissionCeiling, kept?.ceiling),
          getMessageQueueStore()?.get(messageId)?.heldToDefault === true
        );
        return ceiling !== undefined ? { permissionCeiling: ceiling } : {};
      })(),
      // A continuation's hold marks nothing only while its words are the system's own: once
      // somebody rewords the row (from Wi-Fi, say), its hold is theirs and marks (DOR-3203).
      ...(turn.continuationHold &&
      (getMessageQueueStore()?.get(messageId)?.content ?? plan.content) === plan.content
        ? { continuationHold: true as const }
        : {}),
      // A mark the turn carries on from work it continues: it marks, and lowers nothing (DOR-3561).
      // A mini app's message carries one too, read from who queued the row (DOR-4594).
      ...(turn.carriedMarks?.outsider === true ||
      kept?.outsider === true ||
      launchCarriesHold(clientId, messageId) ||
      isExtensionClientId(clientId)
        ? { carriedMarks: { outsider: true as const } }
        : {}),
      ...(turn.stallTimeoutMs !== undefined ? { stallTimeoutMs: turn.stallTimeoutMs } : {}),
      ...(turn.privateReceiptId !== undefined ? { privateReceiptId: turn.privateReceiptId } : {}),
      ...(turn.privateDispatchSignal ? { privateDispatchSignal: turn.privateDispatchSignal } : {}),
      ...(turn.unattended || kept?.unattended === true ? { unattended: true } : {}),
      // The turn is running: THIS is the instant the message stops waiting, and
      // every window is told so in the same beat — a queue chip that outlives
      // the message it stands for is a lie about what is still waiting.
      onTurnStart: (seq) => {
        turnStarted = true;
        // The run is `started` and the row out of line FIRST, before the pause
        // check below (§4.7): whatever a pause then does to this turn starts
        // from a turn the record knows started.
        recordTurnStart(plan, seq);
        // Paused while this launch was under way: the pause refuses the turn, so
        // the row is kept and nobody is told it started.
        heldByPause = pausedAgentOfPlan(plan);
        if (heldByPause) return;
        recoveryFailures.delete(messageId);
        if (turn.privateReceiptId !== undefined) {
          emitQueueUpdate(sessionKey);
        } else {
          // Kept, so a pause that cuts the turn before the agent reads it can
          // put the row back (DOR-4353), even once delivery deleted it.
          startedRow = getMessageQueueStore()?.get(messageId);
          forgetRuntimeMessageId(messageId);
          if (startedRow) emitQueueUpdate(sessionKey);
        }
        // A launch the wait bound forced claimed no slot, so it met the lock as
        // a stranger would. Running now, it IS the session's turn, and claims
        // the slot: otherwise the next message reads the session as idle and
        // launches into it, waiting out the lock TTL inside its own dispatch.
        // A turn the agent started keeps its claim, as it does against every
        // other claimant ({@link noteRuntimeTurnOpen}).
        const held = inFlight.get(sessionKey);
        if (opts.budgetExhausted && (!held || held.token !== runtimeTurns.get(sessionKey)))
          inFlight.set(sessionKey, claim);
        // The turn is on the projector now, so the projector — not this slot —
        // becomes the authority on whether it is still producing
        // ({@link isStillProducing}). Only for OUR launch: a stale settle must
        // not annotate a newer turn's slot.
        const slot = inFlight.get(sessionKey);
        if (slot?.token === token) slot.sawTurnStart = true;
        sweptWhileLaunching.delete(messageId);
        emitLifecycle({ phase: 'started', messageId, sessionId: sessionKey });
        turn.onTurnStart?.(seq);
      },
      projector: plan.projector,
      deps: buildTurnDeps(plan.runtime),
      queueWaitMs: remainingMs,
      // A fresh id after a pause cut this row's turn; the row keeps its own (DOR-4353).
      messageId: runtimeMessageIdFor(messageId),
      // The runtime has the words: the row goes, except while a pause may
      // still put it back (§4.7, transition 10).
      onDelivered: () => recordTurnDelivered(plan, heldByPause === undefined),
      // Past this, no pause can put the turn back, so its "finished" is told
      // at `turn_end` rather than at settle (§4.7). Not while a pause holds it.
      onActed: () => {
        if (heldByPause === undefined) feedRun(plan, 'acted', (feed, id) => feed.turnActed(id));
      },
      onError: turn.onError,
      onSettled: (turnOutcome, reason, agentActed) => {
        // This turn has let go of the write-lock, so whatever the lock refused
        // may try again now. Its boundary is no substitute: a turn that ends and
        // then drains background work announces `turn_end` long before it lets
        // go, and a message refused in between would otherwise wait out its
        // whole wait bound behind a free session.
        rearmLockWaiters(sessionKey);
        // Ended before it began: the row stays queued, so this counts as a failed
        // start, and the next adoption gives it up once it has failed enough.
        if (turnOutcome === 'failed' && !turnStarted) countRecoveredFailure(plan);
        if (heldByPause) {
          if (turnOutcome === 'failed') {
            // Back in line, held: transition 14, or 15 once delivered (§4.7).
            putBackForPause(plan);
            holdForPause(plan, heldByPause);
            clearIfOurs();
            return;
          }
          // Lifted again before the turn spoke, so it ran: the row goes now,
          // with the run's end below.
        } else if (startedRow && agentActed === false && holdStartedForPause(plan, startedRow)) {
          // Paused after the turn started but before the agent did anything:
          // its row is back on the queue, held, and its sender hears `held`.
          clearIfOurs();
          return;
        }
        // Held until its run has ended, so a receipt settle that throws can
        // never leave a live run nobody in this process holds.
        clearIfOurs({ keepHold: true });
        try {
          if (turn.privateReceiptId !== undefined) {
            getPrivateSessionMessageAcceptanceService()?.settle(turn.privateReceiptId, turnOutcome);
          }
        } finally {
          // The status moves now, at settle, never at `turn_end` (§4.7).
          if (turnStarted) recordTurnSettled(plan, turnOutcome, reason);
          if (plan.runId !== undefined) releaseRun(plan.runId);
        }
        emitLifecycle({
          phase: 'settled',
          messageId,
          sessionId: sessionKey,
          outcome: turnOutcome,
          ...(reason !== undefined ? { reason } : {}),
        });
        // Only the lifecycle hears "nobody read it". To a caller, a reason means
        // the turn was refused, and this one ran (a beat records a refusal).
        turn.onSettled?.(turnOutcome, reason === TURN_NO_ANSWER ? undefined : reason);
      },
    });
  } catch (err) {
    // What becomes of the words is decided before the slot goes back, so a
    // cancel writes 9 and only a run going back in line writes 8.
    endFailedStart(plan, err);
    clearIfOurs();
    // Rejected with what was thrown, unchanged: `triggerTurn` throws typed
    // errors its callers narrow on, and re-wrapping would cost them that.
    return Promise.reject(err as Error);
  }
  return started.then(
    (result) => {
      if (result.held) {
        // Parked BEFORE the slot is handed back, so the pump that hand-back
        // schedules already finds the message held rather than launching it
        // straight back into the same answer.
        if (plan.whenBusy === 'queue') holdInQueue(plan, result.held);
        else returnToQueue(plan);
        // Released while this attempt was out: the release found nothing
        // parked, so it is applied now rather than lost until the next one.
        if ((releases.get(sessionKey) ?? 0) !== releasesAtStart) {
          const parked = pending.get(messageId);
          if (parked) parked.held = undefined;
        }
        clearIfOurs();
        return result;
      }
      // Whatever happens now, it is no longer waiting on background work.
      if (setQueuedWaitingOn(messageId, undefined)) emitQueueUpdate(sessionKey);
      if (result.suspended) {
        clearIfOurs();
        return result;
      }
      if (result.deferred) {
        // Install the deadline before releasing the slot schedules another pump.
        try {
          parkDispatch(plan, unwatchedSettle(plan), {
            notBefore: result.deferred.nextEligibleAt,
          });
        } catch (error) {
          const service = getPrivateSessionMessageAcceptanceService();
          if (turn.privateReceiptId && service?.isPreclaimRefusal(turn.privateReceiptId, error)) {
            service.cancel(
              turn.privateReceiptId,
              error instanceof PrivateSessionMessageRefusalError
                ? error.code
                : 'authority_changed_before_dispatch'
            );
            emitQueueUpdate(sessionKey);
          } else if (turn.privateReceiptId) {
            parkDispatch(plan, unwatchedSettle(plan), {
              notBefore: result.deferred.nextEligibleAt,
              schedulingRetry: true,
            });
          }
          throw error;
        } finally {
          clearIfOurs();
        }
        return result;
      }
      // A refused turn never settles, so nothing else will hand the slot back.
      if (!result.accepted) {
        returnToQueue(plan);
        clearIfOurs();
      }
      return result;
    },
    (err: unknown) => {
      endFailedStart(plan, err);
      clearIfOurs();
      throw err;
    }
  );
}

/**
 * A launch threw before any turn started: a protected message its final check
 * refused is cancelled, anything else counts as a failed start and goes back
 * in line, or is given up once a recovered row has failed enough.
 *
 * @param plan - The message whose launch threw
 * @param err - What was thrown
 */
function endFailedStart(plan: DispatchPlan, err: unknown): void {
  const receiptId = plan.turn.privateReceiptId;
  const service = getPrivateSessionMessageAcceptanceService();
  if (
    receiptId !== undefined &&
    err instanceof PrivateSessionMessageRefusalError &&
    service?.isPreclaimRefusal(receiptId, err)
  ) {
    service.cancel(receiptId, err.code);
    emitQueueUpdate(plan.sessionKey);
    return;
  }
  countRecoveredFailure(plan);
  if (!giveUpIfSpent(plan)) returnToQueue(plan);
}
