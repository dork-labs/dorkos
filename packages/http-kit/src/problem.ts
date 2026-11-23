/**
 * Sending the one error shape: an RFC 9457 problem document, served as
 * `application/problem+json`, its status and title taken from the code list in
 * `@dorkos/shared/problem`.
 *
 * @module http-kit/problem
 */
import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { z } from 'zod';
import {
  PROBLEM_CODES,
  PROBLEM_CONTENT_TYPE,
  problemType,
  type Problem,
  type ProblemCode,
  type ProblemIssues,
} from '@dorkos/shared/problem';

/** What a sender may say about one occurrence, beyond its code. */
export interface ProblemOptions {
  /** A longer explanation of this occurrence, safe to show a person. */
  detail?: string;
  /** The status, when this occurrence needs a different one than the code's default. */
  status?: ContentfulStatusCode;
  /** An opaque identifier for this occurrence. */
  instance?: string;
  /**
   * How long to wait before retrying. Also sent as a `Retry-After` header, in
   * whole seconds rounded up.
   */
  retryAfterMs?: number;
  /** What failed validation; {@link validationProblem} fills it. */
  issues?: ProblemIssues;
}

/**
 * The problem document for a code, with the code's default status and title.
 *
 * @param code - The failure code.
 * @param options - See {@link ProblemOptions}.
 * @returns The document.
 */
export function problemBody(code: ProblemCode, options: ProblemOptions = {}): Problem {
  const definition = PROBLEM_CODES[code];
  return {
    type: problemType(code),
    title: definition.title,
    status: options.status ?? definition.status,
    code,
    ...(options.detail === undefined ? {} : { detail: options.detail }),
    ...(options.instance === undefined ? {} : { instance: options.instance }),
    ...(options.retryAfterMs === undefined ? {} : { retryAfterMs: options.retryAfterMs }),
    ...(options.issues === undefined ? {} : { issues: options.issues }),
  };
}

/**
 * Answer a request with a problem document.
 *
 * @param c - The Hono context.
 * @param code - The failure code; its default status and title come from the list.
 * @param options - See {@link ProblemOptions}.
 * @returns The response.
 */
export function problem(c: Context, code: ProblemCode, options: ProblemOptions = {}): Response {
  const body = problemBody(code, options);
  const headers: Record<string, string> = { 'Content-Type': PROBLEM_CONTENT_TYPE };
  if (body.retryAfterMs !== undefined) {
    headers['Retry-After'] = String(Math.ceil(body.retryAfterMs / 1000));
  }
  return c.body(JSON.stringify(body), body.status as ContentfulStatusCode, headers);
}

/**
 * Answer a request whose input failed its schema: a `malformed_request` problem
 * carrying the failure in Zod's flattened form.
 *
 * @param c - The Hono context.
 * @param error - Why the input failed its schema.
 * @param options - Anything else to say; `issues` is always the error's.
 * @returns The response.
 */
export function validationProblem(
  c: Context,
  error: z.ZodError,
  options: Omit<ProblemOptions, 'issues'> = {}
): Response {
  const flat = z.flattenError(error);
  const fieldErrors: Record<string, string[]> = {};
  for (const [field, messages] of Object.entries(flat.fieldErrors)) {
    if (Array.isArray(messages)) fieldErrors[field] = messages;
  }
  return problem(c, 'malformed_request', {
    ...options,
    issues: { formErrors: flat.formErrors, fieldErrors },
  });
}
