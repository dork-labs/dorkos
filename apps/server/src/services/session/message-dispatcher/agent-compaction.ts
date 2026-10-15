/**
 * Summaries an agent asked for (DOR-2732), held until the session is free and
 * then started ahead of anything queued; see the dispatcher's module doc.
 *
 * @module services/session/message-dispatcher/agent-compaction
 */
import type { AgentRuntime } from '@dorkos/shared/agent-runtime';
import { primaryOf, projectorFor } from '../resolution/session-key-registry.js';
import { SESSIONS } from '../../../config/constants.js';
import { logger } from '../../../lib/logger.js';
import { pendingCompactions } from './state.js';
import { hasHeldMessage, schedulePump } from './pump.js';
import type { PendingAgentCompaction } from './types.js';

/** Why a waiting summary that hit its ceiling was dropped, for the log line. */
export const TOO_LONG = 'it waited too long for the session to come free';

/** Inputs for {@link scheduleAgentCompaction}. */
export interface ScheduleAgentCompactionOpts {
  /** The session the agent is running in, by any id it answers to. */
  sessionId: string;
  /** The runtime that session resolves to. */
  runtime: AgentRuntime;
  /**
   * Start the compaction — normally {@link dispatchCommandIntent} with the
   * agent's tag. Must claim the session synchronously, before its first await,
   * which `dispatchCommandIntent` does.
   */
  launch: () => Promise<{ accepted: boolean }>;
  /** Re-checked just before it starts; `false` drops it (the owner blocked it since). */
  admit?: () => Promise<boolean>;
  /** Called if it is dropped without running, to give its allowance back. */
  onDropped?: () => void;
}

/**
 * Hold a summary the agent asked for until its session is free, then run it
 * ahead of anything queued (see the module doc's DOR-2732 section).
 *
 * @param opts - The session, its runtime and how to start the compaction.
 * @returns `false` when the session already has one waiting or starting — a
 *   second request never becomes a second summary, and the caller gives back
 *   whatever it spent on this one.
 */
export function scheduleAgentCompaction(opts: ScheduleAgentCompactionOpts): boolean {
  const sessionKey = primaryOf(opts.runtime.getInternalSessionId(opts.sessionId) ?? opts.sessionId);
  if (pendingCompactions.has(sessionKey)) return false;
  const entry: PendingAgentCompaction = {
    sessionId: opts.sessionId,
    runtime: opts.runtime,
    launch: opts.launch,
    ...(opts.admit !== undefined ? { admit: opts.admit } : {}),
    ...(opts.onDropped !== undefined ? { onDropped: opts.onDropped } : {}),
    admitted: false,
    launching: false,
    waitingOnLock: false,
    deadline: setTimeout(() => {
      if (pendingCompactions.get(sessionKey) !== entry) return;
      // An attempt already out is left to finish, and marked: if it does not
      // end in a running summary, the drop happens when it comes back.
      if (entry.launching) {
        entry.expired = true;
        return;
      }
      dropCompaction(sessionKey, entry, TOO_LONG);
    }, SESSIONS.AGENT_COMPACTION_MAX_WAIT_MS),
  };
  entry.deadline.unref?.();
  pendingCompactions.set(sessionKey, entry);
  // The calling turn is still running, so this pump finds the session busy and
  // does nothing; it is here for a request that arrives on a session that is
  // already free, which then does not wait for a boundary that never comes.
  schedulePump(sessionKey);
  return true;
}

/**
 * Whether a session has an agent-requested summary waiting or starting.
 *
 * @param sessionId - The session, by any id it answers to.
 * @param runtime - The runtime it resolves to, for the canonical id.
 */
export function hasPendingAgentCompaction(
  sessionId: string,
  runtime: Pick<AgentRuntime, 'getInternalSessionId'>
): boolean {
  return pendingCompactions.has(primaryOf(runtime.getInternalSessionId(sessionId) ?? sessionId));
}

/**
 * Stop a waiting compaction's clocks.
 *
 * @param entry - The waiting compaction.
 */
export function clearCompactionTimers(entry: PendingAgentCompaction): void {
  clearTimeout(entry.deadline);
  if (entry.recheck !== undefined) clearTimeout(entry.recheck);
  entry.recheck = undefined;
}

/**
 * Drop a waiting compaction that will never run, giving its allowance back.
 *
 * @param sessionKey - The session's primary id.
 * @param entry - The entry being dropped; a newer one under the key is left alone.
 * @param why - For the log line.
 */
