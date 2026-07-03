'use client';

import Link from 'next/link';
import { useState, type FormEvent } from 'react';

import { authErrorMessage } from '@/layers/features/account/lib/auth-errors';
import { signUpEmail } from '@/lib/auth-client';
import { Button, Input, Label } from '@/layers/shared/ui';

import { AuthShell } from './AuthShell';
import { SocialSignInButtons } from './SocialSignInButtons';

/** Minimum password length (matches Better Auth's default). */
const MIN_PASSWORD_LENGTH = 8;

/** Where a verification link lands after the email is confirmed. */
const VERIFY_CALLBACK = '/verify-email';

/**
 * Sign-up form for a new DorkOS account: name, email, password (with
 * confirmation) plus the social providers. Email/password sign-up requires a
 * verified email, so a successful submit shows a "check your email" state rather
 * than signing the visitor in.
 */
export function SignUpForm() {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [submittedEmail, setSubmittedEmail] = useState<string | null>(null);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);

    const trimmedName = name.trim();
    const trimmedEmail = email.trim();
    if (!trimmedName) {
      setError('Enter your name.');
      return;
    }
    if (!trimmedEmail.includes('@')) {
      setError('Enter a valid email address.');
      return;
    }
    if (password.length < MIN_PASSWORD_LENGTH) {
      setError(`Use a password of at least ${MIN_PASSWORD_LENGTH} characters.`);
      return;
    }
    if (password !== confirm) {
      setError('Passwords do not match.');
      return;
    }

    setPending(true);
    const { error: actionError } = await signUpEmail({
      name: trimmedName,
      email: trimmedEmail,
      password,
      callbackURL: VERIFY_CALLBACK,
    });
    setPending(false);

    if (actionError) {
      setError(authErrorMessage(actionError));
      return;
    }
    setSubmittedEmail(trimmedEmail);
  }

  if (submittedEmail) {
    return (
      <AuthShell
        title="Verify your email"
        description={
          <>
            We sent a verification link to <span className="text-foreground">{submittedEmail}</span>
            . Confirm it to finish setting up your DorkOS account.
          </>
        }
        footer={
          <Link href="/signin" className="underline underline-offset-4">
            Back to sign in
          </Link>
        }
      >
        <p className="text-muted-foreground text-sm">
          Didn&apos;t get it? Check your spam folder, or try signing in to resend the link.
        </p>
      </AuthShell>
    );
  }

  return (
    <AuthShell
      title="Create your DorkOS account"
      description="One account for dorkos.ai and your linked instances."
      footer={
        <span>
          Already have an account?{' '}
          <Link href="/signin" className="text-foreground underline underline-offset-4">
            Sign in
          </Link>
        </span>
      }
    >
      <SocialSignInButtons callbackURL="/account" />

      <div className="flex items-center gap-3">
        <span className="bg-border h-px flex-1" />
        <span className="text-muted-foreground text-xs">or</span>
        <span className="bg-border h-px flex-1" />
      </div>

      <form onSubmit={onSubmit} className="flex flex-col gap-4" noValidate>
        <div className="flex flex-col gap-2">
          <Label htmlFor="name">Name</Label>
          <Input
            id="name"
            name="name"
            type="text"
            autoComplete="name"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
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
        <div className="flex flex-col gap-2">
          <Label htmlFor="password">Password</Label>
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
          <Label htmlFor="confirm">Confirm password</Label>
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
          {pending ? 'Creating account…' : 'Create account'}
        </Button>
      </form>
    </AuthShell>
  );
}
