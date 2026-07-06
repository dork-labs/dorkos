'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';

import { authErrorMessage } from '@/layers/features/account/lib/auth-errors';
import { safeReturnTo } from '@/layers/features/account/lib/redirect-target';
import { signInEmail } from '@/lib/auth-client';
import { Button, Input, Label } from '@/layers/shared/ui';

import { AuthShell } from './AuthShell';
import { SocialSignInButtons } from './SocialSignInButtons';

/**
 * Sign-in form for an existing DorkOS account: email + password plus the social
 * providers. On success it navigates to the sanitized `returnTo` target.
 *
 * @param props.returnTo - Raw `returnTo` query param to send the visitor back to
 *   after a successful sign-in (sanitized before use).
 */
export function SignInForm({ returnTo }: { returnTo?: string }) {
  const router = useRouter();
  const target = safeReturnTo(returnTo);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    if (!email.trim() || !password) {
      setError('Enter your email and password.');
      return;
    }

    setPending(true);
    const { error: actionError } = await signInEmail({
      email: email.trim(),
      password,
      callbackURL: target,
    });
    setPending(false);

    if (actionError) {
      setError(authErrorMessage(actionError));
      return;
    }
    router.push(target);
    router.refresh();
  }

  return (
    <AuthShell
      title="Sign in to DorkOS"
      description="Access your DorkOS account."
      footer={
        <div className="flex flex-col gap-1">
          <span>
            No account?{' '}
            <Link href="/signup" className="text-foreground underline underline-offset-4">
              Create one
            </Link>
          </span>
          <Link href="/reset-password" className="underline underline-offset-4">
            Forgot your password?
          </Link>
        </div>
      }
    >
      <SocialSignInButtons callbackURL={target} />

      <div className="flex items-center gap-3">
        <span className="bg-border h-px flex-1" />
        <span className="text-muted-foreground text-xs">or</span>
        <span className="bg-border h-px flex-1" />
      </div>

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
        <div className="flex flex-col gap-2">
          <Label htmlFor="password">Password</Label>
          <Input
            id="password"
            name="password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>

        {error ? (
          <p role="alert" className="text-destructive text-sm">
            {error}
          </p>
        ) : null}

        <Button type="submit" className="w-full" disabled={pending}>
          {pending ? 'Signing in…' : 'Sign in'}
        </Button>
      </form>
    </AuthShell>
  );
}
