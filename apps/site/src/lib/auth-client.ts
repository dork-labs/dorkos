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
import { adminClient } from 'better-auth/client/plugins';

import type { PendingInstanceView } from '@/lib/instance-types';

/**
 * The DorkOS account Better Auth client (same-origin, base path `/api/auth`).
 *
 * The `adminClient` plugin mirrors the server `admin` plugin so a future
 * `/admin` console can call `authClient.admin.*` (ban, impersonate, list, …)
 * against the same typed surface; a single `admin` role gates every operation.
 */
export const authClient = createAuthClient({
  plugins: [adminClient()],
});

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
 * Request permanent deletion of the signed-in DorkOS account (GDPR/CCPA
 * erasure). Because the server enables delete-account verification, this sends a
 * confirmation email; the account is erased only after the user follows the
 * one-time link (a hijacked session cannot silently delete). Deletion cascades
 * to sessions, sign-in methods, API keys, and linked instances.
 *
 * @param args.callbackURL - Where the confirmation link lands after erasure.
 */
export function requestAccountDeletion(args: { callbackURL: string }) {
  return authClient.deleteUser({ callbackURL: args.callbackURL });
}

// --- Admin actions (cloud-account-management, DOR-193) -------------------------
// The `/admin` console reaches the Better Auth `admin` plugin only through these
// wrappers, so no component imports `better-auth`. Each is same-origin and rides
// the admin's session cookie; the server gates every call on `role=admin` /
// `ADMIN_USER_IDS`. Each returns the Better Auth `{ data, error }` result.

/** Set a user's role (e.g. promote to `admin` or demote to `user`). */
export function adminSetRole(args: { userId: string; role: 'admin' | 'user' }) {
  return authClient.admin.setRole({ userId: args.userId, role: args.role });
}

/**
 * Ban a user — revokes their sessions immediately; our server hook also disables
 * their API keys so linked instances 401 on the next heartbeat.
 *
 * @param args.banReason - Optional reason (stored + audited).
 * @param args.banExpiresIn - Optional seconds until the ban lifts (omit = permanent).
 */
export function adminBanUser(args: { userId: string; banReason?: string; banExpiresIn?: number }) {
  return authClient.admin.banUser({
    userId: args.userId,
    ...(args.banReason ? { banReason: args.banReason } : {}),
    ...(args.banExpiresIn ? { banExpiresIn: args.banExpiresIn } : {}),
  });
}

/** Lift a user's ban. */
export function adminUnbanUser(args: { userId: string }) {
  return authClient.admin.unbanUser({ userId: args.userId });
}

/** Revoke every session for a user (forces re-login everywhere). */
export function adminRevokeUserSessions(args: { userId: string }) {
  return authClient.admin.revokeUserSessions({ userId: args.userId });
}

/**
 * Start impersonating a user: mints a capped session as that user in the current
 * browser. Every use is audited and the session is stamped `impersonatedBy`.
 */
export function adminImpersonateUser(args: { userId: string }) {
  return authClient.admin.impersonateUser({ userId: args.userId });
}

/** Stop impersonating and restore the admin's own session. */
export function adminStopImpersonating() {
  return authClient.admin.stopImpersonating();
}

/** Hard-delete a user (irreversible; cascades sessions/accounts/keys/instances). */
export function adminRemoveUser(args: { userId: string }) {
  return authClient.admin.removeUser({ userId: args.userId });
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
