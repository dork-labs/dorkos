import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';

import { AccountProfile, DangerZone } from '@/layers/features/account';
import { getServerSession, isAdminSession } from '@/lib/auth-session';

export const metadata: Metadata = {
  title: 'Your account',
  description: 'Your DorkOS account profile.',
  robots: { index: false, follow: false },
};

/**
 * `/account` — the signed-in DorkOS account profile. The session is re-read here
 * (behind the segment guard) to render name, email, and verification status;
 * Better Auth's cookie cache keeps this off the database on hot paths. Admins
 * also get a link into the `/admin` console.
 */
export default async function AccountPage() {
  const session = await getServerSession();
  if (!session) redirect('/signin?returnTo=%2Faccount');
  const { user } = session;
  return (
    <div className="flex w-full flex-col items-center gap-6">
      <AccountProfile
        user={{
          name: user.name,
          email: user.email,
          emailVerified: user.emailVerified,
        }}
      />
      {isAdminSession(session) ? (
        <Link
          href="/admin"
          className="text-muted-foreground hover:text-foreground text-sm underline underline-offset-4"
        >
          Open the admin console →
        </Link>
      ) : null}
      <DangerZone email={user.email} />
    </div>
  );
}
