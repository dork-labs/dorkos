import { problemBody } from '@dorkos/http-kit';
import type { Problem } from '@dorkos/shared/problem';
import type { LoginEnabledLookup } from '../services/core/approvals/index.js';
import { personSessionRequired } from '../services/core/auth/gate-policy.js';
import { isInstallOwner } from '../services/core/auth/install-owner.js';
import type { RequestFacts } from '../http/request-facts.js';

/** What the paid-run bars need to judge one yes. */
export interface PaidRunAnswer {
  /** The approval being answered. */
  approvalId: string;
  /** The answer asked for. */
  answer: 'once' | 'always';
  /** Whether login is on; falls back to the person-session rule when absent. */
  isLoginEnabled?: LoginEnabledLookup;
  /** The spending service's live check: a refusal sentence, or null to go on. */
  tapRefusal?: (approvalId: string) => string | null;
  /** Record the refusal on the card, so it reads as answered with nothing spent. */
  deny: (approvalId: string, receipt: string) => void;
}

/**
 * The bars on a yes to a paid run (DOR-4204 PR 2), or null when it may go on.
 *
 * Checked at the tap and again when a held answer is confirmed: a limit can
 * be set or used up while the confirm sheet is open, and the person who
 * confirms is the one these bars are about.
 *
 * @param facts - The request that is answering: the tap, or the confirmation.
 * @param paid - The approval, the answer and the spending lookups.
 * @returns The problem document to refuse with, or null.
 */
export function refusePaidRunAnswer(facts: RequestFacts, paid: PaidRunAnswer): Problem | null {
  // Money leaves the owner's account: under login, only the owner answers (Security Must 2).
  const gated = paid.isLoginEnabled ? paid.isLoginEnabled() : personSessionRequired(facts);
  if (gated && !isInstallOwner(facts.user)) {
    return problemBody('owner_only', {
      detail: 'Only the owner of this DorkOS can allow a paid run.',
    });
  }
  // "Always" for money is the monthly limit, set in Connections.
  if (paid.answer === 'always') {
    return problemBody('always_not_offered', { detail: 'Paid runs are allowed once at a time.' });
  }
  // A limit set or used up since the card was raised.
  const receipt = paid.tapRefusal?.(paid.approvalId) ?? null;
  if (receipt !== null) {
    paid.deny(paid.approvalId, receipt);
    // The spending service's own fixed receipt, the sentence the card shows.
    return problemBody('spend_limit_reached', { detail: receipt });
  }
  return null;
}
