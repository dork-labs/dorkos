/**
 * Parking accepted messages until the pump releases them: putting a message
 * whose launch started no turn back in line (or giving up on it), holding one
 * for the agent's background work, and the bounded wait every parked message
 * runs under.
 *
 * @module services/session/message-dispatcher/park
 */
import type { QueuedWaitingOn } from '@dorkos/shared/types';
import { getMessageQueueStore, setQueuedWaitingOn } from '../message-queue-store.js';
import type { TriggerTurnResult } from '../trigger-turn.js';
import { emitQueueUpdate } from '../queue-stream-events.js';
import { logger } from '../../../lib/logger.js';
import { captureDispatchScope } from '../../../lib/dispatch-context.js';
import {
  getPrivateSessionMessageAcceptanceService,
  PrivateSessionMessageRefusalError,
} from '../private-messages/acceptance.js';
import { emitLifecycle, pending, sweptWhileLaunching } from './state.js';
import { launchDispatch } from './launch.js';
import { schedulePump } from './pump.js';
import { projectorFor } from '../resolution/session-key-registry.js';
import { SESSIONS } from '../../../config/constants.js';
import type { DispatchPlan, PendingDispatch } from './types.js';

/**
 * Whether the session is parked on a person's answer (an approval, a question,
 * a sign-in the runtime reports as an interaction).
 *
 * @param sessionKey - The session.
 */
function stillWaitingOnPerson(sessionKey: string): boolean {
  return projectorFor(sessionKey)?.hasPendingInteractions() === true;
}

/**
 * Whether a waiting trigger should keep waiting on the person rather than give
 * up: the session is parked on an answer, and the trigger has not yet waited
 * longer than an answer itself may (DOR-3113).
 *
 * @param plan - The waiting message.
 */
function waitsOnPerson(plan: DispatchPlan): boolean {
  return (
    stillWaitingOnPerson(plan.sessionKey) &&
    Date.now() - plan.startedWaitingAt < SESSIONS.INTERACTION_PARK_CEILING_MS
  );
}

/**
 * Give up on a message whose launch started no turn, or put it back in line.
 *
 * Which of the two is the caller's `whenBusy`, and the difference is a promise
 * to a person: a message somebody typed and was told was accepted must survive
 * a launch the write-lock refused, while a machine-generated trigger that asked
 * not to wait must not be left sitting in their composer.
 *
 * **{@link DispatchPlan.answered} outranks `whenBusy`**, because by then the
 * refusal the caller asked for is no longer available: it is holding an
 * `accepted: true` and there is no channel to take that back. Dropping the
 * message would leave it waiting for a turn nothing will ever start — for a room
 * that is a claim held to its ceiling and a "something went wrong" an hour
 * later, over a message the model never saw. It goes back in line instead, which
 * is what the acceptance promised.
 *
 * **A refusing plan's second chance is bounded by its ORIGINAL budget**, and the
 * bound is what keeps "goes back in line" from meaning "forever". Every
 * re-park used to arm a fresh {@link DispatchPlan.budgetMs} timer while
 * `startedWaitingAt` was never reset, so a stranger who kept the session simply
 * kept the cycle going: refused, re-parked, refused again, once per
 * `SESSIONS.LOCK_TTL_MS` for as long as the process lived. What is re-parked
 * here is therefore what is LEFT of the wait the caller was accepted under —
 * computed from the original `startedWaitingAt`, never restarted — and when
 * nothing is left the plan is dropped, once, with a warning. A trigger whose
 * whole point was not to run late has no business running an hour late on its
 * fourth attempt.
 *
 * Dropping is safe HERE in a way it is not at acceptance, because the drop is
 * terminal and reported: {@link DispatchMessageOpts.onSettled} fires `'failed'`,
 * which is the caller's cue to take whatever its own "could not answer" path is
 * (for a room, the wait its collector is already holding). What the acceptance
 * promised was an answer or an honest failure, and this is the second.
 *
 * A message already gone from the queue — removed from another window between
 * the launch and its refusal — is left gone.
 */
