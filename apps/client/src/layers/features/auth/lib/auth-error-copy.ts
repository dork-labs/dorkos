/**
 * Turns an auth failure into a sentence a person can act on.
 *
 * The auth layer answers in its own vocabulary: `Invalid origin`, `Missing or
 * null Origin`. Rendered straight into a form, those read as a dead end. Two
 * words tell a person nothing about what happened, whether anything was saved,
 * or what to do next. DOR-1744 is the case that made this worth having: the
 * desktop app in development could load every screen and then answer the
 * owner-setup dialog with `Invalid origin`, which blocked Remote Access setup
 * with no way to guess why.
 *
 * The raw string is never thrown away. It comes back as {@link AuthErrorCopy.detail}
 * so the screen can show it beneath the sentence: the person gets the plain
 * meaning, and whoever they paste it to gets the exact wording.
 *
 * @module features/auth/lib/auth-error-copy
 */
import type { AuthError } from '../model/auth-client';

/** A human sentence for an auth failure, plus the auth layer's own wording. */
export interface AuthErrorCopy {
  /** What happened and what to do, in plain language. */
  message: string;
  /** The auth layer's own words, for the small print. `null` when the sentence already is them. */
  detail: string | null;
}

/**
 * The server refused the request because it does not recognise the address the
 * app is served from. Naming the address is most of the fix, so it goes in the
 * sentence whenever the caller knows it.
 *
 * @param appOrigin - Where this app is served from (`window.location.origin`).
 */
function mismatchedOriginMessage(appOrigin: string | undefined): string {
  const address = appOrigin ?? "this app's address";
  return (
    'The app and the server disagree about where this request came from, so the server ' +
    `turned it down and nothing changed. To fix it, add ${address} to the server's ` +
    'DORKOS_CORS_ORIGIN setting and restart it.'
  );
}

/**
 * Describe an auth failure in plain language.
 *
 * Anything this does not recognise passes through unchanged, so a message the
 * server already wrote for people (a closed registration, a wrong password)
 * still reaches them in the server's words rather than being flattened into
 * something vaguer.
 *
 * @param error - The failure from a sign-in, sign-up or sign-out call, or
 *   `null`/`undefined` when the last attempt did not fail.
 * @param appOrigin - Where this app is served from, normally
 *   `window.location.origin`. Only used for the origin-mismatch case, and
 *   optional so this stays a pure function.
 * @returns The copy to render, or `null` when there is nothing to say.
 */
export function describeAuthError(
  error: AuthError | null | undefined,
  appOrigin?: string
): AuthErrorCopy | null {
  if (!error) return null;

  // The server refuses a login from an address it was not told to trust. Its own
  // words are `Invalid origin`; the code is matched first because the wording is
  // the auth library's to change, and the message second so a version that
  // renames the code still lands here.
  if (error.code === 'INVALID_ORIGIN' || error.message === 'Invalid origin') {
    return { message: mismatchedOriginMessage(appOrigin), detail: error.message };
  }

  // The same wall, reached from a page the browser gives no address at all: a
  // sandboxed frame, or a page opened from a file.
  if (error.code === 'MISSING_OR_NULL_ORIGIN' || error.message === 'Missing or null Origin') {
    return {
      message:
        'The app did not tell the server where this request came from, so the server turned ' +
        'it down and nothing changed. Open DorkOS in its own window or tab and try again.',
      detail: error.message,
    };
  }

  // Better Auth rate-limits the credential endpoints. `retryAfter` is the header
  // it sends with the refusal, so either signal alone means the same thing.
  if (error.status === 429 || error.retryAfter !== undefined) {
    return {
      message: `Too many attempts. Try again${
        error.retryAfter ? ` in ${error.retryAfter}s` : ' in a little while'
      }.`,
      detail: null,
    };
  }

  return { message: error.message, detail: null };
}
