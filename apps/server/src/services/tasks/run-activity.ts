/**
 * What the activity feed says about a task run that ended.
 *
 * Lifted out of `task-scheduler-service.ts` (DOR-1482) as a plain function over
 * the activity service: it reads nothing else from the scheduler, and the file
 * it lived in is well past the size a person can hold in their head.
 *
 * @module services/tasks/run-activity
 */
import type { Task, TaskRun } from '@dorkos/shared/types';
import type { ActivityService } from '../activity/activity-service.js';
import { formatDuration } from '../../lib/format-duration.js';

/**
 * Emit an activity event for a completed, failed, or cancelled run.
 *
 * NOTE: the Pulse attention broadcast (`task_run_failed`, DOR-403) is NOT
 * emitted here. This covers scheduler-side terminal paths only; a
 * relay-delivered run is finalized by the receiver writing 'failed' through
 * TaskStore, which never reaches this function. The broadcast rides the
 * TaskStore run-terminal hook (the single terminal funnel for both paths) — see
 * `run-terminal-broadcaster.ts`, wired in `index.ts`.
 *
 * A `skipped` run is deliberately absent from the status union: it is a record
 * of something that did NOT happen, and the feed is for things that did. Its
 * own run row, in the task's history, is where a person finds it (DOR-1482).
 *
 * @param activityService - The feed to write to; nothing is emitted without one.
 * @param task - The run's task, for its name.
 * @param run - The run that ended.
 * @param status - How it ended.
 * @param durationMs - How long it took; omitted from the summary when zero.
 * @param error - What went wrong, when something did.
 */
export function emitRunActivity(
  activityService: ActivityService | null,
  task: Task,
  run: TaskRun,
  status: 'completed' | 'failed' | 'cancelled',
  durationMs: number,
  error?: string
): void {
  if (!activityService) return;

  const eventType =
    status === 'completed'
      ? 'tasks.run_success'
      : status === 'cancelled'
        ? 'tasks.run_cancelled'
        : 'tasks.run_failed';

  const actorType = run.trigger === 'scheduled' ? 'tasks' : 'user';
  const actorLabel = run.trigger === 'scheduled' ? 'Scheduler' : 'You';

  const verb =
    status === 'completed'
      ? 'ran successfully'
      : status === 'cancelled'
        ? 'was cancelled'
        : 'failed';
  const duration = durationMs ? ` (${formatDuration(durationMs)})` : '';

  activityService.emit({
    actorType,
    actorId: run.trigger === 'scheduled' ? run.scheduleId : null,
    actorLabel,
    category: 'tasks',
    eventType,
    resourceType: 'schedule',
    resourceId: run.scheduleId,
    resourceLabel: task.name,
    summary: `${task.name} ${verb}${duration}`,
    linkPath: '/',
    metadata: error ? { error } : null,
  });
}

/**
 * Emit run activity from the TaskStore run-terminal hook — the single funnel
 * both the direct and relay dispatch paths pass through (DOR-1573).
 *
 * The relay path never called {@link emitRunActivity} itself: a relay-delivered
 * run is finalized by the receiver writing its status through `TaskStore`, so a
 * finished scheduled run reached the activity feed only on the next poll, not as
 * a live broadcast. Folding the emit into the terminal hook fixes that for both
 * paths at once, beside the Pulse broadcast and the completion notification that
 * already ride the same hook.
 *
 * Every argument is reconstructed from the persisted run row, which `updateRun`
 * writes BEFORE it fires the hook, so the values are final.
 *
 * **Only `completed` and `failed` are emitted here.** A `cancelled` run is
 * deliberately left to the path that ended it, because the run row cannot say
 * whether an operator cancelled it (the cancel route emits its own event with
 * the truthful "You" actor) or a deadline did (the scheduler emits one attributed
 * to the Scheduler) — and the two carry different actors. Folding `cancelled`
 * into this row-only funnel would either double the operator's event or lose that
 * attribution. `skipped` never reaches this hook at all: a skipped tick is written
 * straight to a terminal row by `recordTick`, never through the `updateRun` funnel.
 *
 * One residual gap survives this, deliberately deferred to DOR-1580: only the
 * DIRECT path emits a deadline-cancel event (`task-scheduler-service.ts`, the
 * `!operatorCancelled` branch). A relay-dispatched run that hits its deadline is
 * finalized inside `packages/relay`, which cannot import this emitter and emits
 * no cancel event of its own — so a timed-out RELAY run currently reaches no live
 * activity feed, while a timed-out direct run does. Operator-cancel is covered on
 * both paths by the cancel route; only the relay+deadline case is uncovered.
 *
 * @param activityService - The feed to write to; nothing is emitted without one.
 * @param task - The run's task, or null when the hook could not read it.
 * @param run - The run as persisted at its terminal write.
 */
export function emitTerminalRunActivity(
  activityService: ActivityService | null,
  task: Task | null,
  run: TaskRun
): void {
  if (!activityService || !task) return;
  if (run.status !== 'completed' && run.status !== 'failed') return;
  emitRunActivity(
    activityService,
    task,
    run,
    run.status,
    run.durationMs ?? 0,
    run.error ?? undefined
  );
}