export function returnToQueue(plan: DispatchPlan): void {
  // **Checked FIRST** (DOR-1239). A transient plan has no later moment worth
  // running at, and it is `answered: true` by construction — so the bounded
  // second chance below would otherwise re-park it and, at the bound, force it
  // through with `budgetExhausted` into a stream that is still open.
  if (plan.transient) {
    dropTransient(plan, 'the launch could not start it');
    return;
  }
  if (plan.whenBusy !== 'queue') {
    // No row was ever written for a refusing plan (see the module doc), so
    // giving up on one is simply declining to re-park it.
    if (!plan.answered) return;
    const remainingMs = plan.budgetMs - (Date.now() - plan.startedWaitingAt);
    // Waiting on a person is not a turn gone dark (DOR-3113): the trigger
    // waits behind the approval, as long as the approval itself may wait,
    // instead of being dropped as a failure after five minutes.
    if (remainingMs <= 0 && waitsOnPerson(plan)) {
      parkDispatch(plan, unwatchedSettle(plan), { waitingOnLock: true, budgetMs: plan.budgetMs });
      return;
    }
    if (remainingMs <= 0) {
      logger.warn('[MessageDispatcher] a refusing trigger spent its whole wait and was dropped', {
        sessionId: plan.sessionKey,
        messageId: plan.messageId,
        budgetMs: plan.budgetMs,
        waitedMs: Date.now() - plan.startedWaitingAt,
      });
      // Reported here or nowhere: this plan's caller was answered
      // `accepted: true` at acceptance and has been waiting on the turn ever
      // since, and no turn will now start for it. Named when the session is
      // still waiting on a person, so the room says that and not "a problem".
      plan.turn.onSettled?.(
        'failed',
        stillWaitingOnPerson(plan.sessionKey) ? 'pending-interaction' : undefined
      );
      return;
    }
    parkDispatch(plan, unwatchedSettle(plan), { waitingOnLock: true, budgetMs: remainingMs });
    return;
  }
  const store = getMessageQueueStore();
  if (store && !store.get(plan.messageId)) {
    // No row to put back (it was removed, or never written): no turn will
    // start for this message, so its caller hears that now, or never (a
    // launch-cap slot is released on it).
    emitLifecycle({
      phase: 'dropped',
      messageId: plan.messageId,
      reason: sweptWhileLaunching.delete(plan.messageId) ? 'session_gone' : 'removed',
    });
    plan.turn.onSettled?.('failed');
    return;
  }
  parkDispatch(plan, unwatchedSettle(plan), { waitingOnLock: true });
}

/**
 * Keep a queued message waiting on the agent's background work, showing every
 * window what it waits on (spec `warm-process-lifecycle` D2a, DOR-2065).
 *
 * It holds no lock and no turn while it waits, so the stall watchdog never sees
 * it and a helper's own wake-up still runs as the agent's own turn. It is tried
 * again at every turn boundary, at every gate release from the runtime (the
 * work ending, its process going, Switch now), and at `releaseAt`.
 *
 * @param plan - The message
 * @param waitingOn - What it waits on, as the runtime reported it
 */
export function holdInQueue(plan: DispatchPlan, waitingOn: QueuedWaitingOn): void {
  // Taken off the queue while this attempt was under way (a Remove or a Stop
  // finds nothing armed to cancel then): it is dropped, exactly as
  // {@link returnToQueue} drops a refused launch whose row is gone.
  const store = getMessageQueueStore();
  if (store && !store.get(plan.messageId)) {
    setQueuedWaitingOn(plan.messageId, undefined);
    emitLifecycle({
      phase: 'dropped',
      messageId: plan.messageId,
      reason: sweptWhileLaunching.delete(plan.messageId) ? 'session_gone' : 'removed',
    });
    plan.turn.onSettled?.('failed');
    return;
  }
  if (setQueuedWaitingOn(plan.messageId, waitingOn)) emitQueueUpdate(plan.sessionKey);
  parkDispatch(plan, unwatchedSettle(plan), { held: waitingOn });
}

/**
 * Give up on a {@link DispatchPlan.transient} message, and say so.
 *
 * The whole disposal: there is no row to remove and nobody holding a request
 * open, so the log line is the only trace it leaves. It is a `warn` because a
 * trigger somebody's click generated did not reach the model, even though the
 * caller was told it was accepted — rare (it needs a stream that stays open past
 * the wait bound, or a stranger taking the session in the same beat), and
 * invisible without this.
 *
 * @param plan - The transient plan being dropped
 * @param why - What stopped it, for the log line
 */
