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
 * ## Deciding needs proof of a person, not the absence of proof of a machine
 *
 * Who may decide is `resolveDecisionAuthority` in
 * `services/core/approvals/decision-authority.ts`, and its module TSDoc is the
 * honest statement of what that guarantees under each posture — including what it
 * cannot guarantee when local login is off. Read it before changing anything here:
 * the earlier version of this file refused a caller that PRESENTED an agent
 * identity and let every other caller through, which made a bare `curl` with no
 * headers a complete self-approval bypass.
 *
 * Every recorded decision is written to the Activity feed with the posture it was
 * made under, so a "yes" that nobody clicked in the cockpit still leaves a trace.
 *
 * Transport auth is the global `sessionGate` mounted in `app.ts` — every `/api/*`
 * path inherits it, so these routes need no gate of their own; the authority check
 * below is a second, independent one.
 *
 * @module routes/approvals
 */
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { DenyApprovalBodySchema } from '@dorkos/shared/approval-schemas';
import type { ApprovalDecisionFailure, ApprovalService } from '../services/core/approvals/index.js';
import {
  resolveDecisionAuthority,
  type DecisionAuthorityResult,
  type LoginEnabledLookup,
} from '../services/core/approvals/index.js';
import { APPROVAL_TOKEN_HEADER } from '../services/core/capabilities/index.js';
import type { ActivityService } from '../services/activity/activity-service.js';
import type { RequestUser } from '../services/core/auth/session-gate.js';
import { AGENT_IDENTITY_HEADER, getRequestAgentIdentity } from '../middleware/agent-identity.js';

/** Optional collaborators the boot wiring supplies; omitted in unit tests. */
export interface ApprovalsRouterOptions {
  /**
   * Activity feed writer. Every decision is recorded with its posture, which is
   * the only mitigation available in the `local-trust` posture: DorkOS cannot
   * prove a person clicked, so it makes sure the click is visible.
   */
  activity?: ActivityService;
  /**
   * Whether local login is on. Defaults to the live user config; injected in
   * tests so both postures are exercised against the real route.
   */
  isLoginEnabled?: LoginEnabledLookup;
}

/**
 * Decide whether this request may record a decision.
 *
 * An agent counts as present if EITHER the middleware resolved one or the raw
 * `X-DorkOS-Agent` header is there at all: a header that did not resolve (a revoked
 * or expired agent) still means a machine is calling, and a person in the cockpit
 * never sends it.
 *
 * @param req - The incoming request.
 * @param res - The response carrying `sessionGate`'s resolved user.
 * @param isLoginEnabled - Optional login-state lookup for tests.
 * @returns Permission with its posture, or a structured refusal.
 */
function decisionAuthority(
  req: Request,
  res: Response,
  isLoginEnabled?: LoginEnabledLookup
): DecisionAuthorityResult {
  return resolveDecisionAuthority({
    agentIdentityPresented:
      getRequestAgentIdentity(res) !== undefined ||
      req.headers[AGENT_IDENTITY_HEADER] !== undefined,
    approvalTokenPresented: req.headers[APPROVAL_TOKEN_HEADER] !== undefined,
    ...((res.locals.user as RequestUser | undefined)
      ? { user: res.locals.user as RequestUser }
      : {}),
    ...(isLoginEnabled ? { loginEnabled: isLoginEnabled } : {}),
  });
}

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
 * @param options - Boot collaborators; see {@link ApprovalsRouterOptions}.
 * @returns The configured router, to mount at `/api/approvals`.
 */
export function createApprovalsRouter(
  approvals: ApprovalService,
  options: ApprovalsRouterOptions = {}
): Router {
  const router = Router();

  /**
   * Record a decision in the Activity feed, naming the posture it rests on.
   *
   * `emit` is fire-and-forget and never throws, so this cannot turn a recorded
   * decision into a failed request.
   */
  const auditDecision = (
    approvalId: string,
    outcome: 'granted' | 'denied',
    authority: Extract<DecisionAuthorityResult, { allowed: true }>
  ): void => {
    void options.activity?.emit({
      actorType: 'user',
      actorLabel: authority.decidedBy,
      category: 'agent',
      eventType: outcome === 'granted' ? 'approval.granted' : 'approval.denied',
      resourceType: 'approval',
      resourceId: approvalId,
      summary:
        authority.posture === 'signed-in-operator'
          ? `A signed-in person ${outcome} an approval`
          : `An approval was ${outcome} from this machine (login is off, so DorkOS cannot verify who)`,
      metadata: { posture: authority.posture, outcome },
    });
  };

  // GET /pending -- approvals still waiting on a person
  router.get('/pending', (_req, res) => {
    res.json({ approvals: approvals.listPending() });
  });

  // POST /:id/grant -- allow the requested action
  router.post('/:id/grant', (req, res) => {
    const authority = decisionAuthority(req, res, options.isLoginEnabled);
    if (!authority.allowed) {
      return res.status(authority.status).json({ error: authority.error, code: authority.code });
    }

    const failure = approvals.grant(req.params.id);
    if (failure) {
      const mapped = decisionFailureResponse(failure);
      return res.status(mapped.status).json(mapped.body);
    }
    auditDecision(req.params.id, 'granted', authority);
    return res.json({ ok: true, approvalId: req.params.id, outcome: 'granted' });
  });

  // POST /:id/deny -- refuse the requested action
  router.post('/:id/deny', (req, res) => {
    const authority = decisionAuthority(req, res, options.isLoginEnabled);
    if (!authority.allowed) {
      return res.status(authority.status).json({ error: authority.error, code: authority.code });
    }

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
    auditDecision(req.params.id, 'denied', authority);
    return res.json({ ok: true, approvalId: req.params.id, outcome: 'denied' });
  });

  return router;
}
