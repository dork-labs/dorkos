/**
 * Forward projected `todo_update` session events to the task panel (CLI-B4).
 *
 * The legacy in-band stream called `onTaskEvent` per `task_update` frame; under
 * the durable `/events` contract those events land in the stream store's
 * `inProgressTurn` instead, where the bubble projection (correctly) skips them
 * — so the TaskListPanel and its celebrations never saw a live update. This
 * hook watches the projected turn and forwards each NEWLY-streamed
 * `todo_update` to the panel's handler exactly once.
 *
 * Snapshot-hydrated events are suppressed: anything with `seq <= ` the
 * snapshot cursor was replayed state, already covered by the `['tasks']` query
 * — re-firing it would pop celebrations for long-finished tasks on every
 * reconnect. A new snapshot (reconnect, server restart with a fresh seq space)
 * resets the per-session watermark to its cursor.
 *
 * @module features/chat/model/use-todo-events
 */
import { useEffect, useRef } from 'react';
import type { TaskUpdateEvent } from '@dorkos/shared/types';
import type { SessionEvent } from '@dorkos/shared/session-stream';

/** Per-session forwarding bookkeeping. */
interface TodoWatermark {
  /** The snapshot cursor this watermark was last anchored to. */
  floor: number;
  /** Highest seq already forwarded (or suppressed as snapshot state). */
  seen: number;
}

/**
 * Forward newly-streamed `todo_update` events from the projected in-progress
 * turn to `onTaskEvent` (the TaskListPanel + celebrations pipeline).
 *
 * @param sessionId - The active session, or `null`.
 * @param inProgressTurn - The stream store's projected turn events (seq order).
 * @param streamReadyCursor - The session's snapshot cursor (`null` pre-hydration).
 * @param onTaskEvent - The task panel's event handler.
 */
export function useTodoEvents(
  sessionId: string | null,
  inProgressTurn: SessionEvent[],
  streamReadyCursor: number | null,
  onTaskEvent?: (event: TaskUpdateEvent) => void
): void {
  const watermarksRef = useRef<Map<string, TodoWatermark>>(new Map());
  const onTaskEventRef = useRef(onTaskEvent);
  useEffect(() => {
    onTaskEventRef.current = onTaskEvent;
  });

  useEffect(() => {
    if (!sessionId) return;
    const watermarks = watermarksRef.current;
    const floor = streamReadyCursor ?? 0;
    let mark = watermarks.get(sessionId);
    // First observation, or a NEW snapshot re-anchored the session (reconnect /
    // server-restart seq reset): everything at or below its cursor is hydrated
    // state, not a live stream — start forwarding strictly above it.
    if (!mark || mark.floor !== floor) {
      mark = { floor, seen: floor };
      watermarks.set(sessionId, mark);
    }
    for (const event of inProgressTurn) {
      if (event.seq <= mark.seen) continue;
      if (event.type === 'todo_update') {
        onTaskEventRef.current?.({ action: event.action, task: event.task, tasks: event.tasks });
      }
      mark.seen = event.seq;
    }
  }, [sessionId, inProgressTurn, streamReadyCursor]);
}
