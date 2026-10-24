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
import type { PublishResult, RelayCore } from '@dorkos/relay';
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
import { formatDuration } from '../../lib/format-duration.js';

const logger = createTaggedLogger('Tasks');

/** Everything this path needs from the scheduler that owns it. */
export interface RelayDispatchDeps {
  store: TaskStore;
  relay: RelayCore;
  /** Where the run's concurrency slot is held until the run row goes terminal. */
  runs: RunAccounting;
  /** Resolves the task's effective working directory; throws when its agent is gone. */
  resolveCwd: (task: Task) => Promise<string>;
  /** The home of the task's agent, resolved with the cwd; absent for an agent-less task. */
  forAgent?: string;
  /**
   * Told which session the run's turn runs under, once it is decided, so
   * keep-awake counts that turn as this run (spec `keep-awake`).
   */
  onSession?: (sessionId: string) => void;
  /**
   * How long to wait before the one retry a run gets when nothing answered its
   * dispatch at all (DOR-3033). Thirty seconds by default; tests shorten it.
   */
  noReceiverRetryMs?: number;
}

/** Fallback deadline for a dispatch envelope when the task sets none. */
const DEFAULT_DISPATCH_TTL_MS = 3_600_000;

/** How long a run waits before its one retry when nothing answered (DOR-3033). */
const NO_RECEIVER_RETRY_MS = 30_000;

/**
 * Whether a dispatch reached nothing at all: no adapter answered it and the bus
 * refused it nowhere. The one outcome a retry can fix — an adapter that was
 * restarting — and the one "never started" is true of.
 *
 * @param result - What the publish returned
 */
function nothingAnswered(result: PublishResult): boolean {
  return result.adapterResult === undefined && (result.rejected?.length ?? 0) === 0;
}

/**
 * Why a run that was handed over never started, in words a person can act on
 * (DOR-3033). Every run used to read "nothing was available", including the
 * ones a two-minute delivery timeout had cut off while they ran.
 *
 * @param trigger - What started the run
 * @param result - What the publish returned
 */
function notStartedError(trigger: TaskRun['trigger'], result: PublishResult): string {
  if (result.adapterResult?.code === 'at_capacity') {
    return 'Every agent slot stayed busy, so this run didn’t start.';
  }
  const refused = result.rejected?.[0]?.reason;
  if (refused === 'turn_ceiling') {
    return 'The hourly limit on agent turns was reached, so this run didn’t start.';
  }
  if (refused !== undefined) return 'DorkOS was too busy to take this run, so it didn’t start.';
  const error = result.adapterResult?.error ?? '';
  // Raised when a run that DID start never reported how it ended; it must not
  // read as one that never started. The raw adapter text stays in the log.
  if (error.startsWith('adapter delivery timeout')) {
    return 'This run went past its time limit without reporting how it ended.';
  }
  if (error.startsWith('No agent runtime registered')) {
    return 'The program this task runs on isn’t running, so this run didn’t start.';
  }
  if (error !== '') return 'This run couldn’t start. The server log has the reason.';
  return noReceiverError(trigger);
}

/**
 * What a person reads on a run that nothing was there to execute.
 *
 * Reads the run's own trigger rather than saying "scheduled" for all of them. A
 * run somebody clicked does not ride this path at all any more (the scheduler
 * keeps an attended run in this process, so its approval cards can reach the
 * person waiting on it) — but this function publishes whatever it is handed, and
 * a sentence that names the wrong kind of run sends the reader looking for a
 * schedule that does not exist.
 *
 * @param trigger - What started the run.
 */
