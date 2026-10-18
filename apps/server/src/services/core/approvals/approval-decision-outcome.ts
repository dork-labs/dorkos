/**
 * How a broadcast approval ending reads to a caller holding on it. Split out of
 * `approval-service.ts`, which uses it in `awaitDecision`.
 *
 * @module services/core/approvals/approval-decision-outcome
 */
import type { ApprovalOutcome } from '@dorkos/shared/approval-schemas';
import type { ApprovalDecisionOutcome } from './approval-service.js';

/**
 * Translate a broadcast {@link ApprovalOutcome} into the caller-facing hold
 * outcome. `consumed` — the token was spent elsewhere while the hold waited —
 * degrades to `expired`: there is nothing left for the caller to resume on, so it
 * falls back to the poll payload exactly as a real expiry would.
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
