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
import { TASK_SCHEDULER_PRINCIPAL, taskDispatchSubject } from '@dorkos/shared/relay-schemas';
import { buildTaskAppend } from './task-append.js';
import { resolveRunSession } from './session/sticky-session.js';
import type { RunExecution } from './execution/resolve-run-execution.js';
import { isTerminalRunStatus, type TaskStore } from './task-store.js';
import type { RunAccounting } from './run-accounting.js';
import { resolveScheduledRunPermissionMode } from './scheduled-run-power.js';
import { createTaggedLogger } from '../../lib/logger.js';

const logger = createTaggedLogger('Tasks');

/** Everything this path needs from the scheduler that owns it. */
export interface RelayDispatchDeps {
  store: TaskStore;
  relay: RelayCore;
  /** Where the run's concurrency slot is held until the run row goes terminal. */
  runs: RunAccounting;
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
 * marked as running, and the receiver writes the terminal status onto the run
 * row itself. Nothing is published back: the envelope carries no `replyTo` and
 * this function subscribes to nothing (DOR-1567).
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
 * @param execution - What this run resolved to run on (DOR-1615). Always
 *   claude-code here in v1 — the scheduler routes every other runtime direct,
 *   because the bus has no adapter that could run one (DOR-1614).
 */
export async function dispatchRunViaRelay(
  deps: RelayDispatchDeps,
  task: Task,
  run: TaskRun,
  execution: RunExecution
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
    // The activity-feed event for this failure rides the TaskStore run-terminal
    // hook (DOR-1573), fired by the `updateRun('failed')` above — the one funnel
    // both dispatch paths share.
    return;
  }

  // Which session the receiver must resume, decided HERE because only this side
  // has the store to answer it (DOR-1571). For a resuming sticky run this is the
  // REAL SDK id of the task's previous run (so the runtime finds its transcript);
  // a first sticky fire and every non-sticky run resolve to the run's own id with
  // no resume — the wire default — so the branch below only adds fields for a
  // sticky run, keeping every non-sticky envelope byte-for-byte what it was.
  // A sticky task whose resolved runtime differs from the one its previous RUN
  // used starts FRESH, exactly as on the direct path — sessions are
  // runtime-bound and never revised (ADR-0255, DOR-1615).
  const { sessionId, hasStarted } = resolveRunSession(deps.store, task, run, {
    runtimeType: execution.runtimeType,
  });

  const payload: TaskDispatchPayload = {
    type: 'task_dispatch',
    taskId: task.id,
    runId: run.id,
    prompt: task.prompt,
    cwd: effectiveCwd,
    // Defence in depth, symmetric with the direct path (`executeRunDirect`): the
    // `??` branch is unreachable through the shipped store, where
    // `pulse_schedules.permission_mode` is NOT NULL DEFAULT, but a row that
    // reached memory without a mode (a hand-built fixture, a future store, a
    // column that loses its constraint) resolves to the same ladder both paths
    // trust, so the two can never disagree on the level a run executes at.
    // ...and read in the RESOLVED runtime's own mode vocabulary (DOR-1615).
    permissionMode:
      task.permissionMode ??
      resolveScheduledRunPermissionMode({ capabilities: execution.capabilities }),
    taskName: task.name,
    cron: task.cron,
    trigger: run.trigger,
    // The same briefing the direct path builds, from the same builder. The
    // receiver runs in another process and cannot rebuild it — the task's agent
    // and the run's trigger are not otherwise on the wire — so it travels.
    systemPromptAppend: buildTaskAppend(task, run),
    // Sticky only: the shared session and whether it already has history to
    // resume. Absent on a non-sticky run, where the receiver falls back to the
    // run id and starts fresh.
    ...(task.sticky ? { sessionId, resumeSession: hasStarted } : {}),
    // WHICH PROGRAM runs it (DOR-1614). Unconditional, unlike the two settings
    // below: the receiver's fallback for an absent runtime is its own default,
    // and staying silent here would run a codex task on claude-code — the
    // failure this field exists to remove. It is also what makes the model
    // below safe to send, since a model id only means something inside the
    // runtime that offers it.
    //
    // The receiver refuses a runtime it does not hold rather than substituting
    // one, so this and the scheduler's `viaRelay` guard are two halves of the
    // same promise: the guard keeps a run the relay cannot serve on the direct
    // path, and this makes the run the relay CAN serve land on the right one.
    runtime: execution.runtimeType,
    // What this run resolved to run on (DOR-1615/DOR-1347). Resolved HERE
    // because only this side has the task row, the agent manifest and the
    // server config to walk the ladder with; the receiver runs in another
    // process and could rebuild none of it. Absent means "the runtime decides",
    // which is byte-for-byte what every relay envelope carried before.
    ...(execution.settings.model !== undefined ? { model: execution.settings.model } : {}),
    ...(execution.settings.effort !== undefined ? { effort: execution.settings.effort } : {}),
  };

  // No `replyTo`. Nothing subscribes to a task run's progress: this function
  // publishes and never listens, and the run row is the only thing that knows
  // how the run ends. What the reply subject actually did was feed every event
  // of the run back into the adapter that was running it — `<subject>.response`
  // is under the tasks prefix the adapter claims — where each one failed to
  // parse as a dispatch and dead-lettered. One live run produced 279 "could not
  // be delivered" notifications (DOR-1567). A future reader for run progress
  // needs a subject outside this prefix.
  const result = await deps.relay.publish(taskDispatchSubject(task.id), payload, {
    from: TASK_SCHEDULER_PRINCIPAL,
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
    // The activity-feed event for this failure rides the TaskStore run-terminal
    // hook (DOR-1573), fired by the `updateRun('failed')` above.
    return;
  }

  deps.store.updateRun(run.id, { status: 'running' });
  logger.info(`relay dispatch for run ${run.id} delivered to ${result.deliveredTo} endpoint(s)`);
}
