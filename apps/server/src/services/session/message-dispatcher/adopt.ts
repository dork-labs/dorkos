/**
 * Recovering queue rows this process did not accept, so they run: ordinary
 * rows a previous process left behind, and accepted protected rows, each
 * wrapped in a pending entry by its existing id.
 *
 * @module services/session/message-dispatcher/adopt
 */
import type { AgentRuntime } from '@dorkos/shared/agent-runtime';
import { newDispatchId } from '@dorkos/shared/dispatch-id';
import { getMessageQueueStore } from '../message-queue-store.js';
import type { SessionStateProjector } from '../session-state-projector.js';
import { primaryOf, queueKeyOf } from '../resolution/session-key-registry.js';
import { emitQueueUpdate } from '../queue-stream-events.js';
import { ROOMS, SESSIONS } from '../../../config/constants.js';
import { logger } from '../../../lib/logger.js';
import { runInDispatch } from '../../../lib/dispatch-context.js';
import { recordDispatchEnd, recordDispatchStart } from '../../observability/dispatch-buffers.js';
import {
  getPrivateSessionMessageAcceptanceService,
  PrivateSessionMessageRefusalError,
} from '../private-messages/acceptance.js';
import { launching, pending } from './state.js';
import { parkDispatch, unwatchedSettle } from './park.js';
import { schedulePump } from './pump.js';
import type { DispatchPlan } from './types.js';

/** Inputs for {@link adoptQueuedMessages}. */
export interface AdoptQueuedMessagesOpts {
  /** Either id a caller might hold for the session (request uuid or canonical). */
  sessionId: string;
  /** The session's projector — the gate the pump reads before it releases anything. */
  projector: SessionStateProjector;
  /** The runtime an adopted message's turn will run on. */
  runtime: AgentRuntime;
  /** Working directory for the recovered turns, when the caller knows it. */
  cwd?: string;
  /** Internal protected recovery selection; authority is still rechecked at the runtime claim. */
  privateReceiptSelection?: {
    sourceKind: import('../private-messages/acceptance.js').PrivateSessionMessageSourceRef['kind'];
    receiptIds: readonly string[];
  };
  /** The document runner owns document recovery; shared Connections recovery excludes it. */
  excludeDocumentMessages?: boolean;
  /** Host lifetime of this protected recovery lane. */
  privateDispatchSignal?: AbortSignal;
}

/**
 * Take ownership of queue rows this process did not accept, so they run.
 *
 * A row that survives a restart is INERT on its own: the row is still there and
 * a snapshot still reports it, but the in-memory entry the pump releases died
 * with the old process, and nothing recreates it. The person is shown their
 * message waiting for a turn that will never come.
 *
 * This ADOPTS each surviving row **by its existing id** — same row, same
 * position, same words, same `enqueuedBy` — and wraps a pending entry around it
 * so the next turn boundary pumps it exactly as if this process had accepted it.
 * It deliberately does NOT re-offer them through {@link dispatchMessage}: that
 * would enqueue a fresh row beside every original and hand the person their
 * queue twice, which is the one failure worse than the queue not running at all.
 *
 * Idempotent by construction — a row this process is already carrying is
 * skipped, whether it is waiting ({@link pending}) or already on its way out
 * ({@link launching}) — so it is safe to call on every dispatch, which is what
 * makes recovery automatic rather than something a caller has to remember. Both
 * halves are load-bearing: a row is briefly in NEITHER the pending set nor the
 * store's rear-view while its turn assembles its context, and adopting there
 * sends somebody's message twice.
 *
 * Ends by giving the queue a chance to move: an idle session with rows on disk
 * has nothing else coming that would ever start them.
 *
 * @param opts - The session, its projector, and the runtime to run on
 * @returns How many rows were newly adopted
 */
