/**
 * Runtime error classification — pure helpers that recognise when a runtime's
 * failure is an authentication/credential problem (an expired or revoked
 * sign-in) rather than a generic execution error.
 *
 * Every runtime funnels its terminal failures into a typed `error` event with a
 * free-form `message` and a `code`/subtype. The server's per-runtime mappers
 * call {@link describeRuntimeError} — {@link detectAuthError} plus the copy that
 * follows from it — to tag those events with the `auth_error` category, which
 * the chat UI turns into a friendly "sign in again" affordance instead of a raw
 * stack trace, and to replace the vendor's own words with one DorkOS sentence
 * that names the runtime a person has to sign back in to.
 *
 * Deliberately conservative: the patterns below are chosen to catch real
 * credential failures (revoked OAuth tokens, 401s, "failed to authenticate")
 * without misfiring on ordinary execution errors, rate limits, or network
 * timeouts. Environment-agnostic and pure — every input is passed in, so the
 * same code runs on the server and is exhaustively testable.
 *
 * @module runtime-error-classification
 */
import { runtimeDisplayName } from './agent-runtime.js';
import type { ErrorCategory } from './types.js';

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

/**
 * The ONE sentence DorkOS says when a runtime's sign-in has stopped working —
 * the single source of truth every runtime and every channel reads (DOR-1656).
 *
 * **Why one function rather than a string per call site.** A single expired
 * Claude Code sign-in used to reach people in two different voices depending on
 * which SDK channel reported it: the assistant-message channel said this
 * sentence, while the result channel forwarded the vendor's own text verbatim
 * ("Failed to authenticate: OAuth session expired and could not be refreshed" —
 * a literal from the CLI binary). Same failure, same session, two products
 * talking. Vendor internals are also the wrong thing to lead with: they name
 * the machinery, not what the person has to do about it.
 *
 * The raw text is not thrown away — callers demote it into the error event's
 * `details`, which the client keeps behind a "Details" disclosure so debugging
 * loses nothing.
 *
 * The runtime NAMES ITSELF: an OpenCode credential failure must not tell
 * somebody to re-authenticate Claude. The name comes from
 * {@link runtimeDisplayName}, so a runtime is called the same thing here as it
 * is everywhere else in the app.
 *
 * @param runtimeType - Runtime type identifier (e.g. `'claude-code'`).
 */
export function describeAuthError(runtimeType: string): string {
  return `Authentication failed. Re-authenticate ${runtimeDisplayName(runtimeType)} and try again.`;
}

/** The three error-event fields {@link describeRuntimeError} decides together. */
export interface RuntimeErrorCopy {
  /** What a person reads. */
  message: string;
  /** Which treatment the client gives it — `auth_error` earns "Fix sign-in". */
  category: ErrorCategory;
  /** The backend's own words, present only when they were replaced above. */
  details?: string;
}

/**
 * What one backend failure should say and be categorised as, decided in one
 * place so every runtime's every error channel answers the same way (DOR-1656).
 *
 * Two outcomes, and the split is the whole point:
 *
 * - **A credential failure** ({@link detectAuthError}) is TRANSLATED. The person
 *   gets {@link describeAuthError}'s sentence naming this runtime, and the
 *   backend's words move to `details`, where the client keeps them behind a
 *   "Details" disclosure. Nothing is deleted; the lead is just the thing they
 *   can act on.
 * - **Everything else** is passed through verbatim as an `execution_error`, with
 *   NO `details`. The backend's message is the only account of what went wrong,
 *   there is no remedy to offer in its place, and copying it into `details` would
 *   only add a disclosure repeating the sentence above it.
 *
 * A runtime whose non-auth failures need a richer category (claude-code's result
 * subtypes map to `max_turns`, `budget_exceeded` and friends) classifies those
 * itself and reaches for {@link describeAuthError} directly.
 *
 * @param input - The runtime reporting the failure, and what its backend said.
 */
export function describeRuntimeError(input: {
  /** Runtime type identifier (e.g. `'codex'`) — the name the copy will use. */
  runtimeType: string;
  /** The backend's own failure text. */
  message: string;
  /** The backend's machine code/subtype for the failure, when it carried one. */
  code?: string | null;
}): RuntimeErrorCopy {
  const { runtimeType, message, code } = input;
  if (!detectAuthError({ message, code })) return { message, category: 'execution_error' };
  return {
    message: describeAuthError(runtimeType),
    category: 'auth_error',
    details: message,
  };
}
