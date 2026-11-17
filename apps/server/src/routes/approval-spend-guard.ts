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
 * @returns The HTTP status and body to refuse with, or null.
 */
export function refusePaidRunAnswer(
  facts: RequestFacts,
  paid: PaidRunAnswer
): { status: 403 | 409; body: { error: string; code: string } } | null {
  // Money leaves the owner's account: under login, only the owner answers (Security Must 2).
  const gated = paid.isLoginEnabled ? paid.isLoginEnabled() : personSessionRequired(facts);
  if (gated && !isInstallOwner(facts.user)) {
    return {
      status: 403,
      body: {
        error: 'Only the owner of this DorkOS can allow a paid run.',
        code: 'SPEND_OWNER_ONLY',
      },
    };
  }
  // "Always" for money is the monthly limit, set in Connections.
  if (paid.answer === 'always') {
    return {
      status: 409,
      body: { error: 'Paid runs are allowed once at a time.', code: 'SPEND_ONCE_ONLY' },
    };
  }
  // A limit set or used up since the card was raised.
  const receipt = paid.tapRefusal?.(paid.approvalId) ?? null;
  if (receipt !== null) {
    paid.deny(paid.approvalId, receipt);
    return { status: 409, body: { error: receipt, code: 'SPEND_LIMIT' } };
  }
  return null;
}
