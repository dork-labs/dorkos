/**
 * Sanitizes a `returnTo` redirect target from an untrusted query param.
 *
 * Only same-origin absolute paths are honored; anything else (an absolute URL,
 * a protocol-relative `//host`, or a missing value) falls back to `/account`.
 * This is the open-redirect guard for the sign-in flow.
 *
 * @module features/account/lib/redirect-target
 */

/** Where a signed-in visitor lands when no safe `returnTo` was supplied. */
export const DEFAULT_RETURN_TO = '/account';

/**
 * Resolve a safe in-app redirect path from an untrusted `returnTo` value.
 *
 * @param returnTo - The raw `returnTo` query param, if any.
 * @returns A same-origin path beginning with a single `/`, else `/account`.
 */
export function safeReturnTo(returnTo: string | null | undefined): string {
  if (!returnTo) return DEFAULT_RETURN_TO;
  // Reject protocol-relative (`//evil.com`) and absolute-URL targets.
  if (!returnTo.startsWith('/') || returnTo.startsWith('//')) return DEFAULT_RETURN_TO;
  return returnTo;
}
