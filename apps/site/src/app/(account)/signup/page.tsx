import type { Metadata } from 'next';

import { SignUpForm } from '@/layers/features/account';

export const metadata: Metadata = {
  title: 'Create your account',
  description: 'Create a DorkOS account.',
  robots: { index: false, follow: false },
};

/** `/signup` — create a new DorkOS account. */
export default function SignUpPage() {
  return <SignUpForm />;
}
