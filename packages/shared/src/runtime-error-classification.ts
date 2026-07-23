/**
 * Runtime error classification — pure helpers that recognise when a runtime's
 * failure is an authentication/credential problem (an expired or revoked
 * sign-in) rather than a generic execution error.
 *
 * Every runtime funnels its terminal failures into a typed `error` event with a
 * free-form `message` and a `code`/subtype. The server's per-runtime mappers
 * call {@link detectAuthError} to tag those events with the `auth_error`
 * category, which the chat UI turns into a friendly "sign in again" affordance
 * instead of a raw stack trace.
 *
 * Deliberately conservative: the patterns below are chosen to catch real
 * credential failures (revoked OAuth tokens, 401s, "failed to authenticate")
 * without misfiring on ordinary execution errors, rate limits, or network
 * timeouts. Environment-agnostic and pure — every input is passed in, so the
 * same code runs on the server and is exhaustively testable.
 *
 * @module runtime-error-classification
 */

/**
 * Exact runtime error `code`/subtype values that unambiguously mean an
 * authentication failure, regardless of the human message text. These are the
 * real names each SDK emits:
 * - claude-code assistant errors: `authentication_failed`, `oauth_org_not_allowed`
 * - opencode `session.error`: `ProviderAuthError` (a provider credential failure
 *   whose `data.message` can be generic, so the name is the reliable signal)
 */
export const AUTH_ERROR_SUBTYPES: ReadonlySet<string> = new Set([
  'authentication_failed',
  'oauth_org_not_allowed',
  'ProviderAuthError',
]);

/**
 * Credential nouns that, when sitting next to "expired", mean an auth failure.
 * Kept specific (not bare `token`/`key`) so ordinary token/key/quota-expiry
 * messages ("token budget expired", "object key", "press any key") don't match.
 */
const EXPIRABLE_CREDENTIAL =
  '(?:credential|api[_ ]?key|(?:auth|access|oauth|session|refresh|bearer)[_ ]?token)';

/**
 * Case-insensitive signals in a runtime error message that indicate an
 * authentication or credential failure. Kept conservative to avoid false
 * positives on ordinary execution errors, line numbers, and amounts.
 */
const AUTH_MESSAGE_PATTERNS: readonly RegExp[] = [
  /oauth/i,
  /unauthoris|unauthoriz/i, // unauthorized / unauthorised (covers "401 Unauthorized")
  /revoked/i,
  /authenticat/i, // authenticate / authentication / failed to authenticate
  /access token/i,
  /invalid[_ ]?api[_ ]?key/i,
  // "expired" is too broad on its own (sessions, links, trials, token budgets),
  // so require a specific credential noun within a short, same-line window.
  new RegExp(`${EXPIRABLE_CREDENTIAL}[^\\n]{0,20}\\bexpired\\b`, 'i'),
  new RegExp(`\\bexpired\\b[^\\n]{0,20}${EXPIRABLE_CREDENTIAL}`, 'i'),
];

/**
 * True when a runtime error's message or code signals an authentication or
 * credential failure (an expired/revoked sign-in), rather than a generic
 * execution error. Matching is case-insensitive and conservative.
 *
 * @param input - The runtime error's human `message` and machine `code`/subtype.
 */
export function detectAuthError(input: { message?: string | null; code?: string | null }): boolean {
  const { message, code } = input;

  if (code && AUTH_ERROR_SUBTYPES.has(code)) return true;

  const haystack = `${message ?? ''}\n${code ?? ''}`;
  if (haystack.trim().length === 0) return false;

  return AUTH_MESSAGE_PATTERNS.some((pattern) => pattern.test(haystack));
}