export function dropTransient(plan: DispatchPlan, why: string): void {
  pending.delete(plan.messageId);
  logger.warn('[MessageDispatcher] a refusing caller’s trigger was dropped rather than run late', {
    sessionId: plan.sessionKey,
    messageId: plan.messageId,
    clientId: plan.clientId,
    why,
  });
}

/**
 * Settlement handlers for a launch nobody is waiting on.
 *
 * Every parked dispatch is one of these now: the caller was answered at
 * ACCEPTANCE (task 2.4), and an adopted row's caller belonged to a process that
 * is gone. So a failure has to be reported here or it is reported nowhere.
 */
export function unwatchedSettle(plan: DispatchPlan): {
  resolve(result: TriggerTurnResult): void;
  reject(err: unknown): void;
} {
  return {
    resolve: () => {},
    reject: (err: unknown) => {
      logger.warn('[MessageDispatcher] a waiting message failed to start', {
        sessionId: plan.sessionKey,
        messageId: plan.messageId,
        error: err instanceof Error ? err.message : String(err),
      });
    },
  };
}

/**
 * Park a message in the pending set until the pump releases it, bounded so a
 * turn that went dark cannot make it wait forever.
 *
 * @param plan - The message and everything its turn will need
 * @param settle - Receives the launch's result, however it settles
 * @param opts.waitingOnLock - This message has already been refused by the
 *   write-lock once, so the pump leaves it alone until a turn boundary; see
 *   {@link PendingDispatch.waitingOnLock}
 * @param opts.budgetMs - How long THIS park may last, when that is less than the
 *   plan's whole budget. A re-park passes what is left of the original wait
 *   rather than the whole of it again; see {@link returnToQueue}.
 */
