import type { Metadata } from 'next';

import { RequestPasswordResetForm } from '@/layers/features/account';

export const metadata: Metadata = {
  title: 'Reset your password',
  description: 'Request a DorkOS account password reset.',
  robots: { index: false, follow: false },
};

/** `/reset-password` — request a password-reset link. */
export default function ResetPasswordPage() {
  return <RequestPasswordResetForm />;
}
