/**
 * The one error shape the DorkOS API answers a failed request with: an RFC 9457
 * problem document, served as `application/problem+json`.
 *
 * This file holds the shape and the stable list of failure codes (the codes
 * themselves are in `./problem-codes/`), and nothing that sends a response,
 * so the web client and the desktop shell can read a refusal without pulling
 * in a server framework. The server sends one through
 * `problem()` and `validationProblem()` in `@dorkos/http-kit`.
 *
 * The fields follow the DorkOS Cloud contract's `ProblemSchema`
 * (`packages/cloud-api/src/problem.ts`) field for field where the two overlap
 * (`code`, `status`, `title`, `detail`, `instance`, `retryAfterMs`), and a code
 * both lists name means the same thing in both. RFC 9457's own `type` member
 * and a validation failure's `issues` are added here; the Cloud contract's
 * plan and action-link fields are not, because nothing on this server has a
 * plan to name.
 *
 * Codes are `lower_snake`, as the Cloud contract's are. A code is permanent
 * once a client can see it: add one, never rename one.
 *
 * @module shared/problem
 */
import { z } from 'zod';
import { ALL_PROBLEM_CODES, type ProblemCodeDefinition } from './problem-codes/index.js';
import { extendZodWithOpenApiOnce } from './zod-openapi.js';

extendZodWithOpenApiOnce();

/** The media type a problem document is served as (RFC 9457 §3). */
export const PROBLEM_CONTENT_TYPE = 'application/problem+json';

export type { ProblemCodeDefinition } from './problem-codes/index.js';

/**
 * Every failure code the API can answer with, each with its default status and
 * title. The single list: a code missing here cannot be sent.
 *
 * Seeded from the codes the server's routes answer with today (most of them in
 * `SCREAMING_CASE` until DOR-4979 moves the routes to this shape). Codes the
 * DorkOS Cloud contract also names keep its spelling.
 *
 * The codes live in `./problem-codes/`, one file per group.
 */
export const PROBLEM_CODE_LIST = ALL_PROBLEM_CODES;

/** A failure code from {@link PROBLEM_CODE_LIST}. */
export type ProblemCode = (typeof PROBLEM_CODE_LIST)[number]['code'];

/** Every code's definition, by code. */
export const PROBLEM_CODES: Readonly<Record<ProblemCode, ProblemCodeDefinition>> =
  Object.fromEntries(PROBLEM_CODE_LIST.map((entry) => [entry.code, entry])) as Record<
    ProblemCode,
    ProblemCodeDefinition
  >;

/** How every failure code is spelled: `lower_snake`, as the Cloud contract's are. */
export const PROBLEM_CODE_PATTERN = /^[a-z]+(?:_[a-z]+)*$/;

/** The machine-readable failure code: one this server sends. */
export const ProblemCodeSchema = z
  .enum(PROBLEM_CODE_LIST.map((entry) => entry.code) as [ProblemCode, ...ProblemCode[]])
  .describe('The machine-readable failure code. Permanent once published.')
  .openapi('ProblemCode');

/**
 * What a request failed its schema on, in Zod's flattened form
 * (`z.flattenError`): messages about the whole value, and messages per field.
 */
export const ProblemIssuesSchema = z
  .object({
    formErrors: z.array(z.string()).describe('Messages about the value as a whole.'),
    fieldErrors: z
      .record(z.string(), z.array(z.string()))
      .describe('Messages for each field that failed, by field name.'),
  })
  .openapi('ProblemIssues');

/** A validation failure's issues. */
export type ProblemIssues = z.infer<typeof ProblemIssuesSchema>;

/**
 * The URI that names a code's problem type (RFC 9457 §3.1.1). A URN, so it
 * names the type without promising a page at it.
 *
 * @param code - The failure code.
 * @returns The problem type URI.
 */
export function problemType(code: ProblemCode): string {
  return `urn:dorkos:problem:${code}`;
}

/**
 * The error document every failed API request is answered with.
 *
 * For READING: `code` is any `lower_snake` code, so a problem from DorkOS Cloud
 * (whose codes this list does not hold) reads as one. Sending is narrower:
 * `problem()` in `@dorkos/http-kit` takes only a {@link ProblemCode}.
 */
