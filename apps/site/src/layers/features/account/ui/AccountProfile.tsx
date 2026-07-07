'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { signOut } from '@/lib/auth-client';
import { Button, Card, CardContent, CardHeader, CardTitle } from '@/layers/shared/ui';

/** The subset of the DorkOS account the profile renders. */
export interface AccountUser {
  /** Display name. */
  name: string;
  /** Account email (the identity). */
  email: string;
  /** Whether the email has been verified. */
  emailVerified: boolean;
}

/** One labelled profile row. */
function ProfileRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1 border-b py-3 last:border-b-0 sm:flex-row sm:items-center sm:justify-between">
      <span className="text-muted-foreground text-sm">{label}</span>
      <span className="text-sm font-medium">{children}</span>
    </div>
  );
}

/**
 * Signed-in DorkOS account profile: name, email, verification status, and a
 * sign-out control. Session data is passed in by the server component that
 * guards the route, so this stays a pure client view over props.
 *
 * @param props.user - The signed-in account's display fields.
 */
export function AccountProfile({ user }: { user: AccountUser }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);

  async function onSignOut() {
    setPending(true);
    await signOut();
    router.push('/signin');
    router.refresh();
  }

  return (
    <Card className="w-full max-w-lg">
      <CardHeader>
        <CardTitle className="text-xl">Your DorkOS account</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="flex flex-col">
          <ProfileRow label="Name">{user.name}</ProfileRow>
          <ProfileRow label="Email">{user.email}</ProfileRow>
          <ProfileRow label="Email status">
            {user.emailVerified ? (
              <span className="text-emerald-600 dark:text-emerald-400">Verified</span>
            ) : (
              <span className="text-amber-600 dark:text-amber-400">Unverified</span>
            )}
          </ProfileRow>
        </div>
      </CardContent>
      <div className="flex justify-end">
        <Button variant="outline" onClick={onSignOut} disabled={pending}>
          {pending ? 'Signing out…' : 'Sign out'}
        </Button>
      </div>
    </Card>
  );
}
