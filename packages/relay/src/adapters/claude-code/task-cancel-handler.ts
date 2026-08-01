/**
 * Stop-request handling for task runs the Claude Code adapter is executing.
 *
 * A scheduled run dispatched over the relay is executed here, not in the
 * server's scheduler, so the server has no in-process handle to abort when a
 * person presses Stop in the cockpit (DOR-808). This module is that handle: the
 * adapter keeps a registry of the runs it currently owns, and a subscription on
 * {@link TASK_CANCEL_SUBJECT_PREFIX} turns a `task_cancel` envelope into the
 * same abort the run's own time limit uses.
 *
 * It travels by SUBSCRIPTION rather than adapter delivery, exactly like tool
 * approvals: `deliver()` holds a concurrency slot for the whole run, so a stop
 * routed through it would queue behind the run it exists to end.
 *
 * @module relay/adapters/claude-code-task-cancel-handler
 */

import {
  TASK_CANCEL_SUBJECT_PREFIX,
  TASK_SCHEDULER_PRINCIPAL,
  TaskCancelPayloadSchema,
} from '@dorkos/shared/relay-schemas';
import type { RelayEnvelope } from '@dorkos/shared/relay-schemas';
import type { RelayPublisher, SubscriberVerdict, Unsubscribe } from '../../types.js';

/** Subject pattern covering a stop request for any run. */
export const TASK_CANCEL_SUBJECT_PATTERN = `${TASK_CANCEL_SUBJECT_PREFIX}>`;

/**
 * Abort reason that marks a stop as a person's decision.
 *
 * A run has two ways to end early and they read differently in the run record,
 * so the reason has to survive the abort: this symbol means "somebody pressed
 * Stop", and its absence means the run outlived its time limit.
 */
export const OPERATOR_CANCEL = Symbol('operator-cancel');

/**
 * The task runs this adapter is executing right now.
 *
 * Deliberately narrow: it holds only what is needed to end a run, and only for
 * as long as the run is in flight. A run that has finalized is GONE from here,
 * which is what makes a late stop request answerable with the truth ("no such
 * run is executing") instead of a silent no-op.
 */
export class RunningTasks {
  private readonly runs = new Map<string, AbortController>();

  /**
   * Record a run as in-flight.
   *
   * @param runId - The run id, which is also its session key.
   * @param controller - The controller whose abort ends the run.
   */
  register(runId: string, controller: AbortController): void {
    this.runs.set(runId, controller);
  }

  /**
   * Forget a run that has finished.
   *
   * Only drops the entry when it is still the one this caller registered, so a
   * late release can never unregister a newer run that reused the id.
   *
   * @param runId - The run id.
   * @param controller - The controller this caller registered.
   */
  release(runId: string, controller: AbortController): void {
    if (this.runs.get(runId) === controller) this.runs.delete(runId);
  }

  /**
   * Ask a run to stop.
   *
   * Idempotent: aborting an already-aborted controller keeps the first reason
   * and does nothing else, so a second Stop is harmless.
   *
   * @param runId - The run to stop.
   * @returns Whether a run with this id was executing here.
   */
  stop(runId: string): boolean {
    const controller = this.runs.get(runId);
    if (!controller) return false;
    controller.abort(OPERATOR_CANCEL);
    return true;
  }

  /** How many runs this adapter is executing. */
  get size(): number {
    return this.runs.size;
  }

  /**
   * Drop every entry without aborting anything.
   *
   * Called when the adapter stops. The runs themselves are finalized by their
   * own handlers; this only stops the registry from outliving them.
   */
  clear(): void {
    this.runs.clear();
  }
}

/**
 * Handle one stop request.
 *
 * Never throws: it runs inside the publish pipeline, where a throw is swallowed
 * and would leave the person who pressed Stop with no answer at all. Every
 * refusal comes back as a {@link SubscriberVerdict}, which is what makes the
 * publisher's `deliveredTo` an honest report of whether the run was reached.
 *
 * @param envelope - The relay envelope carrying the `task_cancel` payload.
 * @param running - The adapter's in-flight run registry.
 * @param log - Logger for diagnostics.
 * @returns A refusal verdict when nothing was stopped; nothing when it was.
 */
export function handleTaskCancel(
  envelope: RelayEnvelope,
  running: RunningTasks,
  log: Pick<Console, 'warn' | 'debug'>
): SubscriberVerdict | void {
  // Stopping somebody's work is the server's business. `from` is stamped by
  // the publish pipeline and is not reachable from a model, so this is what
  // stands between "the person pressed Stop" and "an agent with relay_send
  // guessed a run id". The same rule the MCP relay tools state for control
  // namespaces (`relay-helpers.ts`: `relay.system.*` belongs to the server),
  // enforced here because a subscription has no other gate in front of it.
  if (envelope.from !== TASK_SCHEDULER_PRINCIPAL) {
    log.warn(
      `[CCA] task-cancel: refusing a stop from ${envelope.from} on ${envelope.subject} — ` +
        `only ${TASK_SCHEDULER_PRINCIPAL} may stop a run`
    );
    return { handled: false, reason: 'only the task scheduler may stop a run' };
  }

  const parsed = TaskCancelPayloadSchema.safeParse(envelope.payload);
  if (!parsed.success) {
    log.warn(
      `[CCA] task-cancel: malformed payload on ${envelope.subject} — ` +
        "expected type='task_cancel' with runId"
    );
    return { handled: false, reason: 'stop request was not a task_cancel payload' };
  }

  const { runId } = parsed.data;
  if (!running.stop(runId)) {
    // The honest answer for a run that already finished, and for an adapter
    // that restarted since the run began. Both are no-ops, neither is an error.
    log.debug?.(`[CCA] task-cancel: run ${runId} is not executing here`);
    return { handled: false, reason: `run ${runId} is not executing here` };
  }

  log.debug?.(`[CCA] task-cancel: stopping run ${runId}`);
}

/**
 * Subscribe to run stop requests on behalf of the CCA adapter.
 *
 * @param relay - The RelayPublisher to subscribe through.
 * @param running - The adapter's in-flight run registry.
 * @param log - Logger for diagnostics.
 * @returns An unsubscribe function that must be called on adapter stop.
 */
export function subscribeTaskCancelHandler(
  relay: RelayPublisher,
  running: RunningTasks,
  log: Pick<Console, 'warn' | 'debug'>
): Unsubscribe {
  return relay.subscribe(TASK_CANCEL_SUBJECT_PATTERN, (envelope) =>
    handleTaskCancel(envelope, running, log)
  );
}