export function adoptQueuedMessages(opts: AdoptQueuedMessagesOpts): number {
  const store = getMessageQueueStore();
  if (!store) return 0;
  const sessionKey = primaryOf(opts.sessionId);
  const rows = store.list(queueKeyOf(opts.sessionId));
  let adopted = 0;
  let swept = 0;
  for (const row of rows) {
    if (pending.has(row.id) || launching.has(row.id)) continue;
    // Protected rows have their own adoption path because their visible queue
    // text is only a placeholder. Generic recovery must never send it or bypass
    // the source adapter's final authority preflight.
    if (getPrivateSessionMessageAcceptanceService()?.findByQueueMessageId(row.id)) {
      continue;
    }
    // **A row a ROOM left behind is swept, never adopted** (DOR-1242). A room's
    // trigger gets no row any more, but rows written by earlier builds are still
    // on disk, and adoption would re-arm one as an ordinary `whenBusy: 'queue'`
    // plan: a prompt from a conversation that ended days ago, fired into a
    // session with no collector listening, and shown in that person's composer
    // on the way. Nobody is left to want it, so the honest recovery is to remove
    // it.
    //
    // The lock identity is the only thing that can distinguish these, which is
    // why it is a shared constant rather than a room import. It also bounds what
    // this can clean up: a `whenBusy: 'refuse'` UI action enqueues under the
    // PERSON's own client id, indistinguishable from something they typed, so
    // those legacy rows are left alone rather than guessed at.
    if (row.enqueuedBy === ROOMS.CLIENT_ID) {
      if (store.remove(row.id)) swept += 1;
      continue;
    }
    // The dispatch that accepted this row belonged to a process that is gone,
    // and its id went with it. Adoption is a new dispatch — its own id, its own
    // origin — because the alternative is a turn that appears in the log under
    // whichever unrelated caller happened to trigger the adoption sweep, or
    // under nothing at all.
    const dispatchId = newDispatchId();
    recordDispatchStart({ dispatchId, origin: 'queue-recovery', sessionId: sessionKey });
    const plan: DispatchPlan = {
      sessionId: opts.sessionId,
      sessionKey,
      clientId: row.enqueuedBy,
      content: row.content,
      messageId: row.id,
      projector: opts.projector,
      runtime: opts.runtime,
      budgetMs: SESSIONS.LOCK_TTL_MS,
      startedWaitingAt: Date.now(),
      // A recovered row is somebody's words with nobody left to retype them, so
      // it queues rather than being dropped if its first launch is refused.
      whenBusy: 'queue',
      // Its sender was told this was accepted by a process that no longer
      // exists, which is the strongest form of the reason the `'queue'` above
      // gives: there is nobody left to retype it.
      answered: true,
      // A recovered row is a row by definition, and somebody's words: it waits
      // as long as the queue waits.
      transient: false,
      turn: {
        ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
        ...(row.context !== null ? { context: row.context } : {}),
        // Nobody is holding a request open for this one, so the buffer entry
        // would otherwise never be closed out.
        onSettled: (outcome) =>
          recordDispatchEnd(dispatchId, outcome === 'failed' ? 'failed' : 'answered'),
      },
    };
    // Parked INSIDE the scope, so the snapshot `parkDispatch` takes is this
    // recovery dispatch's rather than the caller's — an adoption triggered by
    // somebody else's `dispatchMessage` must not put its turn under that
    // person's id.
    runInDispatch({ dispatchId, origin: 'queue-recovery' }, () =>
      parkDispatch(plan, unwatchedSettle(plan))
    );
    adopted += 1;
  }
  if (swept > 0) {
    // The queue really changed, so every window watching it has to be told —
    // otherwise a ghost row stays drawn in somebody's composer until something
    // else happens to move the queue.
    emitQueueUpdate(queueKeyOf(opts.sessionId));
    logger.info('[MessageDispatcher] swept room triggers an earlier build had persisted', {
      sessionId: sessionKey,
      rows: swept,
    });
  }
  if (adopted > 0) schedulePump(sessionKey);
  return adopted;
}

/**
 * Adopt accepted protected rows for one session through the existing pump.
 *
 * Unlike {@link adoptQueuedMessages}, this path never treats queue content as
 * runtime input. The plan carries only a receipt id; {@link triggerTurn}
 * resolves protected content in memory and claims it at the last preflight.
 *
 * @param opts - Persisted destination session and its resolved runtime objects
 * @returns Number of protected rows newly adopted by this process
 */
export function adoptAcceptedPrivateMessages(opts: AdoptQueuedMessagesOpts): number {
  if (opts.privateDispatchSignal?.aborted) return 0;
  const service = getPrivateSessionMessageAcceptanceService();
  const store = getMessageQueueStore();
  if (!service || !store) return 0;
  const sessionKey = primaryOf(opts.sessionId);
  let adopted = 0;
  for (const receipt of service.listAcceptedForDispatch(
    queueKeyOf(opts.sessionId),
    opts.privateReceiptSelection,
    opts.excludeDocumentMessages
  )) {
    if (pending.has(receipt.queueMessageId) || launching.has(receipt.queueMessageId)) continue;
    const row = store.get(receipt.queueMessageId);
    if (!row) {
      service.cancel(receipt.id, 'accepted_queue_missing');
      continue;
    }
    const dispatchId = newDispatchId();
    recordDispatchStart({ dispatchId, origin: 'queue-recovery', sessionId: sessionKey });
    const plan: DispatchPlan = {
      sessionId: receipt.sessionId,
      sessionKey,
      clientId: service.sender(receipt) ?? `system:${receipt.sourceKind}:${receipt.sourceId}`,
      content: row.content,
      messageId: row.id,
      projector: opts.projector,
      runtime: opts.runtime,
      budgetMs: SESSIONS.LOCK_TTL_MS,
      startedWaitingAt: Date.now(),
      whenBusy: 'queue',
      answered: true,
      transient: false,
      turn: {
        ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
        privateReceiptId: receipt.id,
        ...(opts.privateDispatchSignal
          ? { privateDispatchSignal: opts.privateDispatchSignal }
          : {}),
        onSettled: (outcome) =>
          recordDispatchEnd(dispatchId, outcome === 'failed' ? 'failed' : 'answered'),
      },
    };
    try {
      runInDispatch({ dispatchId, origin: 'queue-recovery' }, () =>
        parkDispatch(plan, unwatchedSettle(plan))
      );
    } catch (error) {
      if (service.isPreclaimRefusal(receipt.id, error)) {
        service.cancel(
          receipt.id,
          error instanceof PrivateSessionMessageRefusalError
            ? error.code
            : 'authority_changed_before_dispatch'
        );
        emitQueueUpdate(sessionKey);
        continue;
      }
      runInDispatch({ dispatchId, origin: 'queue-recovery' }, () =>
        parkDispatch(plan, unwatchedSettle(plan), { schedulingRetry: true })
      );
    }
    adopted += 1;
  }
  if (adopted > 0) schedulePump(sessionKey);
  return adopted;
}
