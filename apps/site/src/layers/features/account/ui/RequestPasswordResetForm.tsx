'use client';

import Link from 'next/link';
import { useState, type FormEvent } from 'react';

import { requestPasswordReset } from '@/lib/auth-client';
import { Button, Input, Label } from '@/layers/shared/ui';

import { AuthShell } from './AuthShell';

/** Where the reset link lands (Better Auth appends the one-time `?token=`). */
const RESET_CONFIRM_PATH = '/reset-password/confirm';

/** Generic, enumeration-safe confirmation shown after any submit. */
const GENERIC_SUCCESS = 'If an account exists for that email, a password-reset link is on its way.';

/**
 * Password-reset request form. Submitting always shows the same generic
 * confirmation whether or not the address has an account, so the form never
 * reveals which emails are registered.
 */
export function RequestPasswordResetForm() {
  const [email, setEmail] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [sent, setSent] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    if (!email.trim().includes('@')) {
      setError('Enter a valid email address.');
      return;
    }

    setPending(true);
    // The result is intentionally ignored: success and "no such account" look
    // identical to the visitor. Only a transport-level failure would surface.
    await requestPasswordReset({ email: email.trim(), redirectTo: RESET_CONFIRM_PATH });
    setPending(false);
    setSent(true);
  }

  if (sent) {
    return (
      <AuthShell
        title="Check your email"
        description={GENERIC_SUCCESS}
        footer={
          <Link href="/signin" className="underline underline-offset-4">
            Back to sign in
          </Link>
        }
      >
        <p className="text-muted-foreground text-sm">
          The link expires after a short while. Request another if it lapses.
        </p>
      </AuthShell>
    );
  }

  return (
    <AuthShell
      title="Reset your password"
      description="Enter your account email and we'll send a reset link."
      footer={
        <Link href="/signin" className="underline underline-offset-4">
          Back to sign in
        </Link>
      }
    >
      <form onSubmit={onSubmit} className="flex flex-col gap-4" noValidate>
        <div className="flex flex-col gap-2">
          <Label htmlFor="email">Email</Label>
          <Input
            id="email"
            name="email"
            type="email"
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </div>

        {error ? (
          <p role="alert" className="text-destructive text-sm">
            {error}
          </p>
        ) : null}

        <Button type="submit" className="w-full" disabled={pending}>
          {pending ? 'Sending…' : 'Send reset link'}
        </Button>
      </form>
    </AuthShell>
  );
}
