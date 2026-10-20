/**
 * Upkeep of the queue outside a turn: sweeping the queues of sessions that have
 * gone away, listing a queue, disarming a removed message, and suspending a
 * stopped host's protected dispatches.
 *
 * @module services/session/message-dispatcher/queue-upkeep
 */
import type { QueuedMessage } from '@dorkos/shared/schemas';
import {
  getMessageQueueStore,
  setQueuedWaitingOn,
  toQueuedMessage,
} from '../message-queue-store.js';
import {
  forgetSessionAliases,
  primaryOf,
  projectorFor,
  queueKeyOf,
} from '../resolution/session-key-registry.js';
import { getStagedContextStore } from '../staged-context-store.js';
import { forgetContextWarning } from '../agent-compaction/context-warning.js';
import { logger } from '../../../lib/logger.js';
import {
  emitLifecycle,
  inFlight,
  launching,
  orphanedSessions,
  pending,
  pendingCompactions,
  privateLaunches,
  sweptWhileLaunching,
} from './state.js';
import { dropCompaction } from './agent-compaction.js';

/**
 * How many session ids the orphan sweep hands to one `DELETE ... IN (...)`.
 *
 * SQLite's compiled-in variable ceiling is ~32k and every id is one variable, so
 * a fleet with more orphans than that would fail the whole delete rather than
 * some of it. 500 is far below the ceiling and still one statement per 500
 * sessions.
 */
export const SWEEP_CHUNK_SIZE = 500;

/**
 * Record that the fleet has reported a session gone, so the sweep can reclaim
 * whatever it left queued.
 *
 * Keyed on ORPHANING — the session no longer exists as far as any runtime is
 * concerned — and deliberately NOT on in-memory eviction. An evicted session is
 * still perfectly real: it comes back the moment somebody opens it, and its
 * queue must come back with it.
 *
 * @param sessionId - The session the fleet reported removed
 */
export function noteSessionOrphaned(sessionId: string): void {
  orphanedSessions.add(primaryOf(sessionId));
}

/**
 * Delete the queued messages of every session that has gone away, and report
 * how many rows went.
 *
 * Called on the existing health-check cadence rather than on its own timer. A
 * session that has come back to life since it was reported gone is spared: the
 * report is a signal, not a verdict, and dropping somebody's queued words
 * because a watcher blinked is the one outcome worth guarding against.
 *
 * @param opts.isLive - Answers "is this session alive after all?"; defaults to
 *   asking the projector registry
 */
export function sweepOrphanedMessageQueues(opts?: {
  isLive?: (sessionId: string) => boolean;
}): number {
  if (orphanedSessions.size === 0) return 0;
  const isLive = opts?.isLive ?? ((id: string) => projectorFor(id) !== undefined);
  const candidates = [...orphanedSessions];
  orphanedSessions.clear();
  const doomed = candidates.filter((id) => !isLive(id) && !inFlight.has(id));
  const store = getMessageQueueStore();
  const staged = getStagedContextStore();
  let removed = 0;
  for (let i = 0; i < doomed.length; i += SWEEP_CHUNK_SIZE) {
    const chunk = doomed.slice(i, i + SWEEP_CHUNK_SIZE).map(queueKeyOf);
    // Named before they go, so a sender waiting on one hears it will never run,
    // and so an armed entry cannot fire a row that no longer exists.
    const gone = chunk.flatMap((id) => store?.list(id) ?? []);
    removed += store?.deleteForSessions(chunk) ?? 0;
    for (const row of gone) {
      setQueuedWaitingOn(row.id, undefined);
      if (launching.has(row.id)) {
        sweptWhileLaunching.add(row.id);
        continue;
      }
      const entry = pending.get(row.id);
      pending.delete(row.id);
      emitLifecycle({ phase: 'dropped', messageId: row.id, reason: 'session_gone' });
      if (entry) {
        clearTimeout(entry.timer);
        entry.abandon();
      }
    }
    // Held staged words go with the queue: same reason, same beat. A session
    // nobody can open again will never dispatch, so its hold can only sit there
    // for the life of the install.
    staged?.deleteForSessions(chunk);
  }
  // So does a summary the agent asked for: there is no conversation left to summarize.
  for (const id of doomed) {
    const compaction = pendingCompactions.get(id);
    if (compaction) dropCompaction(id, compaction, 'its session went away');
    forgetContextWarning(id);
  }
  // The rename bookkeeping goes with them. Two entries are added per renamed
  // session and nothing has ever removed one, so a long-lived server accumulates
  // a pair for every session it ever started — small, but unbounded, and the
  // sweep is the one place that already knows a session is gone for good.
  for (const id of doomed) forgetSessionAliases(id);
  if (removed > 0) {
    logger.info('[MessageDispatcher] swept queued messages of vanished sessions', {
      sessions: doomed.length,
      rows: removed,
    });
  }
  return removed;
}

/**
 * A session's queue as every client sees it — the head first.
 *
 * @param sessionId - The session to read
 */
export function listQueuedMessages(sessionId: string): QueuedMessage[] {
  return (getMessageQueueStore()?.list(queueKeyOf(sessionId)) ?? []).map(toQueuedMessage);
}

/** Drop only a stopped host lane's timers; its accepted receipts and queue rows remain durable. */
export async function suspendPrivateDispatches(signal: AbortSignal): Promise<void> {
  if (!signal.aborted) throw new Error('Private dispatch lifetime is still active.');
  for (const [id, entry] of pending) {
    if (entry.privateDispatchSignal !== signal) continue;
    clearTimeout(entry.timer);
    pending.delete(id);
  }
  await Promise.allSettled([...(privateLaunches.get(signal) ?? [])]);
}

/**
 * Disarm the pending dispatch of a message somebody took off the queue.
 *
 * The dispatcher owns the pending set, so removing a row without telling it
 * would leave the message armed: it would fire anyway one turn boundary later,
 * which is the worst possible reading of a Remove. Called by
 * {@link cancelQueuedMessage}, which owns the row half of the same act.
 *
 * @param messageId - The server-minted message id
 * @returns True when a dispatch was armed and is now cancelled
 */
export function cancelPendingDispatch(messageId: string): boolean {
  // A launch already under way is NOT dropped here: its turn may still start,
  // and if it does not, `returnToQueue` finds no row and reports the drop and
  // settles the caller itself. Saying "removed" now could be followed by the
  // same message's `started`.
  if (launching.has(messageId)) return false;
  // Reported whether or not an entry was armed: a row adopted by nobody yet
  // (after a restart) is removed just as surely, and its sender is owed the
  // same answer.
  emitLifecycle({ phase: 'dropped', messageId, reason: 'removed' });
  const entry = pending.get(messageId);
  if (!entry) return false;
  clearTimeout(entry.timer);
  pending.delete(messageId);
  entry.abandon();
  return true;
}
