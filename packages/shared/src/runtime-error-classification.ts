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
import { runtimeAuthConnectKind, runtimeDisplayName } from './agent-runtime.js';
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
 * The message signals strong enough to act on when the failure might not be
 * about the SESSION's own sign-in at all.
 *
 * A runtime's TERMINAL failure is always about the session, so the broader set
 * below is safe there. Some channels are not terminal: codex reports per-tool
 * diagnostics on the same `error` item it reports a dying sign-in on, and a
 * tool's own credential trouble ("Failed to authenticate with server github")
 * would match `/authenticat/i` while the session's sign-in is perfectly fine.
 * Telling somebody to sign in again over a live turn's real error is a worse
 * failure than saying nothing, so those channels ask for these two instead.
 *
 * No message pattern is airtight on a diagnostic channel — a tool CAN return
 * "401 Unauthorized" from a third-party call. This set is the narrowest one
 * that still recognises the failure codex actually reports there, and the trade
 * is deliberate: under-translate rather than over-translate.
 */
const UNAMBIGUOUS_AUTH_MESSAGE_PATTERNS: readonly RegExp[] = [
  /unauthoris|unauthoriz/i, // unauthorized / unauthorised (covers "401 Unauthorized")
  /revoked/i,
];

/**
 * Case-insensitive signals in a runtime error message that indicate an
 * authentication or credential failure. Kept conservative to avoid false
 * positives on ordinary execution errors, line numbers, and amounts.
 */
const AUTH_MESSAGE_PATTERNS: readonly RegExp[] = [
  ...UNAMBIGUOUS_AUTH_MESSAGE_PATTERNS,
  /oauth/i,
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
 * @param input - The runtime error's human `message` and machine `code`/subtype,
 *   plus how sure the caller needs to be.
 */
export function detectAuthError(input: {
  /** The runtime error's human text, if it carried any. */
  message?: string | null;
  /** The runtime error's machine code/subtype, if it carried one. */
  code?: string | null;
  /**
   * Match message text only on {@link UNAMBIGUOUS_AUTH_MESSAGE_PATTERNS}. Set it
   * on channels that also carry failures about something OTHER than the
   * session's own sign-in (codex's per-item diagnostics), where a false positive
   * stamps sign-in advice over a live turn's real error. Exact `code` matches
   * are unaffected: a code from {@link AUTH_ERROR_SUBTYPES} names a credential
   * failure outright and needs no corroboration.
   */
  unambiguousOnly?: boolean;
}): boolean {
  const { message, code, unambiguousOnly = false } = input;

  if (code && AUTH_ERROR_SUBTYPES.has(code)) return true;

  const haystack = `${message ?? ''}\n${code ?? ''}`;
  if (haystack.trim().length === 0) return false;

  const patterns = unambiguousOnly ? UNAMBIGUOUS_AUTH_MESSAGE_PATTERNS : AUTH_MESSAGE_PATTERNS;
  return patterns.some((pattern) => pattern.test(haystack));
}

/**
 * The ONE sentence DorkOS says when a runtime's sign-in has stopped working —
 * the single source of truth every runtime and every channel reads (DOR-1656).
 *
 * **Why one function rather than a string per call site.** A single expired
 * Claude Code sign-in used to reach people in two different voices depending on
 * which SDK channel reported it: the assistant-message channel said DorkOS's own
 * sentence, while the result channel forwarded the vendor's text verbatim
 * ("Failed to authenticate: OAuth session expired and could not be refreshed" —
 * a literal from the CLI binary). Same failure, same session, two products
 * talking. Vendor internals are also the wrong thing to lead with: they name
 * the machinery, not what the person has to do about it.
 *
 * The raw text is not thrown away — callers demote it into the error event's
 * `details`, which the client keeps behind a "Details" disclosure so debugging
 * loses nothing.
 *
 * **The runtime names ITSELF, and names the right remedy.** An OpenCode failure
 * must not tell somebody to sign in to Claude — and it must not tell them to
 * "sign in to OpenCode" either, because OpenCode has no single sign-in: it
 * borrows a MODEL PROVIDER's credential, which is why reconnecting it opens the
 * provider picker rather than a login ({@link runtimeAuthConnectKind}). So the
 * sentence follows the connect kind, and its closing instruction matches the
 * button a person will actually be looking for ("Sign in again" / "Choose a
 * model provider"). The name comes from {@link runtimeDisplayName}, so a runtime
 * is called the same thing here as everywhere else in the app.
 *
 * **Where this actually renders, so you do not chase it.** The chat panel does
 * NOT paint this string: `ErrorMessageBlock` renders an `auth_error`'s own
 * heading and subtext and falls back to the event's `message` only when no
 * category is set. So this is the sentence every OTHER reader gets — an
 * uncategorized surface, a transcript, a notification, an API consumer — and the
 * one the panel would fall back to if its category copy ever went away. Editing
 * it will not change what the chat panel shows; that copy lives in the client.
 *
 * @param runtimeType - Runtime type identifier (e.g. `'claude-code'`).
 */
export function describeAuthError(runtimeType: string): string {
  const name = runtimeDisplayName(runtimeType);
  if (runtimeAuthConnectKind(runtimeType) === 'provider-picker') {
    return `${name}'s model provider stopped accepting its sign-in. Choose a model provider to keep going.`;
  }
  return `Your ${name} sign-in stopped working. Sign in again to keep going.`;
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
  /** Passed to {@link detectAuthError}; see that option for when to set it. */
  unambiguousOnly?: boolean;
}): RuntimeErrorCopy {
  const { runtimeType, message, code, unambiguousOnly = false } = input;
  if (!detectAuthError({ message, code, unambiguousOnly })) {
    return { message, category: 'execution_error' };
  }
  return {
    message: describeAuthError(runtimeType),
    category: 'auth_error',
    details: message,
  };
}
