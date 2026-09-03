/**
 * Abort-aware consumption of a task run's agent event stream.
 *
 * A scheduled run has to be stoppable at any moment — an operator cancels it,
 * it outlives its `maxRuntime`, or the server is shutting down. The agent's
 * stream is the wrong place to learn that: a turn parked on a tool-approval
 * prompt yields nothing for up to `SESSIONS.INTERACTION_TIMEOUT_MS` — which is
 * still the bound here, because a scheduled run is unattended and its prompts
 * are refused at the countdown rather than parked (spec `ask-parks-on-timeout`
 * §7) — so any
 * check that lives inside the consumer's loop body simply never runs again.
 * This module owns the two mechanics that make a stop real, kept together
 * because neither is sufficient alone.
 *
 * @module services/tasks/run-stream
 */
import type { InterruptReceipt, StreamEvent } from '@dorkos/shared/types';
import { worthRetrying } from '@dorkos/shared/schemas';
import { SESSIONS } from '../../config/constants.js';
import { createTaggedLogger } from '../../lib/logger.js';

const logger = createTaggedLogger('Tasks');

/**
 * Race sentinel: the run was stopped (cancelled or out of time) before the
 * agent produced its next event.
 */
const RUN_STOPPED = Symbol('run-stopped');

/** Race sentinel: the runtime's interrupt did not settle inside its own bound. */
const INTERRUPT_TIMEOUT = Symbol('interrupt-timeout');

/**
 * Narrow port for the one runtime call that ends an in-flight turn. Every
 * `AgentRuntime` satisfies it structurally.
 */
export interface RunInterrupter {
  /**
   * Answers the {@link InterruptReceipt} vocabulary — `not-running` when the
   * runtime found no in-flight turn to abort.
   */
  interruptQuery(sessionId: string): Promise<InterruptReceipt>;
}

/**
 * Consume a run's event stream until it ends or the run is stopped.
 *
 * Stopping has to reach the RUNTIME, not just this loop — `sendMessage` takes
 * no `AbortSignal`, so abandoning its stream leaves the agent running. Two
 * things make a stop real, and both are needed: `onStop` ends the turn at the
 * agent, and racing each `next()` against the signal returns even if the
 * runtime ignores the interrupt or answers slowly.
 *
 * On a stop the source is ABANDONED rather than awaited: its pending `next()`
 * is rejection-silenced and `return()` is fired without awaiting, because an
 * async generator's `return()` queues behind the pending `next()` and would
 * hang on exactly the parked turn this exists to escape.
 *
 * The relay dispatch path has its own copy of this loop
 * (`packages/relay/src/adapters/claude-code/task-handler.ts`) — it cannot
 * import from `apps/server`. Fix both if you fix one. What the two do NOT
 * duplicate is how they read the run's outcome off these events: that rule is
 * `createRunOutcomeTracker` in `@dorkos/shared/run-outcome`, so the same stream
 * can never settle as a failure on one path and a success on the other.
 *
 * @param stream - The agent's per-turn event stream.
 * @param signal - Aborts when the run is cancelled or out of time.
 * @param onStop - Runs once when the signal aborts; ends the turn at the agent.
 * @param onEvent - Receives each event that arrives before the stop.
 * @returns Whether a stop is what ended the run. Read this rather than the
 *   signal: a stop landing between the stream's last event and this function
 *   returning aborts a signal nobody is waiting on any more, and a run that
 *   finished its work must not be filed as one somebody stopped.
 */
export async function consumeRunStream(
  stream: AsyncIterable<StreamEvent>,
  signal: AbortSignal,
  onStop: () => void,
  onEvent: (event: StreamEvent) => void
): Promise<boolean> {
  const iterator = stream[Symbol.asyncIterator]();
  let onAbort!: () => void;
  const stopped = new Promise<typeof RUN_STOPPED>((resolve) => {
    onAbort = () => {
      resolve(RUN_STOPPED);
      onStop();
    };
    // A signal that aborted before we subscribed never fires the event.
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  });

  try {
    // Exactly one pending next() at a time, so no event is ever dropped
    // between race rounds.
    let pending = iterator.next();
    for (;;) {
      const winner = await Promise.race([pending, stopped]);
      if (winner === RUN_STOPPED) {
        void pending.catch(() => {});
        void Promise.resolve(iterator.return?.()).catch(() => {});
        return true;
      }
      if (winner.done) return false;
      onEvent(winner.value);
      pending = iterator.next();
    }
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

/**
 * Ask the runtime to end the turn behind a stopped run.
 *
 * Never rejects: it is called from an abort listener, where a rejection would
 * surface as an unhandled rejection and take the process down, and a runtime
 * that cannot be interrupted must not stop the run from being finalized.
 *
 * Bounded by `SESSIONS.STALL_INTERRUPT_TIMEOUT_MS` for the same reason
 * `stall-guard` bounds its own: `interruptQuery` reaches the very subprocess
 * being interrupted, so it can hang, and an unobserved dangling await is a leak
 * nobody ever sees. The run is finalized by the caller either way — this bound
 * only decides how long we wait to learn the outcome.
 *
 * @param runtime - The runtime driving the run.
 * @param sessionId - Session backing the run (the run id).
 */
export async function interruptRun(runtime: RunInterrupter, sessionId: string): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    const expiry = new Promise<typeof INTERRUPT_TIMEOUT>((resolve) => {
      timer = setTimeout(() => resolve(INTERRUPT_TIMEOUT), SESSIONS.STALL_INTERRUPT_TIMEOUT_MS);
      // Never hold the process open for an interrupt we already gave up on.
      timer.unref();
    });
    const outcome = await Promise.race([runtime.interruptQuery(sessionId), expiry]);
    if (outcome === INTERRUPT_TIMEOUT) {
      // This bound winning IS an `unconfirmed / ack-timeout` ending — the
      // request went out and nothing came back — and it is logged as such
      // rather than as a receipt, because the receipt belongs to whoever the
      // runtime eventually answers, which by now is nobody.
      logger.warn(
        `run ${sessionId}: interrupt did not settle within ` +
          `${SESSIONS.STALL_INTERRUPT_TIMEOUT_MS}ms; the run is finalized anyway`
      );
    } else if (outcome.outcome === 'not-running') {
      // Also the honest answer for a turn that just finished, and what
      // TestModeRuntime always says — so this is not evidence of a leak.
      logger.debug(`run ${sessionId}: runtime reported no in-flight turn to interrupt`);
    } else if (worthRetrying(outcome)) {
      // The one ending worth a warning: nothing DorkOS did ended the turn, so
      // the run is being finalized over an agent that may still be working.
      logger.warn(`run ${sessionId}: the turn was not confirmed stopped`, {
        outcome: outcome.outcome,
        reason: outcome.reason,
        runtime: outcome.runtime,
      });
    } else {
      logger.debug(`run ${sessionId}: the turn was stopped`, {
        outcome: outcome.outcome,
        reason: outcome.reason,
      });
    }
  } catch (err) {
    logger.error(`run ${sessionId}: interrupting the turn failed:`, err);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
