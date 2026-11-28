/**
 * How a session's projection folds in the run record (spec
 * `turns-survive-restarts` §4.6, DOR-5212): the runs a snapshot or a
 * `run_update` carries, and the queue a snapshot or a `queue_update` carries,
 * split into the rows waiting in line and the restored drafts.
 *
 * Kept out of `session-stream-store.ts`, which stays under the size rule.
 *
 * @module entities/session/model/stream/chat-runs
 */
import type { ChatRun, RunEnding } from '@dorkos/shared/run-schemas';
import type { MessageDeliveryOutcome, QueuedMessage } from '@dorkos/shared/schemas';
import type { SessionEvent, SessionLifecycle, SessionStatus } from '@dorkos/shared/session-stream';

/** The slice of a session's projection the run record and the queue write. */
export interface RunFoldState {
  runs: ChatRun[];
  restoredDrafts: QueuedMessage[];
  queuedMessages: QueuedMessage[];
  queueOutcomes: Record<string, MessageDeliveryOutcome>;
  inProgressTurn: SessionEvent[];
  status: SessionStatus | null;
  triggerPending: boolean;
}

/** What a session settles to when the record says its open turn ended this way. */
function lifecycleAfter(ending: RunEnding): SessionLifecycle {
  if (ending === 'failed') return 'error';
  if (ending === 'process_died' || ending === 'shutdown' || ending === 'stopped') {
    return 'interrupted';
  }
  return 'idle';
}

/**
 * Take a chat's runs from the record. When the record says the turn this
 * window shows as open has ended (its run's `turn_start` is the open one, and
 * the run is `ended` or `settled`), the window stops reading "working": a
 * turn whose process died never sends the `turn_end` that would say so.
 *
 * Matched by the turn's own `turn_start` seq, so a turn with no run (a task's
 * or a relay's, until they move onto the turn port) is never settled here.
 *
 * @param session - The session's projection.
 * @param runs - The chat's runs, oldest first.
 */
export function applyRuns(session: RunFoldState, runs: ChatRun[]): void {
  session.runs = runs;
  if (session.status?.lifecycle !== 'streaming') return;
  const open = [...session.inProgressTurn].reverse().find((event) => event.type === 'turn_start');
  if (!open) return;
  const run = runs.find((candidate) => candidate.runtimeTurnRef === open.seq);
  if (!run?.ending || (run.status !== 'ended' && run.status !== 'settled')) return;
  // A fresh object: a snapshot's status is the caller's, not a draft of this store's.
  session.status = { ...session.status, lifecycle: lifecycleAfter(run.ending) };
  session.triggerPending = false;
}

/**
 * Take a chat's queue, whole: the rows waiting in line, and apart from them
 * the restored drafts, which never run by themselves (§7.3). Each kept
 * receipt follows its row; a new one rides only the update its message
 * caused, so it names a row that just joined, or one that already ran.
 *
 * @param session - The session's projection.
 * @param queue - The whole queue, in dispatch order.
 * @param outcome - The receipt an accepted message caused, when one did.
 */
export function applyQueue(
  session: RunFoldState,
  queue: QueuedMessage[],
  outcome?: MessageDeliveryOutcome
): void {
  session.queuedMessages = queue.filter((row) => row.restored !== true);
  session.restoredDrafts = queue.filter((row) => row.restored === true);
  const outcomes: Record<string, MessageDeliveryOutcome> = {};
  for (const queued of queue) {
    const kept = session.queueOutcomes[queued.id];
    if (kept) outcomes[queued.id] = kept;
  }
  if (outcome && queue.some((queued) => queued.id === outcome.messageId)) {
    outcomes[outcome.messageId] = outcome;
  }
  session.queueOutcomes = outcomes;
}

/**
 * The line a person sees about the chat's last run (§7.4), or `null`: only
 * while that run is the chat's newest, so the line goes once anything is sent.
 * A continuation DorkOS opened after a restart (`openedBy: 'recovery'`) is
 * not something sent: while it waits, the line about the run it picks back
 * up stays.
 *
 * @param runs - The chat's runs, oldest first.
 */
export function runNoticeOf(runs: readonly ChatRun[]): ChatRun['notice'] {
  const sent = runs.filter((run) => run.openedBy !== 'recovery');
  const last = runs.at(-1);
  return (last?.openedBy === 'recovery' ? sent.at(-1) : last)?.notice ?? null;
}
