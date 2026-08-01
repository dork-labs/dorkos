/**
 * Stopping a task run that this process is not the one executing.
 *
 * A run dispatched over the relay is executed inside an adapter, so the
 * scheduler holds no `AbortController` for it and cannot abort it in place the
 * way {@link module:services/tasks/run-stream} does for a direct run. The stop
 * travels the same bus the dispatch did, and the only thing this side can
 * honestly learn is whether something took it (DOR-808).
 *
 * @module services/tasks/run-cancel
 */
import type { RelayCore } from '@dorkos/relay';
import type { TaskCancelPayload } from '@dorkos/shared/relay-schemas';
import { TASK_CANCEL_SUBJECT_PREFIX } from '@dorkos/shared/relay-schemas';

/**
 * How long a stop request stays valid on the bus.
 *
 * Short on purpose: the relay buffers a message nothing was subscribed to and
 * replays it to the next subscriber, and a stop replayed minutes later names a
 * run that has long since ended.
 */
export const CANCEL_SIGNAL_TTL_MS = 30_000;

/**
 * What can honestly be said about a stop request.
 *
 * The distinction that matters is the last one: a run handed to the relay is
 * stopped by an adapter, so "we asked" and "it stopped" are different facts,
 * and reporting the first as the second is the kind of lie a person only
 * discovers by watching the run keep going.
 */
export type CancelRunOutcome =
  /** No run has this id. */
  | { state: 'not_found' }
  /** The run had already ended — nothing to stop. */
  | { state: 'already_finished' }
  /** A runner has the request and the run is ending. */
  | { state: 'stopping' }
  /** The request went out and nothing acknowledged it. */
  | { state: 'unconfirmed'; reason: string };

/**
 * Ask whoever is running this run over the relay to stop it.
 *
 * @param relay - The message bus.
 * @param runId - The run to stop; it is also the subject's tail, so a trace row
 *   names the run it belongs to.
 * @returns How many runners took the request. Zero means nothing acknowledged
 *   it — which is NOT the same as the run having stopped.
 */
export async function publishRunStop(relay: RelayCore, runId: string): Promise<number> {
  const payload: TaskCancelPayload = { type: 'task_cancel', runId };
  const result = await relay.publish(`${TASK_CANCEL_SUBJECT_PREFIX}${runId}`, payload, {
    from: 'relay.system.tasks.scheduler',
    budget: {
      // One hop, no fan-out, and a short life: a stop is a point-to-point
      // instruction, not something to forward on.
      maxHops: 1,
      ttl: Date.now() + CANCEL_SIGNAL_TTL_MS,
      callBudgetRemaining: 1,
    },
  });
  return result.deliveredTo;
}
