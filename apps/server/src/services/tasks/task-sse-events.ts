/**
 * SSE broadcast helper for task definition changes.
 *
 * The sibling of `services/relay/relay-sse-events.ts`, and it exists for the
 * same reason: something app-wide has to notice that a task's settings moved,
 * without polling for it. The standing unattended-autonomy banner is the first
 * such reader — a person who dials a task up to Full autonomy should see the
 * banner appear as they close the form, not on their next refresh.
 *
 * Deliberately fired from the task ROUTES and the `tasks_*` MCP tools (three
 * call sites: `tasks_update`, `tasks_delete`, and — since DOR-1380 —
 * `tasks_create`), never from the store. Those are the only writers that can
 * raise a task's permission mode: `task-write-policy` classifies that field
 * operator-only, and both content paths into the same row (a Shape manifest, a
 * SKILL.md on disk) are clamped by `schedule-permission-clamp`, so no watcher
 * or reconciler write can introduce the posture this signal exists to
 * announce. Broadcasting from the store would add a burst of events during
 * reconciliation for no reader.
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
