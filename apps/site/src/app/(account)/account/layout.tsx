import { requireServerSession } from '@/lib/auth-session';

/**
 * Always render at request time. `/account` reads the session from the live
 * Better Auth instance, so it must never be statically prerendered at build
 * (which would evaluate the production-config guard without secrets present).
 */
export const dynamic = 'force-dynamic';

/**
 * Guard for every `/account/*` route. Runs a request-time session check and
 * redirects unauthenticated visitors to `/signin?returnTo=/account`; signed-in
 * visitors fall through to the page. Protects future account sub-pages (the
 * instance registry in a later task) by covering the whole segment.
 */
export default async function AccountGuardLayout({ children }: { children: React.ReactNode }) {
  await requireServerSession('/account');
  return <>{children}</>;
}
