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
 * Four seams ask the question: the publish gate (`enforceBudget` in
 * `budget-enforcer.ts`, which refuses an expired envelope as `ttl_expired`
 * before it is ever delivered), the two claude-code handlers, and the capacity
 * line in front of them. All four route through {@link isExpired}, so the
 * boundary — inclusive, see below — is decided in one place rather than
 * open-coded four times.
 *
 * ## Refusing is not dropping
 *
 * Refusal has to be something the sender can SEE, so each delivery seam refuses
 * in the shape its own callers already read:
 *
 * - **A scheduled run** (`adapters/claude-code/task-handler.ts`) fails its run
 *   row and dead-letters the delivery, so the run is visible as failed rather
 *   than pinned to `running` forever.
 * - **An agent turn** (`adapters/claude-code/agent-handler.ts`) aborts its own
 *   turn handle before anything starts, which sends the terminal `error` and
 *   `done` its reply readers already know how to settle on — the same door a
 *   turn stopped while queued goes through. No session is created and
 *   `sendMessage` is never called, so nothing is billed.
 * - **The capacity line** (`adapters/claude-code/claude-code-adapter.ts`) never
 *   lets an expired message wait, and bounds a live one's wait by its own
 *   remaining time. It does not refuse the message itself: the handler behind it
 *   is what can tell the sender, and a refusal that publishes nothing would be
 *   silence.
 *
 * ## One clock reading per decision
 *
 * {@link ttlRemainingMs} takes the clock as an argument, and a caller must read
 * it ONCE and then answer every question from that one number. Two readings is
 * a hole rather than a redundancy: an envelope live by three milliseconds at the
 * first reading is dead at the second, and a caller that refuses on one and
 * schedules a deadline off the other refuses neither — it starts the turn and
 * gives it no deadline at all. That is why {@link isExpired} takes a
 * milliseconds-remaining number and not an envelope: there is no way to call it
 * that reads a clock behind the caller's back.
 *
 * @module relay/lib/envelope-ttl
 */

import type { RelayEnvelope } from '@dorkos/shared/relay-schemas';

/**
 * How long this envelope has left, in milliseconds.
 *
 * Read this ONCE per decision and pass the result to {@link isExpired} and to
 * whatever schedules the deadline — see the module note above on why a second
 * reading is a hole.
 *
 * @param envelope - The envelope being delivered.
 * @param now - The clock to spend the budget on. Defaults to `Date.now`.
 * @returns Milliseconds remaining; zero or less for an expired envelope.
 */
export function ttlRemainingMs(envelope: RelayEnvelope, now: () => number = Date.now): number {
  return envelope.budget.ttl - now();
}

/**
 * Whether an envelope with this much time left must be refused rather than run.
 *
 * **The boundary is inclusive.** An envelope whose deadline is exactly now has
 * no time to run in, and a turn granted zero milliseconds would be stopped on
 * its first tick anyway — so zero is expired, not "only just alive". Every seam
 * asks through here so the four cannot pick different sides of that millisecond.
 *
 * @param remainingMs - What {@link ttlRemainingMs} answered for this envelope.
 * @returns True when the envelope must be refused rather than run.
 */
export function isExpired(remainingMs: number): boolean {
  return remainingMs <= 0;
}
