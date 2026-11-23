/**
 * Sending the one error shape: an RFC 9457 problem document, served as
 * `application/problem+json`, its status and title taken from the code list in
 * `@dorkos/shared/problem`.
 *
 * @module http-kit/problem
 */
import type { Context } from 'hono';
import type {
  ClientErrorStatusCode,
  ContentfulStatusCode,
  ServerErrorStatusCode,
} from 'hono/utils/http-status';
import { z } from 'zod';
import {
  PROBLEM_CODES,
  PROBLEM_CONTENT_TYPE,
  problemType,
  type Problem,
  type ProblemCode,
  type ProblemIssues,
} from '@dorkos/shared/problem';

/** A status a problem may carry: a client or server error, never a success. */
export type ProblemStatus = ClientErrorStatusCode | ServerErrorStatusCode;

/** What a sender may say about one occurrence, beyond its code. */
export interface ProblemOptions {
  /** A longer explanation of this occurrence, safe to show a person. */
  detail?: string;
  /** The status, when this occurrence needs a different one than the code's default. */
  status?: ProblemStatus;
  /** An opaque identifier for this occurrence. */
  instance?: string;
  /**
   * How long to wait before retrying. Rounded up to a whole, non-negative
   * number of milliseconds, and also sent as a `Retry-After` header in whole
   * seconds rounded up.
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
    ...(options.retryAfterMs === undefined
      ? {}
      : { retryAfterMs: Math.max(0, Math.ceil(options.retryAfterMs)) }),
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
  return sendProblem(c, problemBody(code, options));
}

/**
 * Answer a request with a problem document already built, such as one the
 * server's error handler chose: its status, the problem media type, and a
 * `Retry-After` header when it says how long to wait.
 *
 * @param c - The Hono context.
 * @param body - The document, from {@link problemBody}.
 * @returns The response.
 */
export function sendProblem(c: Context, body: Problem): Response {
  const headers: Record<string, string> = { 'Content-Type': PROBLEM_CONTENT_TYPE };
  if (body.retryAfterMs !== undefined) {
    headers['Retry-After'] = String(Math.ceil(body.retryAfterMs / 1000));
  }
  return c.body(JSON.stringify(body), body.status as ContentfulStatusCode, headers);
}

/** The most words {@link validationDetail} writes, so it fits a line of app copy. */
const VALIDATION_DETAIL_MAX_WORDS = 15;

/**
 * One sentence for a validation failure: the first field and what was wrong
 * with it ("`name`: Required."), then how many more there are.
 *
 * @param issues - The failure in Zod's flattened form.
 * @returns The sentence, or `undefined` when the failure names nothing.
 */
export function validationDetail(issues: ProblemIssues): string | undefined {
  const lines = [
    ...Object.entries(issues.fieldErrors).flatMap(([field, messages]) =>
      messages.map((message) => `\`${field}\`: ${message}`)
    ),
    ...issues.formErrors,
  ];
  if (lines.length === 0) return undefined;
  const more = lines.length - 1;
  const suffix = more > 0 ? ` (and ${more} more)` : '';
  const budget = VALIDATION_DETAIL_MAX_WORDS - (more > 0 ? 3 : 0);
  const words = lines[0]!.trim().replace(/[.]+$/, '').split(/\s+/);
  const first = words.length > budget ? `${words.slice(0, budget).join(' ')}…` : words.join(' ');
  return `${first}${suffix}.`;
}

/**
 * The problem document for input that failed its schema: an `invalid_request`
 * carrying the failure, and a `detail` naming the first field when the sender
 * gives none.
 *
 * @param issues - The failure in Zod's flattened form.
 * @param options - Anything else to say; `issues` is always the failure's.
 * @returns The document.
 */
export function validationProblemBody(
  issues: ProblemIssues,
  options: Omit<ProblemOptions, 'issues'> = {}
): Problem {
  const detail = options.detail ?? validationDetail(issues);
  return problemBody('invalid_request', {
    ...options,
    ...(detail === undefined ? {} : { detail }),
    issues,
  });
}

/**
 * Answer a request whose input was read and failed its schema: an
 * `invalid_request` problem carrying the failure in Zod's flattened form (a
 * body that could not be read at all is `malformed_request`, from the chain).
 *
 * @param c - The Hono context.
 * @param error - Why the input failed its schema.
 * @param options - Anything else to say; `issues` is always the error's, and
 *   `detail` defaults to one naming the first field.
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
  return sendProblem(
    c,
    validationProblemBody({ formErrors: flat.formErrors, fieldErrors }, options)
  );
}
