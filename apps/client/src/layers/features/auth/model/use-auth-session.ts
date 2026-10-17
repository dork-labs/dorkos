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
import { useCallback, useEffect, useState } from 'react';
import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import {
  clearBootCache,
  invalidateCommunityAuthority,
  isBootQueryKey,
  isStreamOwnedQuery,
  setAuthRequired,
} from '@/layers/shared/lib';
import { useAuthClient } from './auth-client-context';
import type { AuthError, AuthSession, AuthUser } from './auth-client';

/**
 * Everything a sign-in or sign-out may safely re-read.
 *
 * Signing in or out changes who the server thinks you are, so nearly every
 * cached answer is suspect and a whole-cache sweep is the honest response. The
 * exception is a cache kept current by a durable subscription of its own: those
 * resume from a cursor and are gap-free, so re-reading one replaces live state
 * with a page the server happens to return and loses whatever the socket
 * delivered while the read was in flight. See {@link isStreamOwnedQuery}.
 *
 * @param query - Any query the cache holds.
 */
function refetchableOnAuthChange(query: { meta?: Record<string, unknown> }): boolean {
  return !isStreamOwnedQuery(query);
}

function invalidateProtectedCommunityState(queryClient: QueryClient): void {
  invalidateCommunityAuthority();
  void queryClient.cancelQueries({ queryKey: ['communities'] });
  queryClient.removeQueries({ queryKey: ['communities'] });
}

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
      invalidateProtectedCommunityState(queryClient);
      const { error: err } = await client.signIn.email({ email, password });
      setIsPending(false);
      if (err) {
        setError(err);
        return { ok: false, error: err };
      }
      setAuthRequired(false);
      await queryClient.invalidateQueries({ predicate: refetchableOnAuthChange });
      return { ok: true };
    },
    [client, queryClient]
  );

  return { run, isPending, error, reset: () => setError(null) };
}

/** The query parameter a failed DorkOS sign-in comes back with. */
export const DORKOS_SIGN_IN_FAILED = 'dorkos-sign-in';

/**
 * The cookie that asks the server for a public-computer sign-in, read once at
 * the end of the sign-in (`apps/server/src/services/core/hub/public-computer.ts`).
 */
const PUBLIC_COMPUTER_MARKER = '__Host-dorkos-public-computer';

/** Ask the server for a public-computer sign-in, or stop asking. */
function askForPublicComputer(ask: boolean): void {
  document.cookie = ask
    ? `${PUBLIC_COMPUTER_MARKER}=1; Path=/; Max-Age=600; Secure; SameSite=Lax`
    : `${PUBLIC_COMPUTER_MARKER}=; Path=/; Max-Age=0; Secure; SameSite=Lax`;
}

/**
 * Sign in with a DorkOS account, on a person's own DorkOS in the cloud: asks
 * the server where to send the browser, then goes there. The DorkOS account
 * page sends the person back to the page they were on, signed in, or with
 * {@link DORKOS_SIGN_IN_FAILED} set when the sign-in was refused. On a shared
 * or public computer the session ends with the browser and when idle.
 */
export function useContinueWithDorkOS(): AuthActionState<[publicComputer?: boolean]> {
  const client = useAuthClient();
  const [isPending, setIsPending] = useState(false);
  const [error, setError] = useState<AuthError | null>(null);

  const run = useCallback(
    async (publicComputer = false): Promise<AuthActionResult> => {
      setIsPending(true);
      setError(null);
      askForPublicComputer(publicComputer);
      const here = new URL(window.location.href);
      here.searchParams.delete(DORKOS_SIGN_IN_FAILED);
      here.searchParams.delete('error');
      const back = `${here.pathname}${here.search}${here.hash}`;
      const failed = new URL(back, window.location.origin);
      failed.searchParams.set(DORKOS_SIGN_IN_FAILED, 'failed');
      const { data, error: err } = await client.signIn.social({
        provider: 'dorkos',
        callbackURL: back,
        errorCallbackURL: `${failed.pathname}${failed.search}`,
      });
      if (err || !data?.url) {
        const refused = err ?? { message: 'No sign-in address came back.', status: 0 };
        setIsPending(false);
        setError(refused);
        return { ok: false, error: refused };
      }
      window.location.assign(data.url);
      return { ok: true };
    },
    [client]
  );

  return { run, isPending, error, reset: () => setError(null) };
}

