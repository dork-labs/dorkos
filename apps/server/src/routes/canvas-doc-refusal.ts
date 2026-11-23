/**
 * How the canvas document routes answer a refusal (DOR-4979): a problem
 * document whose `code` follows the HTTP status, and whose `reason` member is
 * the document channel's own refusal in `lower_snake` (`route_changed`,
 * `grant_revoked`, `work_already_reviewed`…), which the app words for a person.
 *
 * The channel has dozens of refusals and the code list holds none of them on
 * purpose: they are one domain's detail, and every one of them is one of a
 * handful of HTTP meanings. A refusal that names who is asking is the
 * exception, because a status alone cannot say it.
 *
 * @module routes/canvas-doc-refusal
 */
import type { Context } from 'hono';
import { problem, type ProblemStatus } from '@dorkos/http-kit';
import type { ProblemCode } from '@dorkos/shared/problem';

/** The problem code for each status the document channel refuses with. */
const CODE_BY_STATUS: Readonly<Record<number, ProblemCode>> = {
  400: 'invalid_request',
  401: 'unauthenticated',
  403: 'forbidden',
  404: 'not_found',
  409: 'conflict',
  412: 'precondition_failed',
  413: 'request_too_large',
  // The app the document runs refused the event: it was read, and did not pass.
  422: 'invalid_request',
  429: 'rate_limited',
  503: 'temporarily_unavailable',
};

/** Refusals about who is asking, which keep their own code whatever the status. */
const CODE_BY_REASON: Readonly<Record<string, ProblemCode>> = {
  agent_identity_unverified: 'agent_identity_unverified',
  person_required: 'person_only',
  operator_cookie_required: 'person_only',
  agent_cannot_decide: 'person_only',
  requester_cannot_decide: 'person_only',
};

/** One refusal, as a document route decided it. */
export interface DocRefusal {
  /** The HTTP status, 400 to 599. */
  status: number;
  /** The document channel's own refusal code, in any case; omitted for a fault. */
  reason?: string;
  /** One sentence for a person. Never a path, a payload or authority evidence. */
  detail: string;
  /** How long to wait, for a refusal that clears with time. */
  retryAfterMs?: number;
}

/**
 * Answer a document route's refusal as a problem document.
 *
 * A status the table does not hold (a `507` storage failure, a `500`) is an
 * `internal_error` carrying its own status, and names no `reason`: a fault's
 * code is the server's business, not the caller's.
 *
 * @param c - The request's context.
 * @param refusal - What was refused, and why.
 * @returns The response.
 */
export function docRefusalProblem(c: Context, refusal: DocRefusal): Response {
  const reason = refusal.reason?.toLowerCase();
  const code: ProblemCode =
    (reason !== undefined ? CODE_BY_REASON[reason] : undefined) ??
    CODE_BY_STATUS[refusal.status] ??
    'internal_error';
  return problem(c, code, {
    status: refusal.status as ProblemStatus,
    detail: refusal.detail,
    ...(refusal.retryAfterMs === undefined ? {} : { retryAfterMs: refusal.retryAfterMs }),
    ...(reason === undefined || code === 'internal_error' ? {} : { extensions: { reason } }),
  });
}
