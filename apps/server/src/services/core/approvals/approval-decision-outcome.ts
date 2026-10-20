/**
 * How a hold on an approval ended, and how a broadcast outcome maps onto it.
 * Split from `approval-service.ts` to keep that file under its line ratchet.
 *
 * @module services/core/approvals/approval-decision-outcome
 */
import type { ApprovalOutcome } from '@dorkos/shared/approval-schemas';

/**
 * How a hold on {@link ApprovalService.awaitDecision} ended.
 *
 * `granted`/`denied` are an operator decision the caller can resume on; `expired`
 * and `timeout` are the no-decision paths that must degrade a held call back to
 * today's `approval_required` poll payload (`expired`: the token's own window
 * closed; `timeout`: the hold's own cap elapsed or its abort signal fired first).
 */
export type ApprovalDecisionOutcome = 'granted' | 'denied' | 'expired' | 'timeout';

/**
 * Translate a broadcast {@link ApprovalOutcome} into the caller-facing hold
 * outcome. `consumed` — the token was spent elsewhere while the hold waited —
 * degrades to `expired`: there is nothing left for the caller to resume on, so it
 * falls back to the poll payload exactly as a real expiry would.
 *
 * @param outcome - The broadcast outcome, if any.
 */
export function toDecisionOutcome(outcome: ApprovalOutcome | undefined): ApprovalDecisionOutcome {
  switch (outcome) {
    case 'granted':
      return 'granted';
    case 'denied':
      return 'denied';
    case 'expired':
    case 'consumed':
      return 'expired';
    default:
      return 'timeout';
  }
}
