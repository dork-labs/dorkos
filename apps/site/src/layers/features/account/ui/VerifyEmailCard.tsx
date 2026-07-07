'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';

import { verifyEmail } from '@/lib/auth-client';
import { Button } from '@/layers/shared/ui';

import { AuthShell } from './AuthShell';

/** The three states of the verification landing page. */
type VerifyStatus = 'verifying' | 'success' | 'error';

/**
 * Pick the initial status from the link's query params. A `token` means we
 * confirm it client-side; an `error` (Better Auth redirected here after a failed
 * server-side verification) is a failure; otherwise the email was already
 * verified and we arrived on the success landing.
 */
function initialStatus(token?: string, errorParam?: string): VerifyStatus {
  if (token) return 'verifying';
  if (errorParam) return 'error';
  return 'success';
}

/**
 * Email-verification landing page. It is the target of the verification link:
 * when the link carries a `token` it confirms it via the auth client and shows
 * success or failure; when Better Auth verified server-side and redirected here,
 * it reports that outcome and links onward to `/account`.
 *
 * @param props.token - The verification token, when the link points here directly.
 * @param props.errorParam - An error code appended by a failed server-side verify.
 */
export function VerifyEmailCard({ token, errorParam }: { token?: string; errorParam?: string }) {
  const [status, setStatus] = useState<VerifyStatus>(() => initialStatus(token, errorParam));
  const confirmed = useRef(false);

  useEffect(() => {
    if (!token || confirmed.current) return;
    confirmed.current = true;
    void verifyEmail(token).then(({ error }) => {
      setStatus(error ? 'error' : 'success');
    });
  }, [token]);

  if (status === 'verifying') {
    return (
      <AuthShell title="Verifying your email" description="Confirming your DorkOS account…">
        <p className="text-muted-foreground text-sm">This only takes a moment.</p>
      </AuthShell>
    );
  }

  if (status === 'error') {
    return (
      <AuthShell
        title="This link didn't work"
        description="The verification link is invalid or has expired."
        footer={
          <Link href="/signin" className="underline underline-offset-4">
            Back to sign in
          </Link>
        }
      >
        <p className="text-muted-foreground text-sm">
          Sign in to request a fresh verification link.
        </p>
      </AuthShell>
    );
  }

  return (
    <AuthShell title="Email verified" description="Your DorkOS account is ready.">
      <Button render={<Link href="/account" />} className="w-full">
        Go to your account
      </Button>
    </AuthShell>
  );
}
