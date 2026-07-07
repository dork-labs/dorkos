/**
 * Auth session + credential hooks — the public surface for reading the current
 * session and running sign-in / sign-up / sign-out against the {@link AuthClient}.
 *
 * No component imports the auth client directly; these hooks are the seam. Each
 * mutation hook surfaces a typed {@link AuthError} (including `retryAfter` for
 * rate-limit copy) rather than throwing, and keeps the app-wide auth-required
 * signal + TanStack Query cache coherent on success.
 *
 * @module features/auth/model/use-auth-session
 */
import { useCallback, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { setAuthRequired } from '@/layers/shared/lib';
import { useAuthClient } from './auth-client-context';
import type { AuthError, AuthSession, AuthUser } from './auth-client';

/** TanStack Query key for the current auth session. */
export const authSessionKey = ['auth', 'session'] as const;

/** Read the current auth session (`null` when signed out). Cached via TanStack Query. */
export function useAuthSession() {
  const client = useAuthClient();
  return useQuery<AuthSession | null>({
    queryKey: authSessionKey,
    queryFn: async () => {
      const { data } = await client.getSession();
      return data ?? null;
    },
    staleTime: 30_000,
  });
}

/** Outcome of a credential mutation — lets callers branch on the error synchronously. */
export type AuthActionResult = { ok: true } | { ok: false; error: AuthError };

/** State + trigger returned by the credential mutation hooks. */
interface AuthActionState<Args extends unknown[]> {
  run: (...args: Args) => Promise<AuthActionResult>;
  isPending: boolean;
  error: AuthError | null;
  reset: () => void;
}

/**
 * Sign in with email + password. On success clears the auth-required signal and
 * refetches session + config so gated data reloads behind the (now valid) cookie.
 */
export function useSignIn(): AuthActionState<[email: string, password: string]> {
  const client = useAuthClient();
  const queryClient = useQueryClient();
  const [isPending, setIsPending] = useState(false);
  const [error, setError] = useState<AuthError | null>(null);

  const run = useCallback(
    async (email: string, password: string): Promise<AuthActionResult> => {
      setIsPending(true);
      setError(null);
      const { error: err } = await client.signIn.email({ email, password });
      setIsPending(false);
      if (err) {
        setError(err);
        return { ok: false, error: err };
      }
      setAuthRequired(false);
      await queryClient.invalidateQueries();
      return { ok: true };
    },
    [client, queryClient]
  );

  return { run, isPending, error, reset: () => setError(null) };
}

/**
 * Create the owner account (first-run sign-up). On success clears the
 * auth-required signal and refetches session state.
 */
export function useSignUp(): AuthActionState<[email: string, password: string, name: string]> {
  const client = useAuthClient();
  const queryClient = useQueryClient();
  const [isPending, setIsPending] = useState(false);
  const [error, setError] = useState<AuthError | null>(null);

  const run = useCallback(
    async (email: string, password: string, name: string): Promise<AuthActionResult> => {
      setIsPending(true);
      setError(null);
      const { error: err } = await client.signUp.email({ email, password, name });
      setIsPending(false);
      if (err) {
        setError(err);
        return { ok: false, error: err };
      }
      setAuthRequired(false);
      await queryClient.invalidateQueries({ queryKey: authSessionKey });
      return { ok: true };
    },
    [client, queryClient]
  );

  return { run, isPending, error, reset: () => setError(null) };
}

/** Sign out; clears the cached session so the guard re-evaluates (login enabled → login screen). */
export function useSignOut(): AuthActionState<[]> {
  const client = useAuthClient();
  const queryClient = useQueryClient();
  const [isPending, setIsPending] = useState(false);
  const [error, setError] = useState<AuthError | null>(null);

  const run = useCallback(async (): Promise<AuthActionResult> => {
    setIsPending(true);
    setError(null);
    const { error: err } = await client.signOut();
    setIsPending(false);
    if (err) {
      setError(err);
      return { ok: false, error: err };
    }
    queryClient.setQueryData<AuthSession | null>(authSessionKey, null);
    await queryClient.invalidateQueries();
    return { ok: true };
  }, [client, queryClient]);

  return { run, isPending, error, reset: () => setError(null) };
}

/** The signed-in user, or `null` — a thin read over {@link useAuthSession}. */
export function useCurrentUser(): AuthUser | null {
  const { data } = useAuthSession();
  return data?.user ?? null;
}
