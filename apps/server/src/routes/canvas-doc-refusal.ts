/**
 * How the canvas document routes answer a refusal (DOR-4979): a problem
 * document whose `code` follows the HTTP status, and whose `detail` is the
 * route's own sentence for the document channel's refusal, written for a person.
 *
 * The channel has dozens of refusals and the code list holds none of them on
 * purpose: they are one domain's detail, and every one of them is one of a
 * handful of HTTP meanings, told apart by the sentence. Two kinds are the
 * exception, because a reader acts on them and a status alone cannot say
 * them: who is asking, and a route that changed since the person reviewed it.
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

/**
 * Refusals that keep their own code whatever the status: who is asking, and
 * what the person reviewed changing under them (the app reviews it again).
 */
const CODE_BY_REFUSAL: Readonly<Record<string, ProblemCode>> = {
  AGENT_IDENTITY_UNVERIFIED: 'agent_identity_unverified',
  PERSON_REQUIRED: 'person_only',
  OPERATOR_COOKIE_REQUIRED: 'person_only',
  AGENT_CANNOT_DECIDE: 'person_only',
  REQUESTER_CANNOT_DECIDE: 'person_only',
  ROUTE_CHANGED: 'precondition_failed',
  GRANT_BINDING_CHANGED: 'precondition_failed',
  DECLARATION_HASH_MISMATCH: 'precondition_failed',
  MANIFEST_CHANGED: 'precondition_failed',
};

/** One refusal, as a document route decided it. */
export interface DocRefusal {
  /** The HTTP status, 400 to 599. */
  status: number;
  /** The document channel's own refusal code, in any case; omitted for a fault. */
  refusal?: string;
  /** One sentence for a person. Never a path, a payload or authority evidence. */
  detail: string;
  /** How long to wait, for a refusal that clears with time. */
  retryAfterMs?: number;
}

/**
 * Answer a document route's refusal as a problem document.
 *
 * A status the table does not hold (a `507` storage failure, a `500`) is an
 * `internal_error` carrying its own status. A refusal that something changed
 * since the person reviewed it answers `412`, whatever status the channel gave.
 *
 * @param c - The request's context.
 * @param refusal - What was refused, and why.
 * @returns The response.
 */
export function docRefusalProblem(c: Context, refusal: DocRefusal): Response {
  const named = refusal.refusal?.toUpperCase();
  const code: ProblemCode =
    (named !== undefined ? CODE_BY_REFUSAL[named] : undefined) ??
    CODE_BY_STATUS[refusal.status] ??
    'internal_error';
  return problem(c, code, {
    ...(code === 'precondition_failed' ? {} : { status: refusal.status as ProblemStatus }),
    detail: refusal.detail,
    ...(refusal.retryAfterMs === undefined ? {} : { retryAfterMs: refusal.retryAfterMs }),
  });
}
