/**
 * Signing in on a shared or public computer (A4, DOR-2936).
 *
 * A person who signs in on a computer that is not theirs asks for it on the
 * sign-in screen. The browser carries that ask to the server in a short-lived
 * cookie ({@link PUBLIC_COMPUTER_MARKER}), and the session it makes is marked
 * `publicComputer`:
 *
 * - its cookie has no expiry, so it ends when the browser closes;
 * - it cannot outlive {@link PUBLIC_COMPUTER_LIFETIME_MS}, and is never
 *   renewed: Better Auth skips renewal for a session signed in this way, and
 *   the session gate refuses one older than that whatever its expiry says;
 * - the app signs it out after {@link PUBLIC_COMPUTER_IDLE_MS} with nobody
 *   using it.
 *
 * @module services/core/hub/public-computer
 */

/**
 * The cookie the sign-in screen sets when a person asks for it. `__Host-`, so
 * no other site under the same domain can set it for them.
 */
export const PUBLIC_COMPUTER_MARKER = '__Host-dorkos-public-computer';

/** The longest a public-computer session lasts: one working day. */
export const PUBLIC_COMPUTER_LIFETIME_MS = 12 * 60 * 60 * 1000;

/** How long a public-computer session may sit idle before the app signs it out. */
export const PUBLIC_COMPUTER_IDLE_MS = 30 * 60 * 1000;

/**
 * Whether a request's cookies ask for a public-computer sign-in.
 *
 * @param cookieHeader - The request's `Cookie` header.
 */
export function asksForPublicComputer(cookieHeader: string | null | undefined): boolean {
  return (cookieHeader ?? '')
    .split(';')
    .some((part) => part.trim() === `${PUBLIC_COMPUTER_MARKER}=1`);
}

/**
 * Whether a session signed in on a public computer has outlived its day.
 *
 * @param session - The session, as Better Auth reads it.
 * @param now - The current time, for tests.
 */
export function publicComputerSessionExpired(
  session: { publicComputer?: unknown; createdAt: Date | string },
  now = Date.now()
): boolean {
  if (session.publicComputer !== true) return false;
  return now - new Date(session.createdAt).getTime() > PUBLIC_COMPUTER_LIFETIME_MS;
}
