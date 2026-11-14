/**
 * Starting one accepted message's turn: claim the session, hand the message to
 * `triggerTurn`, take it off the queue once the turn is really running, and
 * route every way the launch can end.
 *
 * @module services/session/message-dispatcher/launch
 */
import { getMessageQueueStore, setQueuedWaitingOn } from '../message-queue-store.js';
import { triggerTurn, type TriggerTurnResult } from '../trigger-turn.js';
import { emitQueueUpdate } from '../queue-stream-events.js';
import { TURN_NO_ANSWER } from '../launch/turn-not-started.js';
import { noteRoomTurnWords } from '../../core/turn-power/outside-words.js';
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
  sweptWhileLaunching,
  buildTurnDeps,
} from './state.js';
import { holdInQueue, parkDispatch, returnToQueue, unwatchedSettle } from './park.js';
import { rearmLockWaiters, schedulePump } from './pump.js';
import { forgetRecordedHolds, holdForPause, pausedAgentOfPlan } from './pause-hold.js';
import { logger } from '../../../lib/logger.js';
import type { PausedAgentRef } from '../../mesh/pause/agent-pause.js';
import type { DispatchPlan, InFlightTurn } from './types.js';

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
  if (getMessageQueueStore()?.remove(plan.messageId)) emitQueueUpdate(plan.sessionKey);
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
    holdForPause(plan, paused);
    return Promise.resolve({ accepted: false });
  }
  const { sessionKey, clientId, messageId } = plan;
  let turnStarted = false;
  // Set when a pause landed between the check above and this turn's start: the
  // turn will be refused, so its row is kept and held once it settles.
  let heldByPause: PausedAgentRef | undefined;
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
  const clearIfOurs = (): void => {
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
  if (launchCarriesWords(clientId, messageId)) {
    const canonical = plan.runtime.getInternalSessionId(plan.sessionId) ?? plan.sessionId;
    for (const id of new Set([plan.sessionId, sessionKey, canonical])) noteRoomTurnWords(id, true);
  }
  let started: Promise<TriggerTurnResult>;
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
          turn.permissionCeiling,
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
      ...(turn.carriedMarks?.outsider === true || launchCarriesHold(clientId, messageId)
        ? { carriedMarks: { outsider: true as const } }
        : {}),
      ...(turn.stallTimeoutMs !== undefined ? { stallTimeoutMs: turn.stallTimeoutMs } : {}),
      ...(turn.privateReceiptId !== undefined ? { privateReceiptId: turn.privateReceiptId } : {}),
      ...(turn.privateDispatchSignal ? { privateDispatchSignal: turn.privateDispatchSignal } : {}),
      ...(turn.unattended ? { unattended: true } : {}),
      // The turn is running: THIS is the instant the message stops waiting, and
      // every window is told so in the same beat — a queue chip that outlives
      // the message it stands for is a lie about what is still waiting.
      onTurnStart: (seq) => {
        turnStarted = true;
        // Paused while this launch was under way: the pause refuses the turn, so
        // the row is not taken off the queue and nobody is told it started.
        heldByPause = pausedAgentOfPlan(plan);
        if (heldByPause) return;
        recoveryFailures.delete(messageId);
        if (turn.privateReceiptId !== undefined) {
          getPrivateSessionMessageAcceptanceService()?.markTurnStarted(turn.privateReceiptId, seq);
          emitQueueUpdate(sessionKey);
        } else if (getMessageQueueStore()?.remove(messageId)) {
          emitQueueUpdate(sessionKey);
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
      messageId,
      onError: turn.onError,
      onSettled: (turnOutcome, reason) => {
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
            holdForPause(plan, heldByPause);
            clearIfOurs();
            return;
          }
          // Lifted again before the turn spoke, so it ran: the row goes now.
          if (getMessageQueueStore()?.remove(messageId)) emitQueueUpdate(sessionKey);
        }
        clearIfOurs();
        if (turn.privateReceiptId !== undefined) {
          getPrivateSessionMessageAcceptanceService()?.settle(turn.privateReceiptId, turnOutcome);
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
    clearIfOurs();
    if (
      turn.privateReceiptId !== undefined &&
      err instanceof PrivateSessionMessageRefusalError &&
      getPrivateSessionMessageAcceptanceService()?.isPreclaimRefusal(turn.privateReceiptId, err)
    ) {
      getPrivateSessionMessageAcceptanceService()?.cancel(turn.privateReceiptId, err.code);
      emitQueueUpdate(sessionKey);
    } else {
      countRecoveredFailure(plan);
      if (!giveUpIfSpent(plan)) returnToQueue(plan);
    }
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
        clearIfOurs();
        returnToQueue(plan);
      }
      return result;
    },
    (err: unknown) => {
      clearIfOurs();
      if (
        turn.privateReceiptId !== undefined &&
        err instanceof PrivateSessionMessageRefusalError &&
        getPrivateSessionMessageAcceptanceService()?.isPreclaimRefusal(turn.privateReceiptId, err)
      ) {
        getPrivateSessionMessageAcceptanceService()?.cancel(turn.privateReceiptId, err.code);
        emitQueueUpdate(sessionKey);
      } else {
        countRecoveredFailure(plan);
        if (!giveUpIfSpent(plan)) returnToQueue(plan);
      }
      throw err;
    }
  );
}
