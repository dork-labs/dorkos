/**
 * The clock that makes an unanswered approval stop being invisible (spec
 * `approval-expiry-notice`, DOR-1932).
 *
 * ## What was broken
 *
 * Expiry was lazy. `consume` wrote a stale token off when somebody presented
 * one, and `decide` did the same when somebody tried to answer too late — but an
 * approval that simply ran out of time, with no agent retrying and no operator
 * clicking, reached none of them. It never hit `settle()`, so it emitted no
 * `approval_resolved`, disarmed nothing, and told nobody. The agent that asked
 * was left holding a token it had no way to know was dead.
 *
 * ## Why a sweep, and not a timer per approval
 *
 * A timer per approval is promptest and dies on restart, which immediately owes
 * a re-arming pass at boot that reads the table back — machinery this feature
 * otherwise has no use for. A sweep gets that for free: the first tick after a
 * restart settles everything that lapsed while the process was down, by the same
 * code path as everything else, with no recovery branch to keep correct.
 *
 * It also costs almost nothing. `approvals` holds single digits of live rows in
 * practice, the query is indexed, and the cadence tracks the configured decision
 * window rather than being a constant (`ApprovalService.expirySweepIntervalMs`),
 * so shortening the window with `DORKOS_APPROVAL_TTL_MS` shortens the sweep with
 * it instead of leaving a one-second approval unobserved for a minute.
 *
 * ## Ordering within a tick is deliberate
 *
 * Settle first, purge second. The other order would let a row that lapsed while
 * the server was down for longer than the retention window be DELETED in the
 * same pass that should have announced it — trading the invariant this module
 * exists to establish ("every approval reaches `settle()` exactly once") for
 * nothing. A notice for a very old approval reaches a session that is long gone
 * and declines with a log line, which is the cheap, correct ending.
 *
 * **`index.ts` repeats that order at boot, deliberately.** The very scenario the
 * ordering protects — the server having been DOWN past the retention window —
 * can only be discovered at startup, and this interval's first tick is up to a
 * minute after it. So boot settles and purges once itself before arming the
 * timer; without that, the invariant held everywhere except the one place it was
 * written for.
 *
 * ## Why there is no scheduler to register with
 *
 * This server has no cron abstraction or interval registry; every periodic job
 * is a bare `setInterval` owned by its service (`TaskReconciler`,
 * `search/indexer`, `skills-watcher`). This follows that shape rather than
 * inventing a ninth pattern: one `unref()`'d interval, a try/catch per tick so a
 * single bad tick cannot kill the timer, and a stop function the caller owns.
 *
 * @module services/core/approvals/approval-expiry-sweep
 */
import { logger } from '../../../lib/logger.js';
import type { ApprovalService } from './approval-service.js';

/** The approval primitive one tick needs — no more of it than that. */
type ExpirySource = Pick<ApprovalService, 'sweepExpired' | 'purgeExpired'>;

/** What one tick did. Both counts are `0` when that half of it failed. */
export interface ApprovalExpiryTickResult {
  /** Approvals that had run out of time and were settled by this tick. */
  settled: number;
  /** Rows deleted because they aged past the retention window. */
  purged: number;
}

/**
 * Do one pass: settle what lapsed, then trim what aged out.
 *
 * **This function exists so the ORDER lives in one place.** Both the interval
 * below and `index.ts`'s boot call run a tick, and the settle-before-purge
 * ordering is load-bearing exactly once — at boot, after the server was down
 * past the retention window. Written as two statements at each call site, that
 * ordering was correct inside the interval and wrong at boot, which is the only
 * place it mattered. Written here, there is one order and a test can pin it.
 *
 * Each half has its own try/catch. A thrown error inside a `setInterval`
 * callback escapes to the process, and an approval store that is momentarily
 * unreadable must not take the server down or — worse — silently kill the timer
 * and return expiry to being unobservable. The halves are independent: a failure
 * to settle must not cost the purge its turn, or the reverse. They share a tick
 * for cheapness, not because either depends on the other.
 *
 * @param approvals - The approval store to sweep.
 * @returns How much this tick settled and purged.
 */
export function runApprovalExpiryTick(approvals: ExpirySource): ApprovalExpiryTickResult {
  let settled = 0;
  try {
    settled = approvals.sweepExpired();
    if (settled > 0) {
      logger.info('[approvals] settled approvals nobody answered', { settled });
    }
  } catch (err) {
    logger.warn('[approvals] expiry sweep failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  let purged = 0;
  try {
    purged = approvals.purgeExpired();
  } catch (err) {
    logger.warn('[approvals] retention purge failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  return { settled, purged };
}

/**
 * Start settling expired approvals on a timer, and keep the table trimmed.
 *
 * The returned stop function is safe to call more than once; starting twice arms
 * two intervals, so the caller owns exactly one.
 *
 * @param approvals - The approval store to sweep.
 * @param intervalMs - How often to tick, from
 *   `ApprovalService.expirySweepIntervalMs`.
 * @returns A function that stops the sweep. Safe to call repeatedly.
 */
export function startApprovalExpirySweep(approvals: ExpirySource, intervalMs: number): () => void {
  const timer = setInterval(() => runApprovalExpiryTick(approvals), intervalMs);
  // An expiry sweep must never be the reason a CLI app refuses to exit — the same
  // reasoning `awaitDecision` and `EscalationService` both apply to their timers.
  timer.unref?.();

  return () => clearInterval(timer);
}