export function dropCompaction(
  sessionKey: string,
  entry: PendingAgentCompaction,
  why: string
): void {
  if (pendingCompactions.get(sessionKey) !== entry) return;
  pendingCompactions.delete(sessionKey);
  clearCompactionTimers(entry);
  try {
    entry.onDropped?.();
  } catch (err) {
    logger.warn('[MessageDispatcher] giving back a dropped compaction’s allowance failed', {
      sessionId: sessionKey,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  logger.info('[MessageDispatcher] dropped an agent-requested compaction', {
    sessionId: sessionKey,
    reason: why,
  });
  schedulePump(sessionKey);
}

/**
 * Whether the RUNTIME reports a turn open on this session, under either id it
 * answers to. The server's own bookkeeping cannot see a turn it did not
 * dispatch — a Relay delivery or an unattended scheduled run calls the runtime
 * directly — and the agent in that turn holds the same tools.
 *
 * @param entry - The waiting compaction.
 */
export function runtimeTurnOpen(entry: PendingAgentCompaction): boolean {
  const { runtime } = entry;
  if (runtime.isTurnOpen === undefined) return false;
  const lockKey = runtime.getInternalSessionId(entry.sessionId) ?? entry.sessionId;
  return (
    runtime.isTurnOpen(lockKey) ||
    (lockKey !== entry.sessionId && runtime.isTurnOpen(entry.sessionId))
  );
}

/**
 * Whether the write-lock is held, asked under the canonical id the lock is
 * held under, exactly as {@link isTurnInFlight} asks.
 *
 * @param entry - The waiting compaction.
 */
export function compactionLockHeld(entry: PendingAgentCompaction): boolean {
  const lockKey = entry.runtime.getInternalSessionId(entry.sessionId) ?? entry.sessionId;
  return (
    entry.runtime.isLocked(lockKey) ||
    (lockKey !== entry.sessionId && entry.runtime.isLocked(entry.sessionId))
  );
}

/**
 * Start the session's waiting agent compaction if the session is free.
 *
 * Called by the pump after its own two gates (nothing parked on a person, no
 * in-flight slot), and asks every other authority that can know a turn is
 * running or about to: the projector's open turn, the runtime's own report of a
 * turn the server never dispatched, a message held for the agent's background
 * work, a delivery the runtime already owes, and the write-lock. The slot alone
 * is lossy, and a summary started under a live turn is exactly the mid-turn
 * compaction this exists to prevent.
 *
 * A turn only the runtime can see ends with no boundary the dispatcher hears,
 * so while one is open this arms a look-again on
 * {@link SESSIONS.AGENT_COMPACTION_RECHECK_MS} — bounded, like everything a
 * waiting compaction does, by its deadline.
 *
 * Must be called with the dispatch mutex held.
 *
 * @param sessionKey - The session's primary id.
 * @returns True when the queue behind it must wait: a compaction is starting
 *   or the session is still busy with a turn.
 */
export function launchDueCompaction(sessionKey: string): boolean {
  const entry = pendingCompactions.get(sessionKey);
  if (!entry) return false;
  if (entry.launching) return true;
  // Refused by a lock somebody else holds: the queue may try its own luck, and
  // this waits for the boundary that changes the lock's answer.
  if (entry.waitingOnLock) return false;
  if ((projectorFor(sessionKey)?.peekInProgressTurn() ?? null) !== null) return true;
  if (runtimeTurnOpen(entry)) {
    if (entry.recheck === undefined) {
      entry.recheck = setTimeout(() => {
        entry.recheck = undefined;
        schedulePump(sessionKey);
      }, SESSIONS.AGENT_COMPACTION_RECHECK_MS);
      entry.recheck.unref?.();
    }
    return false;
  }
  // The two gates the queue head respects, for the same reasons: starting now
  // would end the agent's background work, or would run beside a delivery the
  // runtime already owes. Both are released by a boundary or the runtime's
  // gate change, each of which pumps again.
  if (hasHeldMessage(sessionKey)) return false;
  if (entry.runtime.isSegmentPending?.(sessionKey) === true) return false;
  if (compactionLockHeld(entry)) return false;

  entry.launching = true;
  if (!entry.admitted && entry.admit !== undefined) {
    // Asked once, here, rather than only at the request: the owner may have
    // blocked it since. Answered off the mutex, then the pump looks again with
    // every gate re-asked, because the session may have moved meanwhile.
    void entry.admit().then(
      (allowed) => {
        if (pendingCompactions.get(sessionKey) !== entry) return;
        entry.launching = false;
        if (!allowed) {
          dropCompaction(sessionKey, entry, 'the owner blocked it after it was asked for');
          return;
        }
        if (entry.expired) {
          dropCompaction(sessionKey, entry, TOO_LONG);
          return;
        }
        entry.admitted = true;
        schedulePump(sessionKey);
      },
      () => {
        entry.launching = false;
        dropCompaction(sessionKey, entry, 'whether it is still allowed could not be read');
      }
    );
    return true;
  }

  const settle = (accepted: boolean): void => {
    if (pendingCompactions.get(sessionKey) !== entry) return;
    if (accepted) {
      pendingCompactions.delete(sessionKey);
      clearCompactionTimers(entry);
      return;
    }
    entry.launching = false;
    // Refused by the lock after its deadline passed mid-launch: the ceiling
    // still holds, it just lands here instead of on the timer.
    if (entry.expired) {
      dropCompaction(sessionKey, entry, TOO_LONG);
      return;
    }
    entry.waitingOnLock = true;
    // Let the queue behind it move now rather than at the next boundary.
    schedulePump(sessionKey);
  };
  // A launch that threw ran nothing and will not run better by retrying: drop
  // it, so the session is not held for a summary that cannot start.
  const failed = (err: unknown): void => {
    logger.warn('[MessageDispatcher] an agent-requested compaction could not start', {
      sessionId: sessionKey,
      error: err instanceof Error ? err.message : String(err),
    });
    entry.launching = false;
    dropCompaction(sessionKey, entry, 'its launch failed');
  };
  try {
    void entry.launch().then((result) => settle(result.accepted), failed);
  } catch (err) {
    failed(err);
    return false;
  }
  return true;
}
