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
import {
  getPrivateSessionMessageAcceptanceService,
  PrivateSessionMessageRefusalError,
} from '../private-messages/acceptance.js';
import {
  emitLifecycle,
  inFlight,
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
import type { DispatchPlan, InFlightTurn } from './types.js';

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
  const { sessionKey, clientId, messageId } = plan;
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
  let started: Promise<TriggerTurnResult>;
  try {
    started = triggerTurn({
      sessionId: plan.sessionId,
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
      ...(turn.stallTimeoutMs !== undefined ? { stallTimeoutMs: turn.stallTimeoutMs } : {}),
      ...(turn.privateReceiptId !== undefined ? { privateReceiptId: turn.privateReceiptId } : {}),
      ...(turn.privateDispatchSignal ? { privateDispatchSignal: turn.privateDispatchSignal } : {}),
      ...(turn.unattended ? { unattended: true } : {}),
      // The turn is running: THIS is the instant the message stops waiting, and
      // every window is told so in the same beat — a queue chip that outlives
      // the message it stands for is a lie about what is still waiting.
      onTurnStart: (seq) => {
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
        turn.onSettled?.(turnOutcome, reason);
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
      returnToQueue(plan);
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
        returnToQueue(plan);
      }
      throw err;
    }
  );
}
