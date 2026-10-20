/**
 * The pump that moves a session's queue: when it runs, what it launches, and
 * the turn-boundary and runtime-turn signals that wake it.
 *
 * @module services/session/message-dispatcher/pump
 */
import { getMessageQueueStore } from '../message-queue-store.js';
import { primaryOf, projectorFor, queueKeyOf } from '../resolution/session-key-registry.js';
import { runtimeLockHolder } from '../session-lock.js';
import { logger } from '../../../lib/logger.js';
import {
  inFlight,
  pending,
  pendingCompactions,
  releases,
  runtimeTurns,
  withDispatchMutex,
} from './state.js';
import { launchDueCompaction } from './agent-compaction.js';
import type { PendingDispatch } from './types.js';

/**
 * Give a session's queue a chance to move, on the next microtask.
 *
 * Deferred rather than immediate because the two things that call it — the
 * projector's `turn_end` and a turn handing back its slot — both run inside
 * machinery the pump would otherwise re-enter.
 *
 * @param sessionId - The session whose queue should be reconsidered
 */
export function schedulePump(sessionId: string): void {
  const sessionKey = primaryOf(sessionId);
  queueMicrotask(() => {
    void withDispatchMutex(sessionKey, () => pumpLocked(sessionKey)).catch((err: unknown) => {
      logger.warn('[MessageDispatcher] pump failed', {
        sessionId: sessionKey,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  });
}

/**
 * Launch the head of a session's queue, if anything may run.
 *
 * Order is the store's: by `position`, so the queue dispatches in the order a
 * person put it in, and a reorder is honoured without this needing to know a
 * reorder happened. Two gates stand in front of it, and both are refusals to
 * act rather than reasons to drop anything — whatever is queued stays queued.
 *
 * Must be called with the dispatch mutex held.
 */
export function pumpLocked(sessionKey: string): void {
  // Firing into an open approval, question or elicitation is the failure this
  // gate exists for: the agent is parked on a person, and a queued prompt
  // arriving now is answered by nobody and read as the person's reply by the
  // model. Reuse the probe the write-lock and the stall watchdog already share.
  if (projectorFor(sessionKey)?.hasPendingInteractions()) return;
  // One turn at a time on a session, whoever owns it. The pump is called both
  // when a turn ENDS on the projector and when one hands its slot back, and the
  // first of those fires while the ending turn still holds the write-lock — so
  // this gate is also what keeps the queue from racing a release it would lose.
  if (inFlight.has(sessionKey)) return;
  // A summary the agent asked for runs first, once the turn that asked for it
  // has ended (DOR-2732; the module doc says why it goes ahead of the queue).
  if (launchDueCompaction(sessionKey)) return;
  // Budget-held documents occupy no runtime slot and cannot block a person's work.
  const head = orderedWaiting(sessionKey).find(
    (entry) => entry.notBefore === undefined || entry.notBefore <= Date.now()
  );
  if (!head || head.waitingOnLock) return;
  // Held for the agent's background work: it, and everything behind it, waits
  // (order is never changed behind a person's back). Cleared by a boundary or
  // the runtime's gate release, each of which tries it again.
  if (head.held !== undefined) return;
  // A delivery the runtime already owes is on its way, and it opens a segment of
  // its own (spec `warm-process-lifecycle` D6). Launching now would put the
  // person's words and a background helper's report into one turn. The runtime
  // owes this gate a bound — it is re-asked at the next boundary, and the
  // runtime's own clock releases it — so a queue held here always moves again.
  if (head.runtime.isSegmentPending?.(sessionKey) === true) return;
  head.launch({ budgetExhausted: false });
}

/**
 * A turn the AGENT started has opened on this session, so nothing queued may
 * launch into it (spec `warm-process-lifecycle` D6).
 *
 * Claimed at the turn's WINDOW OPEN rather than when it takes the session's
 * write-lock, and the gap is the reason this exists: the lock may be a moment
 * from free, and a queued message launched into that moment lands in the middle
 * of a turn the agent is already running.
 *
 * A dispatched turn already holding the slot keeps it. That is not a conflict to
 * resolve here — the runtime turn will wait for the write-lock like any other
 * holder — and overwriting the claim would tell this module the person's turn
 * had ended.
 *
 * @param sessionId - The session the agent started talking on, in any id it
 *   answers to
 */
export function noteRuntimeTurnOpen(sessionId: string): void {
  const sessionKey = primaryOf(sessionId);
  if (inFlight.has(sessionKey)) return;
  const token = Symbol('dispatcher-runtime-turn');
  runtimeTurns.set(sessionKey, token);
  inFlight.set(sessionKey, {
    clientId: runtimeLockHolder(sessionKey),
    token,
    startedAt: Date.now(),
    // A runtime turn reports no `turn_start` to this module, so nothing could
    // ever flip this. False is the conservative answer and the deliberate one: a
    // slot that never claims to have started reads as still producing for as
    // long as it is held.
    sawTurnStart: false,
  });
}

/**
 * That turn has ended: give the session back and let the queue move.
 *
 * Only clears a slot this module's own runtime-turn claim owns — a dispatched
 * turn that was already running when the agent started talking holds the slot
 * on its own token, and a runtime turn ending must not hand away a person's
 * turn.
 *
 * @param sessionId - The session whose agent-initiated turn ended
 */
export function noteRuntimeTurnClosed(sessionId: string): void {
  const sessionKey = primaryOf(sessionId);
  const token = runtimeTurns.get(sessionKey);
  runtimeTurns.delete(sessionKey);
  if (token !== undefined && inFlight.get(sessionKey)?.token === token) {
    inFlight.delete(sessionKey);
  }
  // A turn ending is a turn boundary, whoever ran it: it re-arms every message
  // the write-lock refused and gives the queue its chance to move.
  noteTurnBoundary(sessionKey);
}

/**
 * Let every message (and any summary the agent asked for) the write-lock
 * refused on this session try again, because the lock has just been let go. The pump runs them; this only clears the mark
 * that makes it step over them.
 *
 * @param sessionKey - The resolved session id
 */
export function rearmLockWaiters(sessionKey: string): void {
  for (const entry of pending.values()) {
    if (entry.sessionKey === sessionKey) entry.waitingOnLock = false;
  }
  const compaction = pendingCompactions.get(sessionKey);
  if (compaction) compaction.waitingOnLock = false;
}

/**
 * Is a message on this session held for the agent's background work (DOR-2065)?
 *
 * @param sessionKey - The resolved session id
 */
export function hasHeldMessage(sessionKey: string): boolean {
  for (const entry of pending.values()) {
    if (entry.sessionKey === sessionKey && entry.held !== undefined) return true;
  }
  return false;
}

/**
 * A session's waiting dispatches in the order they should run.
 *
 * The stored `position` is the authority, because that is what a reorder edits
 * and what every window reads. A dispatch with no row behind it — no store is
 * wired, as in most unit tests — keeps its arrival
 * order, which is the same answer for a queue nobody can reorder. `sort` is
 * stable, so the two groups interleave predictably rather than by accident.
 */
export function orderedWaiting(sessionKey: string): PendingDispatch[] {
  const rows = getMessageQueueStore()?.list(queueKeyOf(sessionKey)) ?? [];
  const rank = new Map(rows.map((row, index) => [row.id, index]));
  return [...pending.values()]
    .filter((entry) => entry.sessionKey === sessionKey)
    .sort(
      (a, b) =>
        (rank.get(a.messageId) ?? Number.MAX_SAFE_INTEGER) -
        (rank.get(b.messageId) ?? Number.MAX_SAFE_INTEGER)
    );
}

/**
 * The dispatcher's signal that a turn boundary was reached — wired to the
 * projector at the composition root.
 *
 * Fired for `turn_end` and for `interaction_resolved`, and for nothing else.
 * That list is the whole contract: a turn that ENDED is the only thing that
 * frees the session for the message behind it, and an interaction that was
 * ANSWERED is the only thing that clears the other gate. A bare `result` is
 * deliberately not on it.
 *
 * @param sessionId - The session whose boundary was reached
 */
export function noteTurnBoundary(sessionId: string): void {
  // A boundary is the only thing that can change the write-lock's answer, so it
  // is also what re-arms a message the lock refused earlier.
  const sessionKey = primaryOf(sessionId);
  releases.set(sessionKey, (releases.get(sessionKey) ?? 0) + 1);
  for (const entry of pending.values()) {
    if (entry.sessionKey !== sessionKey) continue;
    entry.waitingOnLock = false;
    // Try a held message again: the work may be done. If it is not, the
    // runtime holds it again, and the queue shows the latest counts.
    entry.held = undefined;
  }
  const compaction = pendingCompactions.get(sessionKey);
  if (compaction) compaction.waitingOnLock = false;
  schedulePump(sessionId);
}
