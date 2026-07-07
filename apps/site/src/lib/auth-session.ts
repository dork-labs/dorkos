/**
 * Server-side DorkOS account session helpers (accounts-and-auth P2).
 *
 * These run in Server Components / route handlers and read the session straight
 * from the production Better Auth instance ({@link getAuth}) using the request's
 * cookies. They are the request-time guard behind `/account`: an unauthenticated
 * visit is redirected to `/signin` carrying a `returnTo` so sign-in can send the
 * visitor back where they were headed.
 *
 * @module lib/auth-session
 */
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';

import { env } from '@/env';
import { getAuth } from '@/lib/auth';

/** The resolved session shape Better Auth returns (`{ user, session }`), or null. */
export type ServerSession = Awaited<ReturnType<ReturnType<typeof getAuth>['api']['getSession']>>;

/**
 * Whether the signed-in user is an admin: either the Better Auth `admin` plugin
 * role is `admin`, or their id is in the `ADMIN_USER_IDS` break-glass allowlist
 * (the same two mechanisms the server plugin trusts). Reads `role` defensively
 * because it is an `admin`-plugin-added field.
 *
 * @param session - A resolved server session (or null).
 */
export function isAdminSession(session: ServerSession): boolean {
  if (!session) return false;
  const role = (session.user as { role?: string | null }).role;
  return role === 'admin' || env.ADMIN_USER_IDS.includes(session.user.id);
}

/**
 * Read the current DorkOS account session from the incoming request cookies.
 * Returns `null` when there is no valid session (the caller decides how to
 * react). The Better Auth instance is only touched here at request time, never
 * at build time.
 */
export async function getServerSession(): Promise<ServerSession> {
  return getAuth().api.getSession({ headers: await headers() });
}

/**
 * Require a signed-in DorkOS account. Redirects to `/signin?returnTo=<path>`
 * when there is no session; otherwise returns the resolved session.
 *
 * @param returnTo - The path to send the visitor back to after they sign in.
 */
export async function requireServerSession(returnTo: string): Promise<NonNullable<ServerSession>> {
  const session = await getServerSession();
  if (!session) {
    redirect(`/signin?returnTo=${encodeURIComponent(returnTo)}`);
  }
  return session;
}

/**
 * Require an **admin** session for `/admin`. Redirects to sign-in when there is
 * no session, and to `/account` (not a 403 page) when the signed-in user is not
 * an admin, so the admin surface is never even acknowledged to a non-admin. The
 * server-side gate is the real access control; `noindex` + the client only
 * hides it.
 *
 * @param returnTo - Where to send the visitor back to after they sign in.
 */
export async function requireAdminSession(returnTo: string): Promise<NonNullable<ServerSession>> {
  const session = await getServerSession();
  if (!session) {
    redirect(`/signin?returnTo=${encodeURIComponent(returnTo)}`);
  }
  if (!isAdminSession(session)) {
    redirect('/account');
  }
  return session;
}
