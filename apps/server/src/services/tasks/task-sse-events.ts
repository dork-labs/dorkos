/**
 * SSE broadcast helper for task definition changes.
 *
 * The sibling of `services/relay/relay-sse-events.ts`, and it exists for the
 * same reason: something app-wide has to notice that a task's settings moved,
 * without polling for it. The Tasks list, the Activity feed and the
 * pending-schedule-approval strip all re-read on it, so a schedule an agent
 * proposes shows up as it is written, not on the next refresh.
 *
 * Deliberately fired from the task ROUTES and the `tasks_*` MCP tools (three
 * call sites: `tasks_update`, `tasks_delete`, and — since DOR-1380 —
 * `tasks_create`), never from the store. Broadcasting from the store would add
 * a burst of events during reconciliation that no reader needs.
 *
 * The payload is an invalidation trigger, not a diff.
 *
 * @module services/tasks/task-sse-events
 */
import { eventFanOut } from '../core/event-fan-out.js';

/**
 * Broadcast that a task definition changed (create, update, or delete).
 * Connected clients re-read whatever they derive from the task set.
 */
export function broadcastTasksChanged(): void {
  eventFanOut.broadcast('tasks_changed', { changedAt: new Date().toISOString() });
}
