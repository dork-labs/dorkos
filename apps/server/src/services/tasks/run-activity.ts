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
import { readableToolName, type RefusedAsk } from '@dorkos/shared/run-refusals';
import type { RefusedAskReporter } from '@dorkos/relay';
import type { ActivityService } from '../activity/activity-service.js';
import type { TaskStore } from './task-store.js';
import { formatDuration } from '../../lib/format-duration.js';
import { logger } from '../../lib/logger.js';

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
 * whether somebody asked for the cancel or a deadline did — and the two carry
 * different actors. The cancel route reads its own caller
 * (`readActivityActor`, DOR-1829), so its event names the person, the agent that
 * identified itself, or an unidentified caller; the scheduler's deadline event is
 * attributed to the Scheduler. Only the path that ended the run knows which of
 * those happened, and the route is the only one of them that knows WHO. Folding
 * `cancelled` into this row-only funnel would therefore either double the event
 * or flatten every cancel into one anonymous actor. `skipped` never reaches this
 * hook at all: a skipped tick is written straight to a terminal row by
 * `recordTick`, never through the `updateRun` funnel.
 *
 * One residual gap survives this, deliberately deferred to DOR-1580: only the
 * DIRECT path emits a deadline-cancel event (`task-scheduler-service.ts`, the
 * `!operatorCancelled` branch). A relay-dispatched run that hits its deadline is
 * finalized inside `packages/relay`, which cannot import this emitter and emits
 * no cancel event of its own — so a timed-out RELAY run currently reaches no live
 * activity feed, while a timed-out direct run does. A cancel somebody ASKED for is
 * covered on both paths by the cancel route; only the relay+deadline case is
 * uncovered.
 *
 * The REFUSED-ASK entry is no longer part of that gap. It was, and it mattered
 * more than the note admitted: with the relay adapter connected — the ordinary
 * install — a scheduled run takes the relay path, so `tasks.ask_refused` reached
 * nobody at all while the run's own summary said the tool had been skipped. The
 * relay handler now reports each refusal to the host through its
 * `onRefusedAsk` callback, and {@link createRelayRefusedAskEmitter} is what the
 * composition root wires it to.
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

/**
 * Emit an activity event for one tool a scheduled run reached for and could not
 * have, because nobody was there to approve it.
 *
 * **One entry per TOOL, not per attempt.** A run that reached for four different
 * things it could not have is four separate facts, and the operator's question
 * in the morning is which ones — the run row's own summary line already answers
 * "were there any". A run that reached for the SAME blocked tool thirty times in
 * a retry loop is still one fact, so the caller only emits when
 * `RefusedAskLog.observe` answers with a refusal, which it does on a tool's
 * first one and never again.
 *
 * It reuses `emitRunActivity`'s actor shape exactly — the Scheduler for a cron
 * fire, "You" for a run somebody started by hand — and differs only in its
 * `eventType`, so the feed can be filtered on `tasks.ask_refused` without
 * parsing prose.
 *
 * The summary may say "nobody was there to approve it" flatly because the log
 * behind it admits only DorkOS's own unattended refusals; a safety-classifier or
 * deny-rule denial carries a different discriminator and never reaches here (see
 * `@dorkos/shared`'s `run-refusals` module doc).
 *
 * @param activityService - The feed to write to; nothing is emitted without one.
 * @param task - The run's task, for its name.
 * @param run - The run that was refused.
 * @param refused - The refusal, as the runtime recorded it.
 */
export function emitRefusedAskActivity(
  activityService: ActivityService | null,
  task: Task,
  run: TaskRun,
  refused: RefusedAsk
): void {
  if (!activityService) return;

  const scheduled = run.trigger === 'scheduled';
  const toolLabel = readableToolName(refused.toolName);

  void activityService.emit({
    actorType: scheduled ? 'tasks' : 'user',
    actorId: scheduled ? run.scheduleId : null,
    actorLabel: scheduled ? 'Scheduler' : 'You',
    category: 'tasks',
    eventType: 'tasks.ask_refused',
    resourceType: 'schedule',
    resourceId: run.scheduleId,
    resourceLabel: task.name,
    summary: `${task.name} could not use ${toolLabel} — nobody was there to approve it`,
    linkPath: '/',
    metadata: {
      runId: run.id,
      toolName: refused.toolName,
      ...(refused.reason !== undefined ? { reason: refused.reason } : {}),
    },
  });
}

/** What {@link createRelayRefusedAskEmitter} has to be able to look up. */
export interface RelayRefusedAskDeps {
  /** The task and run behind an id pair the relay handler carries. */
  taskStore: Pick<TaskStore, 'getTask' | 'getRun'>;
  /** The feed to write to; nothing is emitted without one. */
  activityService: ActivityService | null;
}

/**
 * The callback the relay's task handler reports a refused ask to (DOR-1580).
 *
 * The relay handler holds a task id and a run id and nothing else — it lives in
 * `packages/relay`, which cannot see the activity feed or the `TaskStore` — so
 * the ids are what crosses the seam and the lookup happens here. The run row
 * exists by the time this runs: the scheduler writes it before it dispatches.
 *
 * Nothing is emitted for an id pair that resolves to nothing, and NOTHING
 * escapes: this is instrumentation hanging off a live run, and a run must not
 * fail because its feed entry could not be written. The catch is load-bearing
 * rather than defensive habit. The two lookups are synchronous SQLite reads, and
 * this callback runs inside the relay task handler's main `try` — whose catch
 * marks the run `failed` and dead-letters the envelope. A database that throws
 * mid-run (a shutdown closing the handle under a still-running turn is the real
 * case) would therefore turn a run that actually ran into a dead-lettered
 * failure, which is a worse outcome than the missing feed row it would be
 * reporting. `debug`, because the run's own summary line still carries the
 * refusal and nothing a person needs is lost.
 *
 * @param deps - Where to look the run up, and where to write.
 * @returns The reporter to hand the relay adapter.
 */
export function createRelayRefusedAskEmitter(deps: RelayRefusedAskDeps): RefusedAskReporter {
  return ({ taskId, runId, refused }) => {
    try {
      const task = deps.taskStore.getTask(taskId);
      const run = deps.taskStore.getRun(runId);
      if (!task || !run) return;
      emitRefusedAskActivity(deps.activityService, task, run, refused);
    } catch (err) {
      logger.debug('[Tasks] could not record a refused ask for a relay-dispatched run', {
        taskId,
        runId,
        toolName: refused.toolName,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };
}
