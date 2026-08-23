import type { TaskItem, TaskUpdateEvent, SessionTaskStatus } from './schemas.js';

/** When a task's status last changed, for elapsed-time display. */
export interface TaskStatusTimestamp {
  status: SessionTaskStatus;
  since: number;
}

/** In-memory task list state folded from a stream of {@link TaskUpdateEvent}s. */
export interface TaskFoldState {
  tasks: Map<string, TaskItem>;
  statusTimestamps: Map<string, TaskStatusTimestamp>;
  /**
   * Counts `create` events with no id, so each gets its own synthesized key
   * instead of collapsing onto the last one (DOR-1441 S-C — see `create`
   * below). Monotonic per fold instance, so a replay from the durable event
   * log produces the same distinct keys every time.
   */
  legacyCreateCount: number;
}

/** Build an empty {@link TaskFoldState}. */
export function createTaskFoldState(): TaskFoldState {
  return { tasks: new Map(), statusTimestamps: new Map(), legacyCreateCount: 0 };
}

/**
 * Strip empty-string and undefined values from an update event's task
 * fields. `buildTaskEvent` (server) sends `subject: ''` and `status: ''`/`
 * 'pending'` as sentinels when the SDK call didn't include them — stripping
 * these prevents overwriting the existing task's real values during a merge.
 */
function stripUpdateSentinels(task: TaskItem): Partial<TaskItem> {
  const result: Partial<TaskItem> = {};
  for (const [key, value] of Object.entries(task) as [keyof TaskItem, unknown][]) {
    if (value !== undefined && value !== '') {
      (result as Record<string, unknown>)[key] = value;
    }
  }
  return result;
}

/**
 * Apply one {@link TaskUpdateEvent} to fold state, mutating its maps in
 * place.
 *
 * This is the single keying algorithm shared by the client's live-stream
 * fold (`use-task-state.ts`) and the server's JSONL history fold
 * (`task-reader.ts`) — DOR-1441 was exactly these two folds drifting apart.
 * A `TaskCreate` call carries no id from the SDK (only the tool_result
 * does), so `create` stores the task under a caller-supplied provisional
 * key; `id_assigned` re-keys it to the SDK's confirmed real id once the
 * tool_result arrives, and `remove` drops it if the call failed. `update`
 * only ever looks the task up by the SDK's real id directly — there is no
 * heuristic fallback, because a wrong-hit (silently mutating the wrong task)
 * is worse than the no-op it would replace.
 *
 * @param state - Fold state to mutate.
 * @param event - The event to apply.
 * @param now - Timestamp (ms) to record for any status change this event causes.
 */
export function applyTaskEvent(state: TaskFoldState, event: TaskUpdateEvent, now: number): void {
  switch (event.action) {
    case 'snapshot': {
      state.tasks.clear();
      state.statusTimestamps.clear();
      const items = event.tasks ?? [event.task];
      for (const item of items) {
        state.tasks.set(item.id, item);
        state.statusTimestamps.set(item.id, { status: item.status, since: now });
      }
      return;
    }
    case 'create': {
      // Pre-DOR-1441 durable rows carry `task.id: ''` (the old TaskCreate
      // mapper never assigned one). Replaying several of those blindly keyed
      // on `event.task.id` would collapse every one of them onto a single
      // `""` row — synthesize a distinct key per legacy create instead so
      // each one renders as its own row.
      const id = event.task.id || `legacy:${state.legacyCreateCount++}`;
      const task = id === event.task.id ? event.task : { ...event.task, id };
      state.tasks.set(id, task);
      state.statusTimestamps.set(id, { status: task.status, since: now });
      return;
    }
    case 'id_assigned': {
      const previousId = event.previousId;
      if (!previousId) return;
      const existing = state.tasks.get(previousId);
      if (!existing) return;
      const realId = event.task.id;
      state.tasks.delete(previousId);
      state.tasks.set(realId, { ...existing, id: realId });
      const timestamp = state.statusTimestamps.get(previousId);
      state.statusTimestamps.delete(previousId);
      state.statusTimestamps.set(realId, timestamp ?? { status: existing.status, since: now });
      return;
    }
    case 'remove': {
      state.tasks.delete(event.task.id);
      state.statusTimestamps.delete(event.task.id);
      return;
    }
    case 'update': {
      if (!event.task.id) return;
      const existing = state.tasks.get(event.task.id);
      if (!existing) return;
      state.tasks.set(event.task.id, { ...existing, ...stripUpdateSentinels(event.task) });
      if (event.task.status && event.task.status !== existing.status) {
        state.statusTimestamps.set(event.task.id, { status: event.task.status, since: now });
      }
      return;
    }
  }
}
