/**
 * The TaskStore run-terminal hook's consumers, and the listener that composes
 * them (DOR-403, DOR-240, DOR-1573).
 *
 * The hook is the single seam that fires exactly once per non-terminal →
 * terminal transition, for BOTH scheduler-side writes and the relay-delivered
 * writes the receiver makes through `updateRun(...)`. `setOnRunTerminal` holds a
 * single listener, so the three consumers are composed here into one and wired
 * in `index.ts` via {@link createRunTerminalListener}.
 *
 * @module services/tasks/run-terminal-broadcaster
 */
import type { TaskRun } from '@dorkos/shared/types';
import { eventFanOut } from '../core/event-fan-out.js';
import type { RunTerminalListener } from './task-store.js';
import type { ActivityService } from '../activity/activity-service.js';
import { notifyRunCompleted } from '../notifications/emitters/run-completed.js';
import { emitTerminalRunActivity } from './run-activity.js';

/**
 * Broadcast `task_run_failed` on `/api/events` when a terminal run failed.
 *
 * A no-op for non-failure terminal statuses (`completed`/`cancelled`). Because
 * the run-terminal hook fires exactly once per terminal transition and never on
 * an already-terminal re-write, this cannot double-fire or fire on a poll
 * re-observation.
 *
 * @param run - The run as persisted at its terminal write.
 */
export function broadcastRunTerminal(run: TaskRun): void {
  if (run.status !== 'failed') return;
  eventFanOut.broadcast('task_run_failed', {
    runId: run.id,
    scheduleId: run.scheduleId,
    failedAt: run.finishedAt ?? new Date().toISOString(),
  });
}

/**
 * Build the run-terminal listener that `index.ts` registers on the TaskStore.
 *
 * Composes the three consumers that ride the one terminal seam:
 *   1. {@link broadcastRunTerminal} — the Pulse "needs attention" badge ticks the
 *      instant a run fails, on every dispatch path.
 *   2. `notifyRunCompleted` — the inbox row for a finished run, plus the chat
 *      ping when an integration can carry it.
 *   3. {@link emitTerminalRunActivity} — the live activity-feed event for a
 *      completed or failed run. This is the DOR-1573 addition: before it, a
 *      relay-delivered run reached the feed only on the next poll, because the
 *      relay path never called the activity emitter itself.
 *
 * @param activityService - The activity feed to emit terminal-run events to, or
 *   null when the feed is unavailable (the emit is then a no-op).
 * @returns A listener that runs all three terminal consumers for one run.
 */
export function createRunTerminalListener(
  activityService: ActivityService | null
): RunTerminalListener {
  return (run, task) => {
    broadcastRunTerminal(run);
    void notifyRunCompleted(run, task);
    emitTerminalRunActivity(activityService, task, run);
  };
}
