/**
 * What a refusal from DorkOS credits means for the token, read only from the
 * codes the public contract publishes (`packages/cloud-api`: `ProblemCodeSchema`
 * in `problem.ts`, `InferenceRefusalReasonSchema` in `inference.ts`).
 *
 * Three answers, because each one asks for a different move:
 *
 * - **`token`**: this token is no good any more (expired, revoked, unknown).
 *   Drop it and mint a new one now; the account is fine.
 * - **`account`**: the account may not spend right now (no credit, the daily
 *   limit, an allowance it does not have). Minting again changes nothing, so
 *   an agent computer holds new mints for a while.
 * - **`busy`**: anything else, including a code this release does not know
 *   and the waits (`rate_limited`, `concurrency_exceeded`,
 *   `turn_budget_exhausted`): the answer passes through and nothing is dropped
 *   or held. This is the safe default: a busy moment must never cut a computer
 *   off.
 *
 * The code is read from the problem envelope's `code`, or from the `code` of
 * the vendor error envelope (`{ error: { code } }`) the endpoint's verbatim
 * protocols answer in. Only the codes listed here are trusted; everything else
 * is `busy`, except a bare `401`, which by definition means the token was not
 * accepted.
 *
 * @module services/core/cloud/credits-refusals
 */

/** What a refusal means for the token; see the module doc. */
export type CreditsRefusalKind = 'token' | 'account' | 'busy';

/** Public codes that say the token itself is no good. */
const TOKEN_CODES: ReadonlySet<string> = new Set([
  // `ProblemCodeSchema`
  'unauthenticated',
  'invalid_token',
  'expired_token',
  // `InferenceRefusalReasonSchema`
  'token_revoked',
  'token_expired',
]);

/** Public codes that say the account may not spend, whatever token it holds. */
const ACCOUNT_CODES: ReadonlySet<string> = new Set([
  // Both vocabularies
  'entitlement_required',
  'balance_exhausted',
  // `ProblemCodeSchema`
  'quota_exceeded',
  // `InferenceRefusalReasonSchema`
  'daily_limit_reached',
]);

/** Public codes that mean "wait", never "no". Never held, on either side. */
const WAIT_CODES: ReadonlySet<string> = new Set([
  'rate_limited',
  'concurrency_exceeded',
  'turn_budget_exhausted',
  'temporarily_unavailable',
  'model_unavailable',
  'conflict',
]);

/** HTTP answers to a mint that mean "try again", never "no". */
const WAIT_STATUSES: ReadonlySet<number> = new Set([408, 409, 429]);

/**
 * The refusal code a body carries, or `null`: the problem envelope's `code`,
 * else the vendor error envelope's.
 *
 * @param body - The parsed response body, or anything else.
 */
export function refusalCodeOf(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null;
  const top = (body as { code?: unknown }).code;
  if (typeof top === 'string') return top;
  const nested = (body as { error?: { code?: unknown } }).error?.code;
  return typeof nested === 'string' ? nested : null;
}

/**
 * What the endpoint's refusal of a request means for the token that carried it.
 *
 * @param status - The HTTP status the endpoint answered with.
 * @param code - The refusal code it carried ({@link refusalCodeOf}), if any.
 */
export function classifyCreditsRefusal(status: number, code: string | null): CreditsRefusalKind {
  if (code !== null && ACCOUNT_CODES.has(code)) return 'account';
  if (code !== null && TOKEN_CODES.has(code)) return 'token';
  if (code !== null && WAIT_CODES.has(code)) return 'busy';
  return status === 401 ? 'token' : 'busy';
}

/**
 * Whether a refused mint is a definite no, worth holding new mints for: a
 * `4xx` that is not a wait (408, 409, 429, or a wait code). Never an outage.
 *
 * @param status - The HTTP status the mint was answered with, or `null` for none.
 * @param code - The problem code it carried, if any.
 */
export function mintRefusalHolds(status: number | null, code: string | null): boolean {
  if (status === null || status < 400 || status >= 500) return false;
  if (WAIT_STATUSES.has(status)) return false;
  return code === null || !WAIT_CODES.has(code);
}
