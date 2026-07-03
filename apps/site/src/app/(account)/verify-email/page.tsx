import type { Metadata } from 'next';

import { VerifyEmailCard } from '@/layers/features/account';

export const metadata: Metadata = {
  title: 'Verify your email',
  description: 'Confirm your DorkOS account email.',
  robots: { index: false, follow: false },
};

/**
 * `/verify-email` — the verification link's landing page. Reads the `token` (or
 * an `error` from a failed server-side verify) and reports success or failure.
 */
export default async function VerifyEmailPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string; error?: string }>;
}) {
  const { token, error } = await searchParams;
  return <VerifyEmailCard token={token} errorParam={error} />;
}
