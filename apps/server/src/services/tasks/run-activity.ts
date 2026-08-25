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
  const actorLabel = run.trigger === 'scheduled' ? 'Scheduled' : 'You';

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
