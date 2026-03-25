/**
 * Augments the cookie-session CookieSessionObject with DorkOS-specific fields.
 * This gives typed access to `req.session.tunnelAuthenticated` without relying
 * on the permissive index signature.
 */
declare namespace CookieSessionInterfaces {
  interface CookieSessionObject {
    /** Whether the user has verified the tunnel passcode for this session. */
    tunnelAuthenticated?: boolean;
  }
}
