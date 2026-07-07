import type { Metadata } from 'next';

import { ResetPasswordForm } from '@/layers/features/account';

export const metadata: Metadata = {
  title: 'Choose a new password',
  description: 'Set a new password for your DorkOS account.',
  robots: { index: false, follow: false },
};

/**
 * `/reset-password/confirm` — the reset link's landing page. Reads the one-time
 * `token` and lets the visitor set a new password.
 */
export default async function ResetPasswordConfirmPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const { token } = await searchParams;
  return <ResetPasswordForm token={token} />;
}
