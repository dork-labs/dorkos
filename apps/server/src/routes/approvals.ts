/**
 * Approvals routes (spec `agent-trust` §3.3).
 *
 * The cockpit's side of the approval primitive: list what is waiting, then say
 * yes or no.
 *
 * - `GET /api/approvals/pending` — approvals still waiting on a person
 * - `POST /api/approvals/:id/grant` — allow the requested action
 * - `POST /api/approvals/:id/deny` — refuse it, with an optional reason
 *
 * Decisions are made by approval id, never by token: the person deciding should
 * not have to hold the requester's secret, and no response here ever returns
 * token material.
 *
 * Auth is the global `sessionGate` mounted in `app.ts` — every `/api/*` path
 * inherits it, so these routes need no gate of their own.
 *
 * @module routes/approvals
 */
import { Router } from 'express';
import { z } from 'zod';
import { DenyApprovalBodySchema } from '@dorkos/shared/approval-schemas';
import type { ApprovalDecisionFailure, ApprovalService } from '../services/core/approvals/index.js';

/** Map a decision failure onto the HTTP status and code the cockpit branches on. */
function decisionFailureResponse(failure: ApprovalDecisionFailure): {
  status: number;
  body: { error: string; code: string };
} {
  switch (failure) {
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

/**
 * Create the approvals router.
 *
 * @param approvals - The approval service that owns the token lifecycle.
 * @returns The configured router, to mount at `/api/approvals`.
 */
export function createApprovalsRouter(approvals: ApprovalService): Router {
  const router = Router();

  // GET /pending -- approvals still waiting on a person
  router.get('/pending', (_req, res) => {
    res.json({ approvals: approvals.listPending() });
  });

  // POST /:id/grant -- allow the requested action
  router.post('/:id/grant', (req, res) => {
    const failure = approvals.grant(req.params.id);
    if (failure) {
      const mapped = decisionFailureResponse(failure);
      return res.status(mapped.status).json(mapped.body);
    }
    return res.json({ ok: true, approvalId: req.params.id, outcome: 'granted' });
  });

  // POST /:id/deny -- refuse the requested action
  router.post('/:id/deny', (req, res) => {
    // Express 5 leaves `req.body` undefined on an empty POST, and a reason is
    // optional, so an absent body is a valid bare denial.
    const parsed = DenyApprovalBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({
        error: 'Validation failed',
        code: 'INVALID_DENY_BODY',
        details: z.flattenError(parsed.error),
      });
    }

    const failure = approvals.deny(req.params.id, parsed.data.reason);
    if (failure) {
      const mapped = decisionFailureResponse(failure);
      return res.status(mapped.status).json(mapped.body);
    }
    return res.json({ ok: true, approvalId: req.params.id, outcome: 'denied' });
  });

  return router;
}
