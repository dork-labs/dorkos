/**
 * The bookkeeping behind the warm ceiling: who holds a slot that is granted but
 * not yet a process, and which warm session has gone longest without being used
 * (spec `persistent-session-runtime` §4.4, task 3.4).
 *
 * Split out of `session-pump-registry.ts` because it is pure — no pumps, no
 * processes, no timers — and because both halves of it are the kind of thing
 * that is wrong in a way only a direct test notices.
 *
 * ## Why a slot is reserved rather than counted
 *
 * The ceiling counts processes, and a launch does not have one yet when it asks.
 * Counting only what exists is a time-of-check/time-of-use bug with a completely
 * ordinary trigger: three sessions warmed in the same tick each read "zero live"
 * before any of them has transitioned, and a ceiling of two lets all three
 * through. The reservation closes that window — a granted slot counts against
 * the ceiling from the instant it is granted, and stops counting once the pump
 * it was granted to holds a process (and is therefore counted by the live count
 * instead).
 *
 * The alternative — making the check block until the launch it is racing has
 * finished — was rejected: the launch it would wait on is downstream of this
 * call, so the wait would be on itself.
 *
 * ## Why recency is an order and not a time
 *
 * {@link touch} stamps a counter, not a clock. Two sessions used in the same
 * millisecond still order correctly, and the ordering cannot be perturbed by a
 * test's fake clock or by the system clock moving. LRU only ever asks "which of
 * these came first", which is exactly what a counter answers.
 *
 * @module services/runtimes/claude-code/sessions/warm-slot-book
 */

/**
 * Slot reservations and use-recency for one registry's warm sessions.
 *
 * Every method is keyed by session id, so a session that is forgotten and later
 * comes back simply starts a fresh entry.
 */
export class WarmSlotBook {
  /** Sessions granted a slot whose process does not exist yet. */
  private readonly reserved = new Set<string>();
  /** Session id to the stamp of its last use — see {@link touch}. */
  private readonly used = new Map<string, number>();
  /** Monotonic stamp source. Only ever increases. */
  private stamp = 0;

  /**
   * Claim a slot for a launch, if the ceiling has room for one.
   *
   * @param sessionId - The session about to boot a process
   * @param live - How many processes exist or are booting right now
   * @param ceiling - The most that may exist at once
   * @returns True when the slot is claimed, false when the ceiling is full
   */
  grant(sessionId: string, live: number, ceiling: number): boolean {
    // Re-granting a session that already holds a reservation is not double
    // counting: the set collapses it, and the next release clears it either way.
    if (live + this.reserved.size >= ceiling && !this.reserved.has(sessionId)) return false;
    this.reserved.add(sessionId);
    return true;
  }

  /**
   * Give back `sessionId`'s reservation, because its launch has either produced
   * a process (which the live count now sees) or failed. Idempotent.
   *
   * @param sessionId - The session whose launch has settled
   */
  release(sessionId: string): void {
    this.reserved.delete(sessionId);
  }

  /**
   * Record that `sessionId`'s process was just used — it launched, it was
   * dispatched to, or a turn window closed on it. This is what LRU means by
   * "recently used": the last thing DorkOS asked of the process, not the last
   * thing that happened to touch the session record.
   *
   * @param sessionId - The session whose process did something
   */
  touch(sessionId: string): void {
    this.stamp += 1;
    this.used.set(sessionId, this.stamp);
  }

  /**
   * Forget everything about `sessionId` — its reservation and its recency.
   *
   * @param sessionId - A session whose pump has left the registry
   */
  forget(sessionId: string): void {
    this.reserved.delete(sessionId);
    this.used.delete(sessionId);
  }

  /**
   * `sessionIds`, least recently used first — the order an LRU reclaim tries
   * them in.
   *
   * A session with no recorded use sorts oldest. That should not happen (a warm
   * process has been touched at least by its own launch), and if it ever does,
   * reclaiming the one nothing is known about is the right guess.
   *
   * @param sessionIds - The reclaim candidates, in any order
   */
  leastRecentFirst(sessionIds: Iterable<string>): string[] {
    return [...sessionIds].sort((a, b) => (this.used.get(a) ?? -1) - (this.used.get(b) ?? -1));
  }
}