export const ProblemSchema = z
  .object({
    type: z
      .string()
      .optional()
      .describe(
        'A URI naming the problem type: `urn:dorkos:problem:<code>`. Absent means `about:blank` (RFC 9457 §3.1.1), as in a DorkOS Cloud problem; this server always sends it.'
      ),
    title: z.string().describe('A short, human-readable summary, safe to show a person.'),
    status: z
      .number()
      .int()
      .min(400)
      .max(599)
      .describe('The HTTP status that accompanied this problem.'),
    detail: z
      .string()
      .optional()
      .describe('A longer explanation of this specific occurrence, safe to show a person.'),
    code: z
      .string()
      .regex(PROBLEM_CODE_PATTERN)
      .describe(
        'The machine-readable failure code, `lower_snake`. This server sends only the codes in `ProblemCode`; a reader accepts any, so a DorkOS Cloud code reads too.'
      ),
    instance: z
      .string()
      .optional()
      .describe('An opaque identifier for this occurrence, to quote when reporting it.'),
    retryAfterMs: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe('How long to wait before retrying, when the failure is transient.'),
    issues: ProblemIssuesSchema.optional().describe(
      'What failed validation, when the request did not match its schema.'
    ),
  })
  .describe('The error document every failed API request is answered with (RFC 9457).')
  .openapi('Problem');

/** The error document every failed API request is answered with. */
export type Problem = z.infer<typeof ProblemSchema>;

/**
 * Narrows an unknown value, such as a parsed response body, to a {@link Problem}.
 *
 * @param value - A value of unknown shape.
 * @returns Whether it is a problem document.
 */
export function isProblem(value: unknown): value is Problem {
  return ProblemSchema.safeParse(value).success;
}

/**
 * What a failed response said, read the same way by every client: a message to
 * show a person and, when the server gave one, a stable code to branch on.
 */
export interface ErrorBodyReading {
  /** A sentence safe to show a person. */
  message: string;
  /** The machine-readable failure code, exactly as the server spelled it. */
  code?: string;
  /** The status the body itself named (a problem's `status`). */
  status?: number;
  /** What failed validation, in Zod's flattened form. */
  issues?: ProblemIssues;
  /** How long to wait before retrying, when the body says. */
  retryAfterMs?: number;
}

/**
 * The codes of the few failed answers that are not problem documents on
 * purpose, and that every client still reads (ADR 261123-170831): the login
 * gate's `401` (`AUTH_REQUIRED`), and the `428`s that hold an action for a
 * person, a step-up (`step_up_required`, `./step-up.ts`) and a passkey check
 * (`PASSKEY_CHECK_REQUIRED`, `./signed-in-devices.ts`). Each says its sentence
 * in `error` and names itself in `code`.
 */
const HELD_AND_GATE_CODES: ReadonlySet<string> = new Set([
  'AUTH_REQUIRED',
  'step_up_required',
  'PASSKEY_CHECK_REQUIRED',
]);

/**
 * Read a failed response's parsed JSON body: a problem document (`detail`,
 * else `title`), or one of the few answers that are not problems on purpose
 * (the login gate, a held step-up or passkey check). Any other body says
 * nothing a client may rely on, so it reads as the fallback.
 *
 * @param body - The parsed body, of unknown shape (or nothing, when it was not JSON).
 * @param fallbackMessage - The message when the body says none, such as `HTTP 500`.
 * @returns The reading.
 */
export function readErrorBody(body: unknown, fallbackMessage: string): ErrorBodyReading {
  if (isProblem(body)) {
    return {
      message: body.detail ?? body.title,
      code: body.code,
      status: body.status,
      ...(body.issues === undefined ? {} : { issues: body.issues }),
      ...(body.retryAfterMs === undefined ? {} : { retryAfterMs: body.retryAfterMs }),
    };
  }
  const held = body as { error?: unknown; code?: unknown } | null | undefined;
  if (typeof held?.code !== 'string' || !HELD_AND_GATE_CODES.has(held.code)) {
    return { message: fallbackMessage };
  }
  const said = typeof held.error === 'string' && held.error !== '' ? held.error : fallbackMessage;
  return { message: said, code: held.code };
}
