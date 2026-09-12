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

/** The approval primitive this module needs — no more of it than that. */
type ExpirySource = Pick<
  ApprovalService,
  'sweepExpired' | 'purgeExpired' | 'expirySweepIntervalMs'
>;

/**
 * Start settling expired approvals on a timer, and keep the table trimmed.
 *
 * Idempotent from the caller's side only in the sense that the returned stop
 * function is safe to call more than once; starting twice arms two intervals, so
 * the caller owns exactly one.
 *
 * @param approvals - The approval store to sweep.
 * @returns A function that stops the sweep. Safe to call repeatedly.
 */
export function startApprovalExpirySweep(approvals: ExpirySource): () => void {
  const intervalMs = approvals.expirySweepIntervalMs;

  const tick = (): void => {
    // Wrapped per tick rather than per interval: a thrown error inside a
    // `setInterval` callback escapes to the process, and an approval store that
    // is momentarily unreadable must not take the server down or — worse —
    // silently kill the timer and return expiry to being unobservable.
    try {
      const settled = approvals.sweepExpired();
      if (settled > 0) {
        logger.info('[approvals] settled approvals nobody answered', { settled });
      }
    } catch (err) {
      logger.warn('[approvals] expiry sweep failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // Separate try, so a failure to settle never costs the purge and vice versa.
    // They share a timer for cheapness, not because either depends on the other.
    try {
      approvals.purgeExpired();
    } catch (err) {
      logger.warn('[approvals] retention purge failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const timer = setInterval(tick, intervalMs);
  // An expiry sweep must never be the reason a CLI app refuses to exit — the same
  // reasoning `awaitDecision` and `EscalationService` both apply to their timers.
  timer.unref?.();

  return () => clearInterval(timer);
}
