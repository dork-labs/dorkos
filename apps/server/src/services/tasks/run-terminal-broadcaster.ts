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
import { wakeAgent } from '../heartbeats/event-wakes.js';
import type { TaskRun } from '@dorkos/shared/types';
import { eventFanOut } from '../core/event-fan-out.js';
import type { RunTerminalListener } from './task-store.js';
import type { ActivityService } from '../activity/activity-service.js';
import { notifyRunCompleted } from '../notifications/emitters/run-completed.js';
import { emitTerminalRunActivity } from './run-activity.js';
import { followLateRunOutput, type LateRunOutputDeps } from './session/late-run-output.js';

/**
 * Broadcast on `/api/events` that a run ended.
 *
 * `task_run_finished` for every run that ended on its own or was stopped, so
 * the Schedules list re-reads whether each schedule is failing: one run that
 * needs attention starts a failing streak, and one completed run clears it
 * (DOR-3123). `task_run_failed` too when the run did not do its job — `failed`
 * or `needs_attention`, the two statuses that make a schedule failing — which
 * the Pulse attention badge ticks on.
 *
 * Because the run-terminal hook fires exactly once per terminal transition and
 * never on an already-terminal re-write, neither can double-fire or fire on a
 * poll re-observation.
 *
 * @param run - The run as persisted at its terminal write.
 */
export function broadcastRunTerminal(run: TaskRun): void {
  eventFanOut.broadcast('task_run_finished', {
    runId: run.id,
    scheduleId: run.scheduleId,
    status: run.status,
  });
  if (run.status !== 'failed' && run.status !== 'needs_attention') return;
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
 *   4. {@link followLateRunOutput} — when the run's agent still holds
 *      background work, what it says in the turns it starts later is added to
 *      the run (DOR-2717). Only when `lateOutput` is given.
 *   5. The owning agent's heartbeat, woken for a failed or parked run.
 *
 * @param activityService - The activity feed to emit terminal-run events to, or
 *   null when the feed is unavailable (the emit is then a no-op).
 * @param lateOutput - The store and runtime lookup the fourth consumer needs;
 *   omitted, a run's later turns reach its session but not its record.
 * @returns A listener that runs every terminal consumer for one run.
 */
export function createRunTerminalListener(
  activityService: ActivityService | null,
  lateOutput?: LateRunOutputDeps
): RunTerminalListener {
  return (run, task) => {
    broadcastRunTerminal(run);
    void notifyRunCompleted(run, task);
    emitTerminalRunActivity(activityService, task, run);
    if (lateOutput) followLateRunOutput(lateOutput, run);
    // A run of a schedule the agent owns that failed or stopped for a person
    // wakes its beat, once a day per schedule (spec `heartbeats` §3.3).
    if (task?.agentId && (run.status === 'failed' || run.status === 'needs_attention')) {
      wakeAgent(task.agentId, { type: 'run-failed', eventId: run.id, source: task.id });
    }
  };
}
