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

import { getAuth } from '@/lib/auth';

/** The resolved session shape Better Auth returns (`{ user, session }`), or null. */
export type ServerSession = Awaited<ReturnType<ReturnType<typeof getAuth>['api']['getSession']>>;

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
