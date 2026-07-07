/**
 * Maps Better Auth client errors to DorkOS account UI copy.
 *
 * Better Auth client actions resolve to `{ data, error }` rather than throwing;
 * `error` carries an HTTP `status` and an optional `message`. This module turns
 * that into a single human sentence, with dedicated, honest wording for the
 * rate-limit case (429) so a throttled sign-in tells the visitor to wait rather
 * than showing a raw error.
 *
 * @module features/account/lib/auth-errors
 */

/** The error shape Better Auth client actions return in their `error` field. */
export interface AuthActionError {
  /** HTTP status of the failed request. */
  status: number;
  /** Server-provided message, when present. */
  message?: string;
}

/** Copy shown when the request is rate-limited (HTTP 429). */
export const RATE_LIMIT_MESSAGE = 'Too many attempts. Please wait a moment before trying again.';

/** Fallback copy when the server returns no specific message. */
const GENERIC_MESSAGE = 'Something went wrong. Please try again.';

/**
 * Resolve a display message for a Better Auth client error.
 *
 * @param error - The `error` object from a client action result, or null.
 * @returns A single sentence to render, or `null` when there is no error.
 */
export function authErrorMessage(error: AuthActionError | null | undefined): string | null {
  if (!error) return null;
  if (error.status === 429) return RATE_LIMIT_MESSAGE;
  return error.message?.trim() || GENERIC_MESSAGE;
}
