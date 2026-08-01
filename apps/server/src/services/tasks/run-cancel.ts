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
import { TASK_CANCEL_SUBJECT_PREFIX, TASK_SCHEDULER_PRINCIPAL } from '@dorkos/shared/relay-schemas';

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
 * Why the bus refused to carry a stop, in words for the person who pressed the
 * button.
 *
 * A refused publish and an unanswered one both arrive as `deliveredTo: 0`, and
 * telling someone "nothing picked up the stop request" when the truth is "you
 * have sent too many messages this minute" sends them looking in the wrong
 * place. The scheduler shares one principal across every task, so the
 * rate-limit case is the realistic one.
 */
const REJECTION_REASONS: Record<string, string> = {
  rate_limited: 'the message bus is rate-limiting this server',
  backpressure: 'the message bus is overloaded',
  circuit_open: 'the message bus has stopped delivering to this destination',
  budget_exceeded: 'the stop request ran out of delivery budget',
  initiate_denied: 'this server is not allowed to send on that channel',
};

/** What the bus did with a stop request. */
export interface RunStopDelivery {
  /** How many runners took it. Zero is NOT the same as the run having stopped. */
  deliveredTo: number;
  /** Why it was refused, when the bus refused it outright. */
  rejection?: string;
}

/**
 * Ask whoever is running this run over the relay to stop it.
 *
 * @param relay - The message bus.
 * @param runId - The run to stop; it is also the subject's tail, so a trace row
 *   names the run it belongs to.
 * @returns How many runners took the request, and why not when the bus refused.
 */
export async function publishRunStop(relay: RelayCore, runId: string): Promise<RunStopDelivery> {
  const payload: TaskCancelPayload = { type: 'task_cancel', runId };
  const result = await relay.publish(`${TASK_CANCEL_SUBJECT_PREFIX}${runId}`, payload, {
    // The adapter refuses a stop from anyone else, so this is not decoration.
    from: TASK_SCHEDULER_PRINCIPAL,
    budget: {
      // One hop, no fan-out, and a short life: a stop is a point-to-point
      // instruction, not something to forward on.
      maxHops: 1,
      ttl: Date.now() + CANCEL_SIGNAL_TTL_MS,
      callBudgetRemaining: 1,
    },
  });

  // A stop the adapter REFUSES leaves no dead letter — a refusal still counts
  // as a matched subscriber, which is what the dead-letter gate reads — so the
  // common unconfirmed case (a run nobody is executing) adds no noise to a
  // surface people read for real failures. A stop published while the relay
  // adapter is not running at all does dead-letter, and that one is honest:
  // nothing could have carried it. Left as-is deliberately.
  const refusal = result.rejected?.[0]?.reason;
  return {
    deliveredTo: result.deliveredTo,
    ...(refusal ? { rejection: REJECTION_REASONS[refusal] ?? refusal } : {}),
  };
}
