/**
 * What a refusal from DorkOS credits means for the token, read only from the
 * public contract (`packages/cloud-api`).
 *
 * ## A refused inference request (the relay)
 *
 * The endpoint refuses with `InferenceErrorBodySchema`. Only its
 * `error.dorkos_reason` decides anything; `error.dorkos_code` is never
 * branched on. Three answers, because each asks for a different move:
 *
 * - **`account`**: `startsAccountHold(reason)` says the account cannot run
 *   inference right now. Minting again changes nothing, so an agent computer
 *   holds new mints for a while. This is the contract's decision, not ours.
 * - **`token`**: the reason is `token_revoked` or `token_expired`, or the
 *   answer is a `401` with no reason at all. Drop the token and mint a new one
 *   now; the account is fine.
 * - **`busy`**: everything else, including a missing, unknown or malformed
 *   reason and a body that is not the envelope: the answer passes through and
 *   nothing is dropped or held. A busy moment must never cut a computer off.
 *
 * Reading a body never throws.
 *
 * ## A refused mint
 *
 * The mint answers with the `Problem` envelope (`problem.ts`). It holds only
 * on a `4xx` that is not a wait: never 408, 409 or 429, and never one of the
 * problem codes that mean "try again".
 *
 * @module services/core/cloud/credits-refusals
 */
import {
  InferenceErrorBodySchema,
  startsAccountHold,
  type InferenceRefusalReason,
} from '@dork-labs/cloud-api';

/** What a refusal means for the token; see the module doc. */
export type CreditsRefusalKind = 'token' | 'account' | 'busy';

/** The refusal reasons that say the token itself is no good. */
const TOKEN_REASONS: ReadonlySet<InferenceRefusalReason> = new Set([
  'token_revoked',
  'token_expired',
]);

/** Public problem codes that mean "wait", never "no". A mint refused with one is not held. */
const WAIT_CODES: ReadonlySet<string> = new Set([
  'rate_limited',
  'temporarily_unavailable',
  'conflict',
]);

/** HTTP answers to a mint that mean "try again", never "no". */
const WAIT_STATUSES: ReadonlySet<number> = new Set([408, 409, 429]);

/**
 * The `dorkos_reason` a refused inference request carried, or `undefined`
 * when the body is not the published envelope or names none. Never throws.
 *
 * @param body - The parsed response body, or anything else.
 */
function refusalReasonOf(body: unknown): string | undefined {
  const parsed = InferenceErrorBodySchema.safeParse(body);
  return parsed.success ? parsed.data.error.dorkos_reason : undefined;
}

/**
 * What the endpoint's refusal of a request means for the token that carried it.
 *
 * @param status - The HTTP status the endpoint answered with.
 * @param body - The parsed response body, or `null` when it was not JSON.
 */
export function classifyCreditsRefusal(status: number, body: unknown): CreditsRefusalKind {
  const reason = refusalReasonOf(body);
  if (startsAccountHold(reason)) return 'account';
  if (reason !== undefined && TOKEN_REASONS.has(reason as InferenceRefusalReason)) return 'token';
  return status === 401 && reason === undefined ? 'token' : 'busy';
}

/**
 * The `code` of a problem envelope, or `null`. For a mint refusal the client
 * could not read as a known `Problem`.
 *
 * @param body - The parsed response body, or anything else.
 */
export function problemCodeOf(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null;
  const code = (body as { code?: unknown }).code;
  return typeof code === 'string' ? code : null;
}

/**
 * Whether a refused mint is a definite no, worth holding new mints for: a
 * `4xx` that is not a wait. Never an outage.
 *
 * @param status - The HTTP status the mint was answered with, or `null` for none.
 * @param code - The problem code it carried, if any.
 */
export function mintRefusalHolds(status: number | null, code: string | null): boolean {
  if (status === null || status < 400 || status >= 500) return false;
  if (WAIT_STATUSES.has(status)) return false;
  return code === null || !WAIT_CODES.has(code);
}
