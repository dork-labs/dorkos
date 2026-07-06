'use client';

import Link from 'next/link';
import { useState, type FormEvent } from 'react';

import { authErrorMessage } from '@/layers/features/account/lib/auth-errors';
import { resetPassword } from '@/lib/auth-client';
import { Button, Input, Label } from '@/layers/shared/ui';

import { AuthShell } from './AuthShell';

/** Minimum password length (matches Better Auth's default). */
const MIN_PASSWORD_LENGTH = 8;

/**
 * Reset-confirm form: sets a new password using the one-time token from the
 * reset link. Renders an actionable "link is invalid" state when the token is
 * missing.
 *
 * @param props.token - The reset token carried by the link (absent when the
 *   link is malformed or already used).
 */
export function ResetPasswordForm({ token }: { token?: string }) {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [done, setDone] = useState(false);

  if (!token) {
    return (
      <AuthShell
        title="This reset link is invalid"
        description="The link is missing its token, or it has already been used."
        footer={
          <Link href="/reset-password" className="underline underline-offset-4">
            Request a new link
          </Link>
        }
      >
        <p className="text-muted-foreground text-sm">
          Reset links expire after a short while. Request a fresh one to continue.
        </p>
      </AuthShell>
    );
  }

  // `token` is a definite string past the guard; capture it so the async submit
  // handler keeps that type (TS re-widens a captured parameter inside a closure).
  const resetToken: string = token;

  if (done) {
    return (
      <AuthShell
        title="Password updated"
        description="Your DorkOS account password has been changed."
        footer={
          <Link href="/signin" className="underline underline-offset-4">
            Continue to sign in
          </Link>
        }
      >
        <p className="text-muted-foreground text-sm">Sign in with your new password to continue.</p>
      </AuthShell>
    );
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    if (password.length < MIN_PASSWORD_LENGTH) {
      setError(`Use a password of at least ${MIN_PASSWORD_LENGTH} characters.`);
      return;
    }
    if (password !== confirm) {
      setError('Passwords do not match.');
      return;
    }

    setPending(true);
    const { error: actionError } = await resetPassword({
      newPassword: password,
      token: resetToken,
    });
    setPending(false);

    if (actionError) {
      setError(authErrorMessage(actionError));
      return;
    }
    setDone(true);
  }

  return (
    <AuthShell
      title="Choose a new password"
      description="Set a new password for your DorkOS account."
    >
      <form onSubmit={onSubmit} className="flex flex-col gap-4" noValidate>
        <div className="flex flex-col gap-2">
          <Label htmlFor="password">New password</Label>
          <Input
            id="password"
            name="password"
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="confirm">Confirm new password</Label>
          <Input
            id="confirm"
            name="confirm"
            type="password"
            autoComplete="new-password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
          />
        </div>

        {error ? (
          <p role="alert" className="text-destructive text-sm">
            {error}
          </p>
        ) : null}

        <Button type="submit" className="w-full" disabled={pending}>
          {pending ? 'Updating…' : 'Update password'}
        </Button>
      </form>
    </AuthShell>
  );
}
