import { z } from 'zod';

import { IdSchema, TimestampSchema } from './primitives.js';

/**
 * Every machine-readable failure code this contract can return.
 *
 * These are mechanism, not catalog: they name what went wrong with a request,
 * which is a property of the protocol and is published on purpose. Nothing here
 * names a plan, a model, a supplier or an amount.
 */
export const ProblemCodeSchema = z
  .enum([
    // Authentication and authorization.
    'unauthenticated',
    'invalid_token',
    'expired_token',
    'forbidden',
    'scope_required',
    // Request shape.
    'malformed_request',
    'unsupported_wire_version',
    'not_found',
    'conflict',
    'precondition_failed',
    'rate_limited',
    // Seats, orgs and identity.
    'person_seat_required',
    'seat_unavailable',
    'handle_taken',
    'handle_reserved',
    'handle_tombstoned',
    'claim_not_approved',
    'inbox_full',
    // Entitlement and balance refusals.
    'entitlement_required',
    'balance_exhausted',
    'quota_exceeded',
    'topup_below_minimum',
    'first_purchase_cap',
    'refund_window_closed',
    // Remote access.
    'enrolment_required',
    'remote_disabled',
    'address_unavailable',
    // Hosted communities.
    'community_name_taken',
    'community_name_reserved',
    'import_too_large',
    // The server's own faults.
    'internal_error',
    'temporarily_unavailable',
  ])
  .describe(
    'The machine-readable failure code. Codes describe the mechanism of a refusal and never identify a plan, a model or a supplier.'
  );

/** A machine-readable failure code from {@link ProblemCodeSchema}. */
export type ProblemCode = z.infer<typeof ProblemCodeSchema>;

/**
 * The single error envelope every endpoint in this contract returns.
 *
 * A response is either the route's success schema or this. There is no third
 * shape and no per-route error type, so a client writes one failure path.
 *
 * `requiredPlanId` is present only on a refusal a subscription would lift. It
 * is an opaque identifier paired with a server-supplied display string: the
 * client renders what it is given and never switches on the value, and no
 * amount ever appears here.
 *
 * `actionUrl` is the other half of a refusal a person can do something about:
 * the page, supplied by the service, where they can do it (raise an allowance,
 * add credit, contact the host). The client opens it as given, beside `title`
 * and `detail`, and never builds one itself.
 */
export const ProblemSchema = z
  .object({
    code: ProblemCodeSchema,
    status: z
      .number()
      .int()
      .min(400)
      .max(599)
      .describe('The HTTP status that accompanied this problem.'),
    title: z.string().describe('A short, human-readable summary, safe to show a person.'),
    detail: z
      .string()
      .optional()
      .describe('A longer explanation of this specific occurrence, safe to show a person.'),
    instance: IdSchema.optional().describe(
      'An opaque request identifier to quote when reporting the failure.'
    ),
    retryAfterMs: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe('How long to wait before retrying, when the failure is transient.'),
    requiredPlanId: IdSchema.optional().describe(
      'An opaque identifier for the subscription that would lift this refusal. Render the accompanying display string; never branch on this value.'
    ),
    requiredPlanDisplayName: z
      .string()
      .optional()
      .describe('The server-supplied display string for `requiredPlanId`.'),
    freesAt: TimestampSchema.optional().describe(
      'When the blocking condition clears, where the server can say so.'
    ),
    actionUrl: z
      .string()
      .url()
      .optional()
      .describe(
        'A page, supplied by the service, where a person can act on this refusal. Open it as given; a runtime value.'
      ),
    actionLabel: z
      .string()
      .optional()
      .describe('The server-supplied text for a link or button that opens `actionUrl`.'),
  })
  .describe(
    'The error envelope every endpoint in this contract returns in place of its success body.'
  );

/** The error envelope every endpoint returns in place of its success body. */
export type Problem = z.infer<typeof ProblemSchema>;

/**
 * Narrows an unknown value to a {@link Problem}.
 *
 * @param value - A parsed response body of unknown shape.
 */
export function isProblem(value: unknown): value is Problem {
  return ProblemSchema.safeParse(value).success;
}
