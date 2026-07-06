import type { Metadata } from 'next';

import { ActivatePanel } from '@/layers/features/instances';
import { requireServerSession } from '@/lib/auth-session';

export const metadata: Metadata = {
  title: 'Link an instance',
  description: 'Approve a DorkOS instance linking to your account.',
  robots: { index: false, follow: false },
};

/**
 * Always render at request time. `/activate` reads the live Better Auth session
 * to guard access and claim the device code, so it must never be statically
 * prerendered (which would evaluate the production-config guard without secrets).
 */
export const dynamic = 'force-dynamic';

/**
 * `/activate` — approve or deny a DorkOS instance's device-link request. Requires
 * a signed-in DorkOS account; unauthenticated visitors are redirected to
 * `/signin` and returned here (with the code preserved) after signing in. The
 * user code pre-fills from `?code=` (or `?user_code=` from the complete
 * verification URI).
 */
export default async function ActivatePage({
  searchParams,
}: {
  searchParams: Promise<{ code?: string; user_code?: string }>;
}) {
  const params = await searchParams;
  const initialCode = params.code ?? params.user_code;
  const returnTo = initialCode ? `/activate?code=${encodeURIComponent(initialCode)}` : '/activate';
  await requireServerSession(returnTo);
  return <ActivatePanel initialCode={initialCode} />;
}
