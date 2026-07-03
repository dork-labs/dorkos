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
  // Must be a rooted, non-protocol-relative path.
  if (!returnTo.startsWith('/') || returnTo.startsWith('//')) return DEFAULT_RETURN_TO;
  // Reject backslashes and control chars: the WHATWG URL parser treats `\` as
  // `/` and strips tab/newline, so `/\evil.com` (or `/\t/evil.com`) would resolve
  // cross-origin despite starting with a single `/`.
  if (/[\\\t\n\r]/.test(returnTo)) return DEFAULT_RETURN_TO;
  // Defense in depth: resolve against a sentinel origin and confirm the target
  // stays on it, so any residual cross-origin trick falls back to the default.
  try {
    const resolved = new URL(returnTo, 'https://dorkos.invalid');
    if (resolved.origin !== 'https://dorkos.invalid') return DEFAULT_RETURN_TO;
    return resolved.pathname + resolved.search + resolved.hash;
  } catch {
    return DEFAULT_RETURN_TO;
  }
}
