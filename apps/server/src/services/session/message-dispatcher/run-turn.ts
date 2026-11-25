/**
 * Where a launched turn's words are, step by step, and the run record beside
 * them (spec `turns-survive-restarts` §4.3, §4.7; DOR-5159).
 *
 * At `turn_start` the row is no longer deleted: it is kept, out of line
 * (`in_turn`), while the run is `started`. When the runtime's first event
 * arrives it has the words: the row is deleted and the run is `running`. At
 * settle the run is `ended`, and a row still kept (the turn ended before the
 * runtime read it) is deleted with it. Each of those is one transaction over
 * the queue row and its run, so a restart between any two loses nothing and
 * doubles nothing.
 *
 * With no run record wired, the rows move exactly the same way.
 *
 * @module services/session/message-dispatcher/run-turn
 */
import { getMessageQueueStore } from '../message-queue-store.js';
import { getPrivateSessionMessageAcceptanceService } from '../private-messages/acceptance.js';
import { queueKeyOf } from '../resolution/session-key-registry.js';
import { TURN_NO_ANSWER } from '../launch/turn-not-started.js';
import { feedRun, reportRun } from './run-feed.js';
import type { DispatchPlan } from './types.js';

/**
 * Run `fn` in one queue-store transaction, or as it is when no store is wired.
 *
 * @param fn - The writes.
 */
function together(fn: () => void): void {
  const store = getMessageQueueStore();
  if (store) store.atomically(fn);
  else fn();
}

/**
 * `turn_start`: the run is `started` (7, or 4 and 7 for a run still
 * `queued`) and its row is kept out of line, in one transaction.
 *
 * @param plan - The message whose turn started
 * @param seq - The `seq` of the turn's `turn_start`
 */
export function recordTurnStart(plan: DispatchPlan, seq: number): void {
  together(() => {
    if (plan.runId !== undefined) {
      reportRun({
        kind: 'started',
        runId: plan.runId,
        sessionId: queueKeyOf(plan.sessionId),
        openedBy: 'caller',
        runtime: plan.runtime.type,
        runtimeTurnRef: seq,
      });
    }
    const receiptId = plan.turn.privateReceiptId;
    if (receiptId !== undefined) {
      getPrivateSessionMessageAcceptanceService()?.markTurnStarted(receiptId, seq);
    } else {
      getMessageQueueStore()?.markInTurn(plan.messageId);
    }
  });
}

/**
 * The runtime's first event for the turn: it has the words (transition 10).
 *
 * @param plan - The message
 * @param deleteRow - False while a pause may still put the row back
 */
export function recordTurnDelivered(plan: DispatchPlan, deleteRow: boolean): void {
  together(() => {
    if (plan.runId !== undefined) reportRun({ kind: 'delivered', runId: plan.runId });
    if (deleteRow && getMessageQueueStore()?.get(plan.messageId)?.inTurn === true) {
      getMessageQueueStore()?.remove(plan.messageId);
    }
  });
}

/**
 * The turn settled: the run is `ended` (11 or 12) with the ending its
 * `turn_end` recorded, else with this settle's, and a row the runtime never
 * read is deleted with it. Its words are not replayed (§6.2).
 *
 * @param plan - The message
 * @param outcome - How the turn settled
 * @param reason - The runtime's words when it refused the turn
 */
export function recordTurnSettled(
  plan: DispatchPlan,
  outcome: 'ok' | 'failed',
  reason: string | undefined
): void {
  const refused = reason !== undefined && reason !== TURN_NO_ANSWER && reason.length > 0;
  together(() => {
    if (plan.runId !== undefined) {
      reportRun({
        kind: 'ended',
        runId: plan.runId,
        ending: refused ? 'refused' : outcome === 'ok' ? 'completed' : 'failed',
        ...(refused ? { refusal: reason } : {}),
      });
    }
    if (getMessageQueueStore()?.get(plan.messageId)?.inTurn === true) {
      getMessageQueueStore()?.remove(plan.messageId);
    }
  });
}

/**
 * A pause refused a turn that had started: its run goes back to `queued`
 * (14, or 15 once delivered) and its kept row back in line, in one
 * transaction. The caller then holds the row as any paused row is held.
 *
 * @param plan - The message whose turn the pause refused
 */
export function putBackForPause(plan: DispatchPlan): void {
  together(() => {
    feedRun(plan, 'pause cut', (feed, runId) => feed.pauseCut(runId));
    const store = getMessageQueueStore();
    const row = store?.get(plan.messageId);
    if (store && row?.inTurn) store.restore(queueKeyOf(plan.sessionKey), row);
  });
}
