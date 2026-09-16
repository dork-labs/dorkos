/**
 * Turns the agent started on its own, projected into the session that owns them
 * (spec `warm-process-lifecycle` D6, DOR-2064/DOR-2065).
 *
 * ## What this is for
 *
 * A runtime that holds a process between turns keeps working after a reply
 * ends. A background helper finishes and the runtime delivers its report; the
 * agent picks its own work back up. Those words are part of the session, and
 * until this existed the claude-code adapter DRAINED them — read the stream so
 * its buffer emptied and dropped every frame, with an `error` line saying so.
 * The person watched a finished turn and never saw what their agent said next.
 *
 * So a runtime hands each of those turns here, and this projects it like any
 * other turn: one `turn_start`, the turn's events, one `turn_end`, monotonic
 * `seq`, durable and replayable. The one thing that differs is `origin:
 * 'runtime'`, which is the whole honesty of it — the turn is the AGENT's, not a
 * person's, and the stream says so rather than disguising it as a reply to a
 * message nobody sent.
 *
 * ## It is a detached turn, and it follows the detached-turn rules
 *
 * There is no HTTP request behind a runtime turn, so it is shaped exactly like
 * the two other turns with no request behind them — the room runner's and the
 * task scheduler's. The same {@link DetachedTurnLifecycle} holds the session
 * write-lock for the turn rather than for a response; the same
 * {@link withStallGuard} bounds a turn that goes dark; the same
 * {@link guardTurnErrors} turns a throw into a terminal on the stream instead
 * of an unhandled rejection. Nothing here is a second implementation of any of
 * those — a runtime turn that settled differently from a person's would be a
 * second set of rules for the same durable stream.
 *
 * **The lock holder is reserved.** A runtime turn holds the session under
 * `runtime:<sessionKey>`, and `SessionLockManager.acquireLock` refuses that name
 * to every other caller — only {@link SessionLockManager.acquireRuntimeLock}
 * mints it. Whoever reads a lock's holder is entitled to believe it.
 *
 * ## Two registrations, and why they are at different moments
 *
 * The queue pump is told the session is busy at the window's OPEN, not at the
 * lock acquire, and that gap is the whole point. The lock may take a moment to
 * come free — the previous turn's holder releases as its projection settles —
 * and a queued message launched into that moment would be dispatched into the
 * middle of a turn the agent is already running. So {@link noteRuntimeTurnOpen}
 * claims the dispatcher's in-flight slot synchronously, before this waits for
 * anything, and {@link noteRuntimeTurnClosed} gives it back at `turn_end` and
 * lets the queue move.
 *
 * Nothing is dropped while it waits: the runtime buffers the turn's frames, and
 * says so loudly rather than discarding them if that buffer ever grows past
 * what a brief wait could explain.
 *
 * Lives in its own directory rather than flat in `services/session/`, which is
 * already past `check-dir-size.sh`'s error threshold — that gate blocks a commit
 * ADDING a source file to such a directory, and splitting is the remedy it asks
 * for.
 *
 * @module services/session/runtime-turns/runtime-turn
 */
import type { AgentRuntime } from '@dorkos/shared/agent-runtime';
import type { StreamEvent } from '@dorkos/shared/types';
import { SESSIONS } from '../../../config/constants.js';
import { logError, logger } from '../../../lib/logger.js';
import {
  noteRuntimeTurnClosed,
  noteRuntimeTurnOpen,
  noteTurnBoundary,
} from '../message-dispatcher.js';
import { persistenceModeFor } from '../projector-persistence.js';
import { runtimeLockHolder } from '../session-lock.js';
import { feedProjector } from '../session-event-normalizer.js';
import { getOrCreateProjector } from '../session-state-projector.js';
import { withStallGuard } from '../stall-guard.js';
import { DetachedTurnLifecycle, guardTurnErrors, tapEachEvent } from '../trigger-turn.js';

/**
 * How long a runtime turn waits for the session's write-lock before giving up
 * on holding it.
 *
 * A runtime turn opens when the process speaks with no dispatched window open,
 * so the lock is normally free or milliseconds from it — the previous turn's
 * holder releases as its projection settles. This bounds the pathological case
 * rather than the ordinary one, and it is the lock's own TTL because a lock
 * held longer than that is by definition reclaimable.
 */
