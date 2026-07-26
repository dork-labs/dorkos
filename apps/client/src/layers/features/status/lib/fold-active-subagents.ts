/**
 * Fold a turn's `subagent_update` events into one row per subagent.
 *
 * The chat bubble folds the same events into a `background_task` message part;
 * this fold produces a session-level list instead — no message, no ordering
 * inside a transcript, just "what did this turn hand off, and how did it go".
 * Same merge rule as the bubble's (field-wise upsert keyed by `taskId`, absent
 * fields keep their prior value), because the runtime emits partial updates: the
 * start carries the description, progress carries the tool tally, the terminal
 * update carries the summary.
 *
 * **The fold keeps terminal rows.** One row per `taskId` survives to the end of
 * the turn — a subagent that finished is still in the list, carrying its terminal
 * status — and the store keeps the turn's events after `turn_end` until the
 * reconcile reloads canonical history. So "in this list" never means "running":
 * every reader partitions with {@link partitionSubagents} first.
 *
 * @module features/status/lib/fold-active-subagents
 */
import type { SessionEvent } from '@dorkos/shared/session-stream';
import type { ActiveSubagent } from '../model/session-diagnostics';

/**
 * Project the turn's events onto one {@link ActiveSubagent} per task, in the
 * order each first appeared — running and finished alike.
 *
 * @param events - The store's `inProgressTurn` events, in seq order.
 */
export function foldActiveSubagents(events: readonly SessionEvent[]): ActiveSubagent[] {
  const byTask = new Map<string, ActiveSubagent>();
  for (const event of events) {
    if (event.type !== 'subagent_update') continue;
    const existing = byTask.get(event.taskId);
    byTask.set(event.taskId, {
      taskId: event.taskId,
      status: event.status,
      description: event.description ?? existing?.description,
      toolUses: event.toolUses ?? existing?.toolUses,
      lastToolName: event.lastToolName ?? existing?.lastToolName,
      summary: event.summary ?? existing?.summary,
    });
  }
  return [...byTask.values()];
}

/** A fold split by whether each subagent is still in flight. */
export interface PartitionedSubagents {
  /** Still in flight — the only rows a surface may call "running". */
  running: ActiveSubagent[];
  /** Reached a terminal status during this turn: complete, error, or stopped. */
  finished: ActiveSubagent[];
}

/**
 * Split a fold into what is still running and what finished during this turn.
 *
 * `running` is the only `BackgroundTaskStatus` that is still in flight, so
 * everything else is finished — including `stopped` and `error`. Written as a
 * negative check on purpose: enumerating the terminal statuses instead would
 * silently drop a fifth one the day a runtime adds it.
 *
 * @param rows - A {@link foldActiveSubagents} result.
 */
export function partitionSubagents(rows: readonly ActiveSubagent[]): PartitionedSubagents {
  const running: ActiveSubagent[] = [];
  const finished: ActiveSubagent[] = [];
  for (const row of rows) {
    if (row.status === 'running') running.push(row);
    else finished.push(row);
  }
  return { running, finished };
}
