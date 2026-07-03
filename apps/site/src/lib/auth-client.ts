/**
 * The single Better Auth **client** wrapper for the DorkOS account UI
 * (accounts-and-auth P2).
 *
 * Every account page and form talks to Better Auth through this module — no
 * component imports `better-auth/react` directly. Centralizing it here keeps the
 * one client instance, the one base path, and the typed action surface in a
 * single place the rest of `app/(account)` composes over.
 *
 * The client is same-origin: `baseURL` is omitted so it resolves to the current
 * origin at request time (the site serves both these pages and the
 * `/api/auth/*` route handler), which avoids threading a public origin through
 * `NEXT_PUBLIC_*` env. The default base path (`/api/auth`) matches the handler.
 *
 * @module lib/auth-client
 */
import { createAuthClient } from 'better-auth/react';

/** The DorkOS account Better Auth client (same-origin, base path `/api/auth`). */
export const authClient = createAuthClient();

/** The social identity providers offered at launch. */
export type SocialProvider = 'github' | 'google';

/**
 * React hook exposing the current DorkOS account session
 * (`{ data, isPending, error, refetch }`). Re-exported so components never reach
 * into `better-auth/react`.
 */
export const useSession = authClient.useSession;

/**
 * Sign in with an email and password.
 *
 * @param args - Credentials plus an optional post-sign-in redirect target.
 */
export function signInEmail(args: { email: string; password: string; callbackURL?: string }) {
  return authClient.signIn.email(args);
}

/**
 * Start an OAuth sign-in with a social provider (GitHub or Google).
 *
 * @param args - The provider and where to land after the OAuth round-trip.
 */
export function signInSocial(args: { provider: SocialProvider; callbackURL?: string }) {
  return authClient.signIn.social(args);
}

/**
 * Create a DorkOS account with an email, password, and display name. Triggers
 * the verification email (email/password sign-up requires a verified email
 * before a session is issued).
 *
 * @param args - The new account's details plus an optional post-verification
 *   redirect target.
 */
export function signUpEmail(args: {
  email: string;
  password: string;
  name: string;
  callbackURL?: string;
}) {
  return authClient.signUp.email(args);
}

/** Sign the current DorkOS account out, clearing its session cookie. */
export function signOut() {
  return authClient.signOut();
}

/**
 * Request a password-reset email. Always resolves without revealing whether the
 * address has an account (the caller shows generic copy).
 *
 * @param args - The account email and the page the reset link should land on.
 */
export function requestPasswordReset(args: { email: string; redirectTo: string }) {
  return authClient.requestPasswordReset(args);
}

/**
 * Set a new password using the one-time token from a reset-link.
 *
 * @param args - The new password and the token carried by the reset link.
 */
export function resetPassword(args: { newPassword: string; token: string }) {
  return authClient.resetPassword(args);
}

/**
 * Confirm an email address using the one-time token from a verification link.
 *
 * @param token - The verification token carried by the link.
 */
export function verifyEmail(token: string) {
  return authClient.verifyEmail({ query: { token } });
}
