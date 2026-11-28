/**
 * Abort-aware consumption of a task run's agent event stream.
 *
 * A scheduled run has to be stoppable at any moment — an operator cancels it,
 * it outlives its `maxRuntime`, or the server is shutting down. The agent's
 * stream is the wrong place to learn that: a turn can go a long time without
 * yielding anything, so a check that lives inside the consumer's loop body
 * simply never runs again. A scheduled run is no longer held by a prompt at all
 * — its asks are refused the moment they are raised (spec
 * `unattended-session-permission-prompts`) — but a long tool call, a slow model
 * or a MANUAL run holding an answerable card produces the same silence, and this
 * is what makes a stop return through it. The stop itself reaches the agent
 * through the turn port (`execution/task-turns.ts`).
 *
 * @module services/tasks/run-stream
 */
import type { StreamEvent } from '@dorkos/shared/types';

/**
 * Race sentinel: the run was stopped (cancelled or out of time) before the
 * agent produced its next event.
 */
const RUN_STOPPED = Symbol('run-stopped');

/**
 * Consume a run's event stream until it ends or the run is stopped.
 *
 * Stopping has to reach the RUNTIME, not just this loop: abandoning the
 * turn's events leaves the agent running. Two
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