function noReceiverError(trigger: TaskRun['trigger']): string {
  return trigger === 'scheduled'
    ? 'Nothing was available to run this scheduled task, so the run never started.'
    : 'Nothing was available to run this task, so the run never started.';
}

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
 * @param execution - What this run resolved to run on (DOR-1615). Any runtime
 *   the relay holds, not just claude-code (DOR-1614): the scheduler asks the
 *   relay per run and hands over only what the far side can drive, so its
 *   `runtimeType` is written onto the envelope below rather than assumed.
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
  //
  // Carried on EVERY envelope, sticky or not. The far side used to fall back to
  // the run's own id for a non-sticky run, and a run id is a ULID: every session
  // route validates a UUID, so that run's session could be opened by nobody and
  // the id written on its row linked to a 400.
  const { sessionId, hasStarted } = resolveRunSession(deps.store, task, {
    runtimeType: execution.runtimeType,
  });
  deps.onSession?.(sessionId);

  const payload: TaskDispatchPayload = {
    type: 'task_dispatch',
    taskId: task.id,
    runId: run.id,
    prompt: task.prompt,
    cwd: effectiveCwd,
    // The task's agent, so the receiving runtime reads identity from its home
    // (spec `agent-home-desk` §3.2 row 12). Absent for an agent-less task.
    ...(deps.forAgent !== undefined ? { forAgent: deps.forAgent } : {}),
    // Defence in depth, symmetric with the direct path (`executeRunDirect`): the
    // `??` branch is unreachable through the shipped store, where
    // `pulse_schedules.permission_mode` is NOT NULL DEFAULT, but a row that
    // reached memory without a mode (a hand-built fixture, a future store, a
    // column that loses its constraint) resolves to the same ladder both paths
    // trust, so the two can never disagree on the level a run executes at.
    // ...and read in the RESOLVED runtime's own mode vocabulary (DOR-1615).
    permissionMode:
      task.permissionMode ??
      resolveScheduledRunPermissionMode({
        capabilities: execution.capabilities,
      }),
    taskName: task.name,
    cron: task.cron,
    trigger: run.trigger,
    // The same briefing the direct path builds, from the same builder. The
    // receiver runs in another process and cannot rebuild it — the task's agent
    // and the run's trigger are not otherwise on the wire — so it travels.
    systemPromptAppend: buildTaskAppend(task, run),
    // The session this run's turn executes under, and whether it already has
    // history to resume. `resumeSession` is false for every non-sticky run and
    // for a sticky task's first fire.
    sessionId,
    resumeSession: hasStarted,
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
    // The schedule's own Claude account (DOR-2384), for the receiver to hand the
    // runtime as its launch hint. Absent keeps every envelope without one
    // byte-for-byte what it was.
    ...(execution.settings.accountHint !== undefined
      ? { account: execution.settings.accountHint }
      : {}),
    // So a run stopped at its deadline says how long it had (DOR-3033).
    ...(task.maxRuntime ? { timeLimit: formatDuration(task.maxRuntime) } : {}),
  };

  // No `replyTo`. Nothing subscribes to a task run's progress: this function
  // publishes and never listens, and the run row is the only thing that knows
  // how the run ends. What the reply subject actually did was feed every event
  // of the run back into the adapter that was running it — `<subject>.response`
  // is under the tasks prefix the adapter claims — where each one failed to
  // parse as a dispatch and dead-lettered. One live run produced 279 "could not
  // be delivered" notifications (DOR-1567). A future reader for run progress
  // needs a subject outside this prefix.
  const publish = (): Promise<PublishResult> =>
    deps.relay.publish(taskDispatchSubject(task.id), payload, {
      from: TASK_SCHEDULER_PRINCIPAL,
      budget: {
        maxHops: 3,
        ttl: Date.now() + (task.maxRuntime || DEFAULT_DISPATCH_TTL_MS),
        callBudgetRemaining: 5,
      },
    });
  let result = await publish();
  // Nothing answered at all: the one delivery problem a retry can fix (an
  // adapter mid-restart). Once, a little later, before the run is called failed.
  if (result.deliveredTo === 0 && nothingAnswered(result)) {
    const current = deps.store.getRun(run.id);
    if (!current || !isTerminalRunStatus(current.status)) {
      logger.warn(`no receiver for relay dispatch of run ${run.id}; trying once more`);
      deps.runs.setAwaitingRetry(run.id, true);
      await new Promise((resolve) => {
        setTimeout(resolve, deps.noReceiverRetryMs ?? NO_RECEIVER_RETRY_MS).unref?.();
      });
      deps.runs.setAwaitingRetry(run.id, false);
      // The wait is long enough for the world to move. A shutdown forgets every
      // relay run's slot (`forgetRelayRuns`) and leaves the row for crash
      // recovery; a Stop or any other ending makes the row terminal. Either
      // stands the retry down.
      if (!deps.runs.heldRunIds().has(run.id)) return;
      const after = deps.store.getRun(run.id);
      if (!after || isTerminalRunStatus(after.status)) {
        deps.runs.release(run.id);
        return;
      }
      // The schedule may have moved too: turned off, sent back for approval, or
      // given a lower level. What it says NOW binds; a lower level always does
      // (DOR-3175). Nothing has run yet, so the run is skipped, not failed.
      const fresh = deps.store.getTask(task.id);
      if (!fresh || !fresh.enabled || fresh.status !== 'active') {
        deps.runs.release(run.id);
        deps.store.updateRun(run.id, {
          status: 'skipped',
          finishedAt: new Date().toISOString(),
          durationMs: 0,
          error: 'The schedule was turned off or sent back for approval before this run started.',
        });
        return;
      }
      if (fresh.permissionMode) payload.permissionMode = fresh.permissionMode;
      deps.runs.addRelay(run.id, task.maxRuntime);
      result = await publish();
    }
  }

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
      error: notStartedError(run.trigger, result),
    });
    logger.warn(`relay dispatch of run ${run.id} did not start`, {
      rejected: result.rejected?.map((entry) => entry.reason),
      adapterError: result.adapterResult?.error,
      code: result.adapterResult?.code,
    });
    // The activity-feed event for this failure rides the TaskStore run-terminal
    // hook (DOR-1573), fired by the `updateRun('failed')` above.
    return;
  }

  deps.store.updateRun(run.id, { status: 'running' });
  logger.info(`relay dispatch for run ${run.id} delivered to ${result.deliveredTo} endpoint(s)`);
}
