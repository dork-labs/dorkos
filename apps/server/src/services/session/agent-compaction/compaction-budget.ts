/**
 * How often one session's agent may ask for its own conversation to be
 * summarized: once per {@link SESSIONS.AGENT_COMPACTION_INTERVAL_MS} (DOR-2732).
 *
 * A summary throws detail away for good. An agent that asks in a loop — or one
 * that misreads its own gauge every turn — would keep summarizing away the work
 * it was doing, so the bound is a mechanism rather than a line in the tool's
 * description, the same reasoning `NotifyBudget` and `ReactionBudget` apply.
 *
 * Keyed by the session's PRIMARY id, so the request UUID a conversation was
 * born under and the canonical id it was renamed to spend one allowance between
 * them (`session-key-registry.ts`). Spent when a request is SCHEDULED, not when
 * it runs: a second request in the hour is refused whether or not the first has
 * started, which is what "once an hour" has to mean to an agent reading the
 * refusal. A request that never ran — dropped because the owner blocked it, the
 * launch failed, it waited past its ceiling, or the session went away — gives
 * the allowance back ({@link CompactionRequestBudget.refund}), because nothing
 * was summarized for it.
 *
 * In memory, and built ONCE at boot: the in-session tool server is rebuilt per
 * session, and a budget built with it would hand every rebuild a fresh
 * allowance. A restart forgets it, which costs at most one extra summary.
 *
 * @module services/session/agent-compaction/compaction-budget
 */
import { SESSIONS } from '../../../config/constants.js';

/** What {@link CompactionRequestBudget.tryReserve} answers. */
export type CompactionReservation = { ok: true; at: number } | { ok: false; retryAt: number };

/** The once-an-hour allowance for agent-requested summaries. */
export class CompactionRequestBudget {
  private readonly lastSpent = new Map<string, number>();
  private readonly now: () => number;
  private readonly intervalMs: number;

  /**
   * Build an empty budget.
   *
   * @param opts.now - Clock, injectable so a test can roll the hour forward.
   * @param opts.intervalMs - How long one request holds the allowance.
   */
  constructor(opts: { now?: () => number; intervalMs?: number } = {}) {
    this.now = opts.now ?? (() => Date.now());
    this.intervalMs = opts.intervalMs ?? SESSIONS.AGENT_COMPACTION_INTERVAL_MS;
  }

  /**
   * Spend the session's allowance, or say when it comes back.
   *
   * Reserving inside the check is what stops two requests in the same tick from
   * both getting through.
   *
   * @param sessionKey - The session's primary id.
   */
  tryReserve(sessionKey: string): CompactionReservation {
    const at = this.now();
    const last = this.lastSpent.get(sessionKey);
    if (last !== undefined && at - last < this.intervalMs) {
      return { ok: false, retryAt: last + this.intervalMs };
    }
    this.lastSpent.set(sessionKey, at);
    // Drop allowances that have come back, so a long-lived server does not keep
    // one entry for every session that ever asked.
    for (const [key, spentAt] of this.lastSpent) {
      if (at - spentAt >= this.intervalMs) this.lastSpent.delete(key);
    }
    return { ok: true, at };
  }

  /**
   * Give back an allowance whose request never ran.
   *
   * Token-matched on the reservation's time, so a refund that arrives after a
   * LATER reservation (impossible within one hour today, cheap to rule out)
   * cannot hand back the newer one.
   *
   * @param sessionKey - The session's primary id.
   * @param at - The `at` its reservation answered with.
   */
  refund(sessionKey: string, at: number): void {
    if (this.lastSpent.get(sessionKey) === at) this.lastSpent.delete(sessionKey);
  }
}
