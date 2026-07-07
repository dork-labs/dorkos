import { useId, useState, type FormEvent } from 'react';
import { Lock } from 'lucide-react';
import { Button, Input, Label, PasswordInput } from '@/layers/shared/ui';
import { useSignIn } from '../model/use-auth-session';

interface LoginScreenProps {
  /** Called after a successful sign-in (the guard also reacts to the cleared signal). */
  onSignedIn?: () => void;
}

/**
 * Sign-in form for a login-protected instance. Rendered full-bleed by the
 * {@link AuthGuard} when a gated request reports that login is required, and to
 * remote visitors reaching an exposed instance.
 */
export function LoginScreen({ onSignedIn }: LoginScreenProps) {
  const emailId = useId();
  const passwordId = useId();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const { run, isPending, error } = useSignIn();

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (isPending) return;
    const result = await run(email, password);
    if (result.ok) onSignedIn?.();
  }

  // Better Auth rate-limits sign-in; surface the retry window plainly.
  const isRateLimited = error?.status === 429 || error?.retryAfter !== undefined;
  const errorMessage = isRateLimited
    ? `Too many attempts. Try again${
        error?.retryAfter ? ` in ${error.retryAfter}s` : ' in a little while'
      }.`
    : error?.message;

  return (
    <div className="flex min-h-screen w-full items-center justify-center p-6">
      <div className="bg-card shadow-elevated w-full max-w-sm rounded-xl border p-6">
        <div className="mb-6 flex flex-col items-center text-center">
          <div className="bg-muted mb-3 flex size-11 items-center justify-center rounded-full">
            <Lock className="size-5" />
          </div>
          <h1 className="text-lg font-semibold">Sign in to DorkOS</h1>
          <p className="text-muted-foreground mt-1 text-sm">
            This instance requires a login to continue.
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor={emailId}>Email</Label>
            <Input
              id={emailId}
              type="email"
              autoComplete="username"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoFocus
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={passwordId}>Password</Label>
            <PasswordInput
              id={passwordId}
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </div>

          {errorMessage && (
            <p className="text-sm text-red-500" role="alert">
              {errorMessage}
            </p>
          )}

          <Button type="submit" className="w-full" disabled={isPending}>
            {isPending ? 'Signing in…' : 'Sign in'}
          </Button>
        </form>
      </div>
    </div>
  );
}
