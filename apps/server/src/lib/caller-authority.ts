/**
 * Read, from one Express request, exactly the facts that decide whether a caller
 * is a person acting for themselves (spec `agent-trust` §3.3, DOR-467).
 *
 * There is one predicate for that question — `resolveDecisionAuthority` — and
 * three surfaces that need it: the endpoint that DECIDES an approval
 * (`routes/approvals.ts`), and the two mutation routes that must act without one
 * when the caller is a person (`routes/marketplace.ts`, `routes/config.ts`).
 *
 * They share this reader rather than each pulling headers off a request, because
 * the failure that matters here is not a wrong answer but a DIVERGENT one: if the
 * decide endpoint and the act-without-approval path disagree about what counts as
 * a person, one of them is wrong and nothing says which. Keeping the read in one
 * place is what lets the guarantee be stated as a single sentence — whoever may
 * decide an approval may act without one — and stay true.
 *
 * @module lib/caller-authority
 */
import type { Request, Response } from 'express';

import type { DecisionAuthorityRequest } from '../services/core/approvals/index.js';
import { APPROVAL_TOKEN_HEADER } from '../services/core/capabilities/index.js';
import { AGENT_IDENTITY_HEADER, getRequestAgentIdentity } from '../middleware/agent-identity.js';
import type { RequestUser } from '../services/core/auth/session-gate.js';

/**
 * Build the {@link DecisionAuthorityRequest} for an incoming request.
 *
 * An agent counts as present if EITHER the middleware resolved one or the raw
 * `X-DorkOS-Agent` header is there at all: a header that did not resolve (a
 * revoked or expired agent) still means a machine is calling, and a person in the
 * cockpit never sends it.
 *
 * @param req - The incoming request.
 * @param res - The response carrying `sessionGate`'s resolved user.
 * @returns What the caller presented, for `resolveDecisionAuthority`.
 */
export function readCallerAuthority(req: Request, res: Response): DecisionAuthorityRequest {
  const user = res.locals.user as RequestUser | undefined;
  return {
    agentIdentityPresented:
      getRequestAgentIdentity(res) !== undefined ||
      req.headers[AGENT_IDENTITY_HEADER] !== undefined,
    approvalTokenPresented: req.headers[APPROVAL_TOKEN_HEADER] !== undefined,
    ...(user ? { user } : {}),
  };
}