const LOCK_WAIT_MS = SESSIONS.LOCK_TTL_MS;

/** How often the wait re-asks for a lock somebody else still holds. */
const LOCK_RETRY_MS = 50;

/**
 * Subscribe a runtime's agent-initiated turns to the durable session stream.
 *
 * A no-op for a runtime that cannot produce one — a backend whose output only
 * ever answers a dispatch omits `onRuntimeTurn`, and there is nothing to
 * listen to.
 *
 * @param runtime - The runtime to listen to
 * @returns Unsubscribes, or `undefined` when this runtime has no such turns
 */
export function subscribeRuntimeTurns(runtime: AgentRuntime): (() => void) | undefined {
  const turns = runtime.onRuntimeTurn?.((sessionId, events) => {
    // Claimed SYNCHRONOUSLY, before the first await: the window is open and the
    // process is already talking, so the queue may not launch anything into it
    // from this moment on. See the module doc.
    noteRuntimeTurnOpen(sessionId);
    // Defense in depth. `projectRuntimeTurn` contains its own failures, but an
    // unhandled rejection escaping here would be swallowed by the server's
    // global handler, and the only symptom would be a chat that quietly stopped
    // answering with nothing in the log naming the session.
    void projectRuntimeTurn(runtime, sessionId, events).catch((err) => {
      logger.error('[runtime-turn] a turn the agent started could not be projected', {
        sessionId,
        ...logError(err),
      });
    });
  });
  // The other half of the pending-segment gate. `isSegmentPending` holds a
  // person's queued message while a helper's report is on its way; this is how
  // the queue learns that hold has dropped. Without it a session sitting idle —
  // no turn boundary coming, nothing else to pump it — would hold that message
  // until something unrelated happened along (spec `warm-process-lifecycle` D1).
  const gates = runtime.onDispatchGateChange?.((sessionId) => {
    noteTurnBoundary(sessionId);
  });
  if (turns === undefined && gates === undefined) return undefined;
  return () => {
    turns?.();
    gates?.();
  };
}

/**
 * Project one agent-initiated turn, holding the session for its duration.
 *
 * Never throws, and that is load-bearing rather than tidy: it is called from a
 * runtime's own message loop by way of a detached promise, and the session's
 * in-flight slot was claimed before it was called. A failure has to become a
 * terminal on the stream and a log line — exactly as a person's failed turn
 * does — and it must still hand the session back, or the queue behind it never
 * moves again.
 *
 * @param runtime - The runtime whose turn this is
 * @param sessionId - The session it belongs to, in any id it answers to
 * @param events - One turn's events, ending when the turn does
 */
