/**
 * Fold a turn's `subagent_update` events into one row per subagent.
 *
 * The chat bubble folds the same events into a `background_task` message part;
 * this fold produces a session-level list instead — no message, no ordering
 * inside a transcript, just "what is running right now". Same merge rule as the
 * bubble's (field-wise upsert keyed by `taskId`, absent fields keep their prior
 * value), because the runtime emits partial updates: the start carries the
 * description, progress carries the tool tally, the terminal update carries the
 * summary.
 *
 * @module features/status/lib/fold-active-subagents
 */
import type { SessionEvent } from '@dorkos/shared/session-stream';
import type { ActiveSubagent } from '../model/session-diagnostics';

/**
 * Project the turn's events onto one {@link ActiveSubagent} per task, in the
 * order each first appeared.
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
