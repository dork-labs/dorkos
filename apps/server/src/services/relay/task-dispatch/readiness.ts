/**
 * Can the bus actually run this scheduled turn right now? — the rule the Tasks
 * scheduler routes from.
 *
 * The scheduler has two ways to run a task: hand it to the relay, or execute it
 * in this process. It asks this before choosing, and the asymmetry between the
 * two wrong answers is what the rule is built around. A false negative costs
 * nothing — the run still happens, direct, same row, same accounting. A false
 * positive publishes to a subject nobody claims, comes back `deliveredTo === 0`,
 * and fails the run with "No receiver for the scheduled run" where the direct
 * path would have run it (DOR-1636).
 *
 * So an unrecognized state answers NO, the same denylist direction
 * `@dorkos/shared/run-outcome` documents for run failures: the cheap wrong
 * answer is the default.
 *
 * ## Why liveness and not a map lookup
 *
 * This used to be `AdapterManager.hasAgentRuntime` — a map built in the
 * AdapterManager CONSTRUCTOR from the runtimes the host wired, which adapter
 * lifecycle never touches. Two reachable states answered yes while the bus could
 * not serve:
 *
 * - **Disabled.** `POST /api/relay/adapters/:id/disable` unregisters the
 *   adapter; the map is untouched.
 * - **Boot-failed.** `AdapterManager.initialize()` fires its start pass without
 *   awaiting it, so an adapter that never started leaves the map fully
 *   populated.
 *
 * The registry answers both, because `AdapterRegistry.register` only files an
 * adapter AFTER its `start()` resolves, and `unregister` removes it. So "is
 * something subscribed to the subject this dispatch would publish to" is the
 * one question that tracks the bus's real state, and it is asked about the
 * EXACT subject rather than a prefix guess.
 *
 * Its own directory because `services/relay/` is at the file count the
 * project-structure guard blocks on, and this rule is the first piece of a
 * seam — what the Tasks scheduler may ask the relay — that has more than one
 * piece coming (DOR-791's turn ceiling asks the same question about cost).
 *
 * @module services/relay/task-dispatch/readiness
 */
import type { RelayAdapter } from '@dorkos/relay';

/**
 * Why the relay cannot run a scheduled turn. Coarse enough to put on a span
 * attribute: five states, no ids, no paths, no content.
 */
export type RelayDispatchRefusal =
  'relay-off' | 'relay-not-built' | 'no-receiver' | 'receiver-not-connected' | 'runtime-not-on-bus';

/**
 * Whether this run may ride the bus, and — when it may not — why.
 *
 * The reason travels with the verdict rather than being re-derived by the
 * caller: the scheduler routes the run direct either way, and the difference
 * between "you turned the relay off" and "your relay adapter failed to start"
 * is the whole of what an operator needs to know.
 */
export type RelayDispatchVerdict =
  | { readonly deliverable: true }
  | { readonly deliverable: false; readonly reason: RelayDispatchRefusal };

/** The one affirmative verdict, shared so every yes is the same object. */
export const RELAY_DISPATCH_OK: RelayDispatchVerdict = { deliverable: true };

/**
 * What a host with no AdapterManager at all answers.
 *
 * `index.ts` builds the manager in a later phase than the scheduler, and RESETS
 * it to `undefined` when that phase throws — so a relay that never built, or
 * failed building, has to answer for itself here rather than being guessed at.
 */
export const RELAY_NOT_BUILT: RelayDispatchVerdict = {
  deliverable: false,
  reason: 'relay-not-built',
};

/**
 * Decide whether the bus can run a turn, from the two facts that settle it.
 *
 * Order matters: liveness is asked first, because a runtime the map holds is
 * meaningless when nothing is subscribed to run it, and answering
 * `runtime-not-on-bus` for a dead adapter would send an operator to the wrong
 * setting.
 *
 * @param receiver - The adapter subscribed to the dispatch subject, from
 *   `AdapterRegistry.getBySubject`, or `undefined` when nothing claims it.
 * @param holdsRuntime - Whether the relay was wired with this run's runtime.
 * @returns The verdict, with a reason when the answer is no.
 */
export function assessTaskDispatch(
  receiver: RelayAdapter | undefined,
  holdsRuntime: boolean
): RelayDispatchVerdict {
  if (!receiver) return { deliverable: false, reason: 'no-receiver' };
  // Only `connected` is live. `error` is what a registered adapter is left in
  // when it would not stop (see `AdapterRegistry.unregister`) — an integration
  // the operator asked to be rid of that is still holding its connection — and
  // `starting`/`reconnecting`/`stopping`/`disconnected` are all mid-flight or
  // gone. None of them is something to hand an unattended run to.
  if (receiver.getStatus().state !== 'connected') {
    return { deliverable: false, reason: 'receiver-not-connected' };
  }
  if (!holdsRuntime) return { deliverable: false, reason: 'runtime-not-on-bus' };
  return RELAY_DISPATCH_OK;
}

/**
 * One line naming what an operator would have to change, for the log a person
 * reads when a run they expected on the bus ran in this process instead.
 *
 * @param reason - The refusal from a {@link RelayDispatchVerdict}.
 * @returns A sentence, no trailing punctuation, safe to embed in a log line.
 */
export function describeRelayRefusal(reason: RelayDispatchRefusal): string {
  switch (reason) {
    case 'relay-off':
      return 'agent messaging is turned off';
    case 'relay-not-built':
      return 'agent messaging did not start on this server';
    case 'no-receiver':
      return 'no integration is listening for scheduled runs — the built-in one is disabled or failed to start';
    case 'receiver-not-connected':
      return 'the integration that runs scheduled turns is not connected';
    case 'runtime-not-on-bus':
      return 'agent messaging does not carry this run’s agent program';
  }
}
