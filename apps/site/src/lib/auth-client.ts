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

import type { PendingInstanceView } from '@/lib/instance-types';

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

// --- Device linking (accounts-and-auth P2, task 2.3) ---------------------------
// The `/activate` and `/account/instances` UI reach the device-flow and instance
// endpoints only through these wrappers, so no component imports `better-auth` or
// hard-codes a path. Same-origin `fetch`/`$fetch` calls carry the session cookie.

/**
 * Approve a device authorization by its user code (the signed-in account must
 * have claimed the code first via {@link fetchPendingInstance}). Resolves to the
 * Better Auth `{ data, error }` result.
 *
 * @param userCode - The 8-character user code shown by the instance.
 */
export function approveDevice(userCode: string) {
  return authClient.$fetch('/device/approve', { method: 'POST', body: { userCode } });
}

/**
 * Deny a device authorization by its user code.
 *
 * @param userCode - The 8-character user code shown by the instance.
 */
export function denyDevice(userCode: string) {
  return authClient.$fetch('/device/deny', { method: 'POST', body: { userCode } });
}

/**
 * Look up (and claim, for the signed-in account) a device user code, returning
 * the requesting instance's descriptor and status for the `/activate` screen.
 *
 * @param userCode - The user code entered at `/activate`.
 * @throws Error when the lookup request fails (e.g. the session expired).
 */
export async function fetchPendingInstance(userCode: string): Promise<PendingInstanceView> {
  // POST, not GET: resolving a code claims it for the signed-in account (a state
  // change), so it must not be prefetch/crawler-triggerable.
  const res = await fetch('/api/instances/pending', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ user_code: userCode }),
  });
  if (!res.ok) throw new Error(`Failed to look up the code (${res.status}).`);
  return (await res.json()) as PendingInstanceView;
}

/**
 * Revoke (unlink) one of the signed-in account's instances.
 *
 * @param instanceId - The instance to revoke.
 * @throws Error when the revoke request fails.
 */
export async function revokeInstanceLink(instanceId: string): Promise<void> {
  const res = await fetch('/api/instances/revoke', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ instanceId }),
  });
  if (!res.ok) throw new Error(`Failed to revoke the instance (${res.status}).`);
}