export function parkDispatch(
  plan: DispatchPlan,
  settle: { resolve(result: TriggerTurnResult): void; reject(err: unknown): void },
  opts?: {
    waitingOnLock?: boolean;
    budgetMs?: number;
    notBefore?: string;
    schedulingRetry?: boolean;
    held?: QueuedWaitingOn;
  }
): void {
  if (plan.turn.privateDispatchSignal?.aborted) {
    settle.resolve({ accepted: false, suspended: true });
    return;
  }
  // Taken HERE, where the message was accepted, and applied wherever the pump
  // eventually calls `launch` — which is inside the PREVIOUS turn's scope on
  // both routes that reach it: the projector's `turn_end`, and the turn handing
  // its slot back. Correlation follows the call chain, and a parked closure's
  // call chain is not its own, so without this snapshot a queued turn logs
  // under the id of the turn it waited behind (DOR-1159). The `setTimeout`
  // below never had the problem, because a timer captures its creation context;
  // this makes the two paths agree.
  const scope = captureDispatchScope();
  const deadline = (): number | undefined => {
    const receiptId = plan.turn.privateReceiptId;
    const durable = receiptId
      ? getPrivateSessionMessageAcceptanceService()?.dispatchNotBefore(receiptId)
      : undefined;
    const dates = [durable, opts?.notBefore].filter((date) => date !== undefined);
    if (dates.some((date) => !Number.isFinite(Date.parse(date))))
      throw new PrivateSessionMessageRefusalError(
        'invalid_source_deferral',
        'This private message cannot be scheduled.'
      );
    return dates.length ? Math.max(...dates.map((date) => Date.parse(date))) : undefined;
  };
  // A failed schedule read proves no authority loss. Retry its real gate after a bounded
  // delay, without changing the source's durable budget deadline or claiming a runtime slot.
  const schedulingRetryMs = 1000;
  const notBefore = opts?.schedulingRetry ? Date.now() + schedulingRetryMs : deadline();
  const rearmDeadline = (): void => {
    clearTimeout(entry.timer);
    entry.timer = setTimeout(
      () => {
        // The timer only wakes the ordinary pump; it never bypasses a busy runtime.
        if (pending.get(plan.messageId) !== entry) return;
        if (entry.notBefore !== undefined && entry.notBefore > Date.now()) rearmDeadline();
        else schedulePump(entry.sessionKey);
      },
      Math.min(2_147_483_647, Math.max(1, (entry.notBefore ?? Date.now()) - Date.now()))
    );
    entry.timer.unref?.();
  };
  const entry: PendingDispatch = {
    abandon: () => plan.turn.onSettled?.('failed'),
    ...(plan.turn.privateDispatchSignal
      ? { privateDispatchSignal: plan.turn.privateDispatchSignal }
      : {}),
    messageId: plan.messageId,
    sessionKey: plan.sessionKey,
    clientId: plan.clientId,
    runtime: plan.runtime,
    waitingOnLock: opts?.waitingOnLock ?? false,
    ...(notBefore !== undefined ? { notBefore } : {}),
    ...(opts?.held !== undefined ? { held: opts.held } : {}),
    launch: (launchOpts) => {
      if (pending.get(plan.messageId) !== entry) return;
      if (plan.turn.privateDispatchSignal?.aborted) {
        clearTimeout(entry.timer);
        pending.delete(plan.messageId);
        settle.resolve({ accepted: false, suspended: true });
        return;
      }
      // Recheck durable authority even when the ordinary wait-budget timer forces a launch.
      try {
        entry.notBefore = deadline();
      } catch (error) {
        const receiptId = plan.turn.privateReceiptId;
        const service = getPrivateSessionMessageAcceptanceService();
        if (receiptId && !service?.isPreclaimRefusal(receiptId, error)) {
          entry.notBefore = Date.now() + schedulingRetryMs;
          rearmDeadline();
          return;
        }
        clearTimeout(entry.timer);
        pending.delete(plan.messageId);
        if (receiptId && service) {
          service.cancel(
            receiptId,
            error instanceof PrivateSessionMessageRefusalError
              ? error.code
              : 'authority_changed_before_dispatch'
          );
          emitQueueUpdate(entry.sessionKey);
        }
        settle.reject(error);
        schedulePump(entry.sessionKey);
        return;
      }
      if (entry.notBefore !== undefined && entry.notBefore > Date.now()) {
        rearmDeadline();
        schedulePump(entry.sessionKey);
        return;
      }
      if (!pending.delete(plan.messageId)) return;
      clearTimeout(entry.timer);
      scope(() => {
        void launchDispatch(plan, launchOpts).then(settle.resolve, settle.reject);
      });
    },
    // Bounded for the same reason DOR-1088 bounds its chain: the write-lock has
    // a TTL and a queue does not, so a turn that went dark would otherwise hand
    // the session to a stranger while its own client's message waited forever.
    //
    // The bound ends two different ways, because the two kinds of waiting made
    // two different promises. A queued message is somebody's words: it launches
    // anyway, meeting the write-lock as a stranger would. A transient one is a
    // refusing caller's trigger: forcing it through would put a second
    // `sendMessage` on a session whose stream is still open, so it is dropped.
    //
    // How LONG the bound is, is the other half: a re-park spends what is left of
    // the original wait rather than a fresh copy of it (DOR-1242).
    //
    // A message held for background work is the exception (DOR-2065): it
    // already waited past nothing, and launching it at the bound would restart
    // the agent under the work it is waiting on. Its bound is the runtime's own
    // ceiling, `releaseAt`, where it is tried again like at any boundary.
    timer: setTimeout(
      () => {
        if (opts?.held !== undefined) {
          if (pending.get(plan.messageId) !== entry) return;
          entry.held = undefined;
          schedulePump(entry.sessionKey);
          return;
        }
        // Still waiting on a person: wait the budget again rather than force a
        // launch the parked turn's lock would refuse (DOR-3113).
        if (waitsOnPerson(plan)) {
          if (pending.get(plan.messageId) !== entry) return;
          parkDispatch(plan, settle, { ...opts, budgetMs: plan.budgetMs });
          return;
        }
        if (plan.transient) {
          dropTransient(plan, 'the stream it was waiting on had not closed within the wait budget');
          return;
        }
        entry.launch({ budgetExhausted: true });
      },
      opts?.held !== undefined
        ? Math.min(2_147_483_647, Math.max(1, opts.held.releaseAt - Date.now() + 1))
        : (opts?.budgetMs ?? plan.budgetMs)
    ),
  };
  entry.timer.unref?.();
  pending.set(plan.messageId, entry);
  if (notBefore !== undefined && notBefore > Date.now()) rearmDeadline();
}