/**
 * Create the owner account (first-run sign-up). On success clears the
 * auth-required signal and refetches session state.
 */
export function useSignUp(): AuthActionState<
  [email: string, password: string, name: string, setupCode?: string]
> {
  const client = useAuthClient();
  const queryClient = useQueryClient();
  const [isPending, setIsPending] = useState(false);
  const [error, setError] = useState<AuthError | null>(null);

  const run = useCallback(
    async (
      email: string,
      password: string,
      name: string,
      setupCode?: string
    ): Promise<AuthActionResult> => {
      setIsPending(true);
      setError(null);
      invalidateProtectedCommunityState(queryClient);
      const { error: err } = await client.signUp.email(
        { email, password, name },
        setupCode ? { setupCode } : undefined
      );
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
    invalidateProtectedCommunityState(queryClient);
    const { error: err } = await client.signOut();
    setIsPending(false);
    if (err) {
      setError(err);
      return { ok: false, error: err };
    }
    // Community descriptors and content are owner-private. Remove them before
    // publishing the signed-out session so the next render cannot reuse the
    // previous owner's same-browser cache while a refetch is still pending.
    queryClient.setQueryData<AuthSession | null>(authSessionKey, null);
    // Forget the sidebar's local memory, in the cache and on disk. It holds this
    // person's channels, agents and today's conversations, and the whole point
    // of it is that the NEXT load paints from it before the server has said
    // anything — so leaving it behind would show the signed-out install's panel
    // to whoever opens the browser next. Dropped from the cache first so the
    // persister's next save has nothing left to write.
    queryClient.removeQueries({ predicate: (query) => isBootQueryKey(query.queryKey) });
    clearBootCache();
    await queryClient.invalidateQueries({ predicate: refetchableOnAuthChange });
    return { ok: true };
  }, [client, queryClient]);

  return { run, isPending, error, reset: () => setError(null) };
}

/** The signed-in user, or `null` — a thin read over {@link useAuthSession}. */
export function useCurrentUser(): AuthUser | null {
  const { data } = useAuthSession();
  return data?.user ?? null;
}

/** How long a public-computer session may sit idle before it is signed out. */
export const PUBLIC_COMPUTER_IDLE_MS = 30 * 60 * 1000;

/** What counts as someone using the page. */
const ACTIVITY_EVENTS = ['pointerdown', 'keydown', 'wheel', 'touchstart'] as const;

/**
 * Sign a public-computer session out after {@link PUBLIC_COMPUTER_IDLE_MS}
 * with nobody using the page, then reload to the sign-in screen. Does nothing
 * for any other session. Mounted once, by the {@link AuthGuard}.
 */
export function usePublicComputerIdleSignOut(): void {
  const { data } = useAuthSession();
  const client = useAuthClient();
  const publicComputer = data?.session.publicComputer === true;

  useEffect(() => {
    if (!publicComputer) return;
    let timer: ReturnType<typeof setTimeout>;
    const signOut = () => {
      void client.signOut().finally(() => window.location.reload());
    };
    const restart = () => {
      clearTimeout(timer);
      timer = setTimeout(signOut, PUBLIC_COMPUTER_IDLE_MS);
    };
    restart();
    for (const event of ACTIVITY_EVENTS) window.addEventListener(event, restart, { passive: true });
    return () => {
      clearTimeout(timer);
      for (const event of ACTIVITY_EVENTS) window.removeEventListener(event, restart);
    };
  }, [publicComputer, client]);
}
