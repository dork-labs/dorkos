import type { Metadata } from 'next';

import { AccountProfile } from '@/layers/features/account';
import { requireServerSession } from '@/lib/auth-session';

export const metadata: Metadata = {
  title: 'Your account',
  description: 'Your DorkOS account profile.',
  robots: { index: false, follow: false },
};

/**
 * `/account` — the signed-in DorkOS account profile. The session is re-read here
 * (behind the segment guard) to render name, email, and verification status;
 * Better Auth's cookie cache keeps this off the database on hot paths.
 */
export default async function AccountPage() {
  const { user } = await requireServerSession('/account');
  return (
    <AccountProfile
      user={{
        name: user.name,
        email: user.email,
        emailVerified: user.emailVerified,
      }}
    />
  );
}
