/**
 * How much time an envelope has left, and what it means when the answer is none.
 *
 * ## The policy: an expired envelope never runs
 *
 * `budget.ttl` is an absolute deadline — the instant after which nobody is
 * waiting for this message any more. A message that reaches a runtime past that
 * instant is **refused**, at every seam, without exception. It is never given a
 * fresh budget, never restarted, and never runs "just this once because it got
 * here late": an hour-old message answering as if it had just arrived is a turn
 * nobody asked for, billed to somebody who stopped reading, and — when the
 * answer is a reply that starts another chain — a conversation that outlives
 * every limit that was supposed to end it.
 *
 * The rule already held at the publish gate: `enforceBudget` (`budget-enforcer.ts`)
 * refuses an expired envelope as `ttl_expired` before it is ever delivered. This module is
 * the same rule on the DELIVERY side, where a message can go stale after the
 * gate let it through — waiting for a concurrency slot, or behind another turn
 * in its session's queue.
 *
 * ## Refusing is not dropping
 *
 * Refusal has to be something the sender can SEE, so each seam refuses in the
 * shape its own callers already read:
 *
 * - **A scheduled run** (`adapters/claude-code/task-handler.ts`) fails its run
 *   row with `Run timed out (TTL budget expired)` and dead-letters the delivery,
 *   so the run is visible as failed rather than pinned to `running` forever.
 * - **An agent turn** (`adapters/claude-code/agent-handler.ts`) aborts its own
 *   turn handle before anything starts, which sends the terminal `error`
 *   ("TTL budget expired") and `done` its reply readers already know how to
 *   settle on — the same door a turn stopped while queued goes through. No
 *   session is created and `sendMessage` is never called, so nothing is billed.
 * - **The capacity line** (`adapters/claude-code/claude-code-adapter.ts`) never
 *   lets an expired message wait, and bounds a live one's wait by its own
 *   remaining time. It does not refuse the message itself: the handler behind it
 *   is what can tell the sender, and a refusal that publishes nothing would be
 *   silence.
 *
 * ## Reading the clock
 *
 * Both helpers take the clock as an argument because the handlers do: a deadline
 * read off the wall clock counts the handler's own startup against the message's
 * budget, which is how a millisecond-scale fixture expires before the code under
 * test gets to it (DOR-1729). Pass the same clock everything else in the turn
 * reads, or the answers disagree.
 *
 * @module relay/lib/envelope-ttl
 */

import type { RelayEnvelope } from '@dorkos/shared/relay-schemas';

/**
 * How long this envelope has left, in milliseconds.
 *
 * Negative or zero means it is already past its deadline — see
 * {@link isEnvelopeExpired}, which is the question callers usually mean.
 *
 * @param envelope - The envelope being delivered.
 * @param now - The clock to spend the budget on. Defaults to `Date.now`.
 * @returns Milliseconds remaining; zero or less for an expired envelope.
 */
export function ttlRemainingMs(envelope: RelayEnvelope, now: () => number = Date.now): number {
  return envelope.budget.ttl - now();
}

/**
 * Whether this envelope is past its deadline and must therefore not run.
 *
 * The boundary is inclusive — an envelope whose deadline is exactly now has no
 * time to run in, and a turn granted zero milliseconds is a turn that would be
 * stopped on its first tick anyway.
 *
 * @param envelope - The envelope being delivered.
 * @param now - The clock to spend the budget on. Defaults to `Date.now`.
 * @returns True when the envelope must be refused rather than run.
 */
export function isEnvelopeExpired(envelope: RelayEnvelope, now: () => number = Date.now): boolean {
  return ttlRemainingMs(envelope, now) <= 0;
}
