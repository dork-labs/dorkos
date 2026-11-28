/**
 * The events of one run's turn, for whoever watches that run (spec
 * `turns-survive-restarts` §3.1 `watch`, whose wire form is `session.stream`).
 *
 * The dispatcher tells this registry every event the runtime sends in a turn
 * the turn port started (`withRunTurn` in `message-dispatcher/turn-deps.ts`);
 * the space face hands a watcher the run's events
 * from here. A caller that reads what its turn said (a scheduled task's
 * summary, its refused asks) watches here instead of driving the runtime
 * itself. In-process on a Mac; nothing is kept, so a watcher hears only what
 * happens after it starts watching.
 *
 * @module services/session/turn-port/run-events
 */
import type { InterruptReceipt, StreamEvent } from '@dorkos/shared/types';
import { logger } from '../../../lib/logger.js';

/** How to stop each run's turn while its runtime is sending, by run id. */
const stoppers = new Map<string, () => Promise<InterruptReceipt>>();

/**
 * Hold how to stop a run's turn while its runtime sends it (`withRunTurn`).
 *
 * @param runId - The run.
 * @param stop - Interrupts the run's turn at its runtime.
 * @returns A function that lets it go, once the turn's events have ended.
 */
export function holdRunStopper(runId: string, stop: () => Promise<InterruptReceipt>): () => void {
  stoppers.set(runId, stop);
  return () => {
    if (stoppers.get(runId) === stop) stoppers.delete(runId);
  };
}

/**
 * Stop a run's own turn at its runtime (§3.1 `stop`), leaving its chat's queue
 * and every other turn alone.
 *
 * @param runId - The run.
 * @returns The runtime's receipt, or `undefined` when the run has no turn running here.
 */
export function stopRunTurn(runId: string): Promise<InterruptReceipt> | undefined {
  return stoppers.get(runId)?.();
}

/** Who hears what, by run id. */
const watchers = new Map<string, Set<(event: StreamEvent) => void>>();

/**
 * Hear every event of a run's turn from now on.
 *
 * @param runId - The run.
 * @param hear - Called with each event. A throw is logged and never reaches the turn.
 * @returns A function that stops listening.
 */
export function watchRunEvents(runId: string, hear: (event: StreamEvent) => void): () => void {
  let heard = watchers.get(runId);
  if (!heard) {
    heard = new Set();
    watchers.set(runId, heard);
  }
  heard.add(hear);
  return () => {
    const left = watchers.get(runId);
    left?.delete(hear);
    if (left?.size === 0) watchers.delete(runId);
  };
}

/**
 * What the dispatcher calls with each event of a run's turn.
 *
 * @param runId - The run whose turn it is.
 * @returns A teller that hands one event to the run's watchers.
 */
export function runEventTeller(runId: string): (event: StreamEvent) => void {
  return (event) => {
    const heard = watchers.get(runId);
    if (!heard) return;
    for (const hear of [...heard]) {
      try {
        hear(event);
      } catch (err) {
        logger.warn('[turn-port] a run event watcher threw', {
          runId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  };
}
