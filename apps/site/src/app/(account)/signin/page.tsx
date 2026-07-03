import type { Metadata } from 'next';

import { SignInForm } from '@/layers/features/account';

export const metadata: Metadata = {
  title: 'Sign in',
  description: 'Sign in to your DorkOS account.',
  robots: { index: false, follow: false },
};

/**
 * `/signin` — sign in to a DorkOS account. `returnTo` (set by the `/account`
 * guard) is read server-side and passed to the form for a safe post-sign-in
 * redirect.
 */
export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ returnTo?: string }>;
}) {
  const { returnTo } = await searchParams;
  return <SignInForm returnTo={returnTo} />;
}
