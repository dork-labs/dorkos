/**
 * Pulse attention broadcast for terminal Task runs (DOR-403).
 *
 * A failed run is an attention signal. This bridges the TaskStore run-terminal
 * hook (DOR-240) — the single seam that fires exactly once per non-terminal →
 * terminal transition, for BOTH scheduler-side failures and relay-delivered
 * failures written by the receiver's `updateRun('failed')` — onto the
 * `/api/events` SSE fan-out, so the Pulse "Needs attention" badge ticks the
 * instant a run fails instead of waiting for the next 30s poll.
 *
 * Wired in `index.ts` as (part of) the store's `onRunTerminal` listener.
 *
 * @module services/tasks/run-terminal-broadcaster
 */
import type { TaskRun } from '@dorkos/shared/types';
import { eventFanOut } from '../core/event-fan-out.js';

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