async function projectRuntimeTurn(
  runtime: AgentRuntime,
  sessionId: string,
  events: AsyncIterable<StreamEvent>
): Promise<void> {
  // **Everything that can throw belongs INSIDE the try below.** The subscriber
  // already claimed this session's in-flight slot, synchronously, before this
  // function was called — so a throw out here would skip the `finally`,
  // `releaseOnce` would never run, and the session would hold a slot nothing
  // can release for the life of the process. Its next message, and every one
  // after it, is then accepted and made durable and never sent; the server's
  // global `unhandledRejection` handler swallows the throw, so the only symptom
  // is a chat that silently stops answering.
  //
  // **Two different keys, on purpose.** The queue claim keys on
  // `primaryOf(sessionId)`, inside `noteRuntimeTurnOpen`/`noteRuntimeTurnClosed`;
  // the LOCK keys on the runtime's own `getInternalSessionId(sessionId) ??
  // sessionId`. Each layer resolves by what it owns, and they cannot mismatch
  // here because the claim and the release are handed the same raw `sessionId`
  // and each does its own resolution.
  let turnKey = sessionId;
  let holder = runtimeLockHolder(sessionId);
  let lifecycle: DetachedTurnLifecycle | undefined;
  const lockToken = Symbol('runtime-turn-lock');

  let released = false;
  const releaseOnce = (): void => {
    if (released) return;
    released = true;
    // Both tolerate never having been reached: `releaseLock` is a no-op unless
    // this token holds the lock, and a lifecycle that was never built has
    // nothing to close.
    runtime.releaseLock(turnKey, holder, lockToken);
    lifecycle?.close();
    // The queue is told last, and always: a runtime turn that ends without
    // handing the session back would hold every queued message for the life of
    // the process.
    noteRuntimeTurnClosed(sessionId);
  };

  try {
    // The id the RUNTIME resolves to, which is what the lock keys on — never
    // the id this call happened to carry.
    turnKey = runtime.getInternalSessionId(sessionId) ?? sessionId;
    holder = runtimeLockHolder(turnKey);
    const projector = getOrCreateProjector(sessionId, undefined, {
      persist: persistenceModeFor(runtime.getCapabilities()),
    });
    const waitingOnPerson = (): boolean => projector.hasPendingInteractions();
    // Bound to a `const` as well, so the closures below need no non-null
    // assertion to reach it.
    const turnLifecycle = new DetachedTurnLifecycle(waitingOnPerson);
    lifecycle = turnLifecycle;
    if (!(await acquireWhenFree(runtime, turnKey, turnLifecycle, lockToken))) {
      // Somebody held this session for longer than a lock may be held. The turn
      // cannot be projected under a lock this never got, and the alternative —
      // projecting anyway — is the concurrent writer the lock exists to prevent.
      logger.error('[runtime-turn] gave up waiting for the session lock', {
        sessionId,
        turnKey,
        waitedMs: LOCK_WAIT_MS,
      });
      await drain(events);
      return;
    }
    const tapped = tapEachEvent(events, () => {
      // Proof of life for the write-lock: a turn visibly producing events must
      // never be declared abandoned and stolen mid-flight (DOR-782).
      turnLifecycle.touch();
    });
    const guarded = guardTurnErrors(
      projector,
      withStallGuard(tapped, {
        sessionId,
        // The ORDINARY bound, deliberately (spec D6, open question 9): a turn
        // nobody asked for is still a turn, and an agent that has gone dark
        // holding the session is exactly what the watchdog is for.
        timeoutMs: SESSIONS.TURN_STALL_TIMEOUT_MS,
        firstEventTimeoutMs: SESSIONS.TURN_FIRST_EVENT_TIMEOUT_MS,
        isPaused: waitingOnPerson,
        onStall: () => runtime.interruptQuery(sessionId),
      }),
      (err) => {
        logger.warn('[runtime-turn] a turn the agent started failed', {
          sessionId,
          ...logError(err),
        });
      }
    );
    // No `userMessage`: nobody typed one. `origin: 'runtime'` is what keeps the
    // client from counting this as a person's turn, ageing their sign-in cards,
    // or blanking the reply before it.
    await feedProjector(projector, guarded, { origin: 'runtime' });
  } catch (err) {
    logger.warn('[runtime-turn] failed to project a turn the agent started', {
      sessionId,
      ...logError(err),
    });
  } finally {
    releaseOnce();
  }
}

/**
 * Take the session's write-lock as soon as whoever holds it lets go.
 *
 * The previous holder is normally a turn that has just ended and is settling
 * its projection, so this usually succeeds first time or within a tick.
 *
 * @param runtime - The runtime whose lock manager answers
 * @param turnKey - The resolved session id the lock is keyed on
 * @param lifecycle - The turn's liveness witness, which becomes the lock holder
 * @param lockToken - This acquisition's identity, threaded into the release
 * @returns True when the lock was taken inside {@link LOCK_WAIT_MS}
 */
async function acquireWhenFree(
  runtime: AgentRuntime,
  turnKey: string,
  lifecycle: DetachedTurnLifecycle,
  lockToken: symbol
): Promise<boolean> {
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    if (runtime.acquireRuntimeLock?.(turnKey, lifecycle, lockToken) === true) return true;
    if (Date.now() >= deadline) return false;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, LOCK_RETRY_MS);
      timer.unref?.();
    });
  }
}

/**
 * Read a turn nothing will project, so the runtime's buffer empties.
 *
 * Only reached when the lock never came free — a turn is never silently
 * discarded on any healthy path, and the caller has already said at `error`
 * that this one was.
 *
 * @param events - The turn's events
 */
async function drain(events: AsyncIterable<StreamEvent>): Promise<void> {
  try {
    for await (const _event of events) {
      // Read and dropped: see the caller's `error` line.
    }
  } catch {
    // A stream that fails while being abandoned has nothing left to report.
  }
}
