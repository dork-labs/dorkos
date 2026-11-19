import { INCOMPLETE_APPROVAL_MESSAGE } from '../services/core/approvals/approval-completeness.js';
import type { ApprovalDecisionFailure } from '../services/core/approvals/index.js';

/** Map a decision failure onto the HTTP status and code the app branches on. */
export function decisionFailureResponse(failure: ApprovalDecisionFailure | 'different-request'): {
  status: number;
  body: { error: string; code: string };
} {
  switch (failure) {
    case 'different-request':
      return {
        status: 409,
        body: {
          error: 'That confirmation was for a different request. Confirm this one.',
          code: 'different-request',
        },
      };
    case 'incomplete':
      return {
        status: 409,
        body: { error: INCOMPLETE_APPROVAL_MESSAGE, code: 'APPROVAL_INCOMPLETE' },
      };
    case 'unknown':
      return {
        status: 404,
        body: { error: 'No such approval', code: 'UNKNOWN_APPROVAL' },
      };
    case 'not_pending':
      return {
        status: 409,
        body: { error: 'This approval was already decided', code: 'APPROVAL_NOT_PENDING' },
      };
    case 'expired':
      return {
        status: 410,
        body: { error: 'This approval expired before it was decided', code: 'APPROVAL_EXPIRED' },
      };
  }
}
