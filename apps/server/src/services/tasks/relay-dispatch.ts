/**
 * Handing a task run to the message bus, for somebody else to execute.
 *
 * The counterpart of `executeRunDirect` in `task-scheduler-service.ts`: that one
 * drives the agent turn here, in this process, holding an `AbortController` for
 * it. This one publishes the work and lets an adapter run it, which means this
 * process holds no handle on the run at all — the run row is the only thing that
 * knows how it ends.
 *
 * Lifted out of the scheduler (DOR-1482) both to keep that file readable and
 * because this path grew a real responsibility: a relay-dispatched run now takes
 * a concurrency slot, exactly as a direct one does (see {@link RunAccounting}).
 *
 * @module services/tasks/relay-dispatch
 */
import type { RelayCore } from '@dorkos/relay';
import type { Task, TaskRun } from '@dorkos/shared/types';
import type { TaskDispatchPayload } from '@dorkos/shared/relay-schemas';
import { TASK_SCHEDULER_PRINCIPAL } from '@dorkos/shared/relay-schemas';
import { isTerminalRunStatus, type TaskStore } from './task-store.js';
import type { RunAccounting } from './run-accounting.js';
import type { ActivityService } from '../activity/activity-service.js';
import { emitRunActivity } from './run-activity.js';
import { createTaggedLogger } from '../../lib/logger.js';

const logger = createTaggedLogger('Tasks');

/** Everything this path needs from the scheduler that owns it. */
export interface RelayDispatchDeps {
  store: TaskStore;
  relay: RelayCore;
  /** Where the run's concurrency slot is held until the run row goes terminal. */
  runs: RunAccounting;
  activityService: ActivityService | null;
  /** Resolves the task's effective working directory; throws when its agent is gone. */
  resolveCwd: (task: Task) => Promise<string>;
}

/** Fallback deadline for a dispatch envelope when the task sets none. */
const DEFAULT_DISPATCH_TTL_MS = 3_600_000;

/**
 * Execute a run by publishing a `TaskDispatchPayload` via the Relay message bus.
 *
 * Builds an envelope with the task/run metadata and publishes to
 * `relay.system.tasks.{taskId}`. If no receiver is subscribed
 * (`deliveredTo === 0`), the run is immediately marked as failed. Otherwise it is
 * marked as running — the receiver will update status on completion via a
 * separate response flow.
 *
 * DOR-248: in-process relay delivery is synchronous, so by the time `publish()`
 * resolves the receiving task handler may have already run the agent turn to
 * completion and written a terminal status. The `status: 'running'` write below
 * can therefore race a `completed` write that already happened —
 * `TaskStore#updateRun`'s terminal-status guard is what makes that race
 * harmless, not the ordering of these two calls.
 *
 * @param deps - The scheduler's store, bus, run registry and cwd resolver.
 * @param task - The task being run.
 * @param run - Its run row, already opened.
 */
export async function dispatchRunViaRelay(
  deps: RelayDispatchDeps,
  task: Task,
  run: TaskRun
): Promise<void> {
  // Counted from here, not after a successful publish: a run handed to the bus
  // is in flight from the moment it is handed over, and the cap has to mean the
  // same thing on this path as it does on the direct one (DOR-1482). In-process
  // delivery runs the entire turn inside `publish()` below, so a slot taken any
  // later would be taken after the run had already ended.
  deps.runs.addRelay(run.id, task.maxRuntime);

  let effectiveCwd: string;
  try {
    effectiveCwd = await deps.resolveCwd(task);
  } catch (err) {
    deps.runs.release(run.id);
    deps.store.updateRun(run.id, {
      status: 'failed',
      finishedAt: new Date().toISOString(),
      durationMs: 0,
      error: (err as Error).message,
    });
    logger.error(`run ${run.id} failed: ${(err as Error).message}`);
    emitRunActivity(deps.activityService, task, run, 'failed', 0, (err as Error).message);
    return;
  }

  const payload: TaskDispatchPayload = {
    type: 'task_dispatch',
    taskId: task.id,
    runId: run.id,
    prompt: task.prompt,
    cwd: effectiveCwd,
    permissionMode: task.permissionMode,
    taskName: task.name,
    cron: task.cron,
    trigger: run.trigger,
  };

  const result = await deps.relay.publish(`relay.system.tasks.${task.id}`, payload, {
    from: TASK_SCHEDULER_PRINCIPAL,
    replyTo: `relay.system.tasks.${task.id}.response`,
    budget: {
      maxHops: 3,
      ttl: Date.now() + (task.maxRuntime || DEFAULT_DISPATCH_TTL_MS),
      callBudgetRemaining: 5,
    },
  });

  if (result.deliveredTo === 0) {
    // "Nobody was listening" and "it ran and was stopped" arrive here
    // identically: the adapter reports an unsuccessful delivery for a run it
    // ended on a deadline, and in-process delivery means the whole run has
    // already happened by the time publish() resolves. The run record is the
    // tiebreaker — a run that reached a terminal status was plainly received,
    // and calling it failed would put a lie in the activity feed.
    deps.runs.release(run.id);
    const current = deps.store.getRun(run.id);
    if (current && isTerminalRunStatus(current.status)) {
      logger.debug(`relay dispatch for run ${run.id} finished as ${current.status}`);
      return;
    }
    deps.store.updateRun(run.id, {
      status: 'failed',
      finishedAt: new Date().toISOString(),
      durationMs: 0,
      error: 'No receiver for the scheduled run',
    });
    logger.warn(`no receiver for relay dispatch of run ${run.id}`);
    emitRunActivity(
      deps.activityService,
      task,
      run,
      'failed',
      0,
      'No receiver for the scheduled run'
    );
    return;
  }

  deps.store.updateRun(run.id, { status: 'running' });
  logger.info(`relay dispatch for run ${run.id} delivered to ${result.deliveredTo} endpoint(s)`);
}
