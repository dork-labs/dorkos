/**
 * The answer to an approval decision that could not be recorded: a problem
 * document (DOR-4979).
 *
 * @module routes/approval-decision-response
 */
import { problemBody } from '@dorkos/http-kit';
import type { Problem } from '@dorkos/shared/problem';
import { INCOMPLETE_APPROVAL_MESSAGE } from '../services/core/approvals/approval-completeness.js';
import type { ApprovalDecisionFailure } from '../services/core/approvals/index.js';
import type { StepUpCommitResult } from '../services/core/auth/step-up/step-up-holds.js';

/**
 * The problem for a decision failure. Each failure has its own way out: a card
 * nobody knows, one already answered, one whose window closed, and one that
 * can only be declined.
 *
 * @param failure - Why the decision was not recorded.
 * @returns The problem document.
 */
export function decisionFailureProblem(failure: ApprovalDecisionFailure): Problem {
  switch (failure) {
    case 'incomplete':
      return problemBody('conflict', { detail: INCOMPLETE_APPROVAL_MESSAGE });
    case 'unknown':
      return problemBody('not_found', { detail: 'No such approval.' });
    case 'not_pending':
      return problemBody('already_resolved', { detail: 'This approval was already decided.' });
    case 'expired':
      return problemBody('expired', {
        detail: 'This approval expired before it was decided.',
      });
  }
}

/**
 * A held answer's commit result for a decision failure. A confirmation for a
 * changed request keeps the `409 different-request` body: it never leaves the
 * server, because the step-up route reads it and answers that refusal itself.
 *
 * @param failure - Why the decision was not recorded.
 * @returns The status and body the commit hands back.
 */
export function decisionFailureResponse(
  failure: ApprovalDecisionFailure | 'different-request'
): StepUpCommitResult {
  if (failure === 'different-request') {
    return {
      status: 409,
      body: {
        error: 'That confirmation was for a different request. Confirm this one.',
        code: 'different-request',
      },
    };
  }
  const body = decisionFailureProblem(failure);
  return { status: body.status, body };
}
