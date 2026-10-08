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
import { useCallback, useState, useRef, useEffect, type RefObject } from 'react';
import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import {
  clearBootCache,
  invalidateCommunityAuthority,
  isBootQueryKey,
  isStreamOwnedQuery,
  setAuthRequired,
  beginExtensionAuthOperation,
  isExtensionAuthOperationCurrent,
  authenticateExtensionAuthOperation,
  resumeExtensionLoads,
  getExtensionLoadAdmission,
  cancelExtensionAuthOperation,
  suspendExtensionLoads,
  type ExtensionAuthOperation,
} from '@/layers/shared/lib';
import { useAuthClient } from './auth-client-context';
import type { AuthClient, AuthError, AuthSession, AuthUser } from './auth-client';

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

function invalidateProtectedCommunityState(
  queryClient: QueryClient,
  requireCurrent: () => void
): void {
  requireCurrent();
  invalidateCommunityAuthority(requireCurrent);
  const cancel = queryClient.cancelQueries;
  const cancelInput = { queryKey: ['communities'] };
  requireCurrent();
  void Reflect.apply(cancel, queryClient, [cancelInput]);
  const remove = queryClient.removeQueries;
  const removeInput = { queryKey: ['communities'] };
  requireCurrent();
  Reflect.apply(remove, queryClient, [removeInput]);
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

/** Contain a throwing client as well as a rejected request; no success is synthesized. */
async function settledAuthCall(
  call: () => Promise<{ error: AuthError | null }>
): Promise<{ error: AuthError | null }> {
  try {
    return await call();
  } catch {
    return {
      error: {
        status: 0,
        code: 'AUTH_REQUEST_FAILED',
        message: 'Sign-in state could not be confirmed.',
      },
    };
  }
}

/** A superseded local continuation grants no session or extension state. */
function supersededAuthResult(): AuthActionResult {
  return {
    ok: false,
    error: {
      status: 0,
      code: 'AUTH_SUPERSEDED',
      message: 'A newer sign-in change took precedence.',
    },
  };
}

/** State + trigger returned by the credential mutation hooks. */
interface AuthActionState<Args extends unknown[]> {
  run: (...args: Args) => Promise<AuthActionResult>;
  isPending: boolean;
  error: AuthError | null;
  reset: () => void;
}

type AuthKind = ExtensionAuthOperation['kind'];
interface CredentialArgs {
  signIn: [email: string, password: string];
  signUp: [email: string, password: string, name: string];
  signOut: [];
}
interface ActionOwner {
  client: AuthClient;
  query: QueryClient;
  identity: object;
  local: RefObject<object | null>;
  attempt: RefObject<ExtensionAuthOperation | null>;
  pending: (value: boolean) => void;
  error: (value: AuthError | null) => void;
}
interface AuthRun {
  owner: ActionOwner;
  local: object;
  attempt: ExtensionAuthOperation | null;
}
function locallyCurrent(run: AuthRun): boolean {
  return run.owner.local.current === run.local;
}
function globallyCurrent(run: AuthRun): boolean {
  return !!run.attempt && isExtensionAuthOperationCurrent(run.owner.identity, run.attempt);
}
function currentRun(run: AuthRun): boolean {
  return locallyCurrent(run) && globallyCurrent(run);
}
function requireRun(run: AuthRun): void {
  if (!currentRun(run)) throw new Error('Auth attempt superseded.');
}
function startRun(run: AuthRun, kind: AuthKind): void {
  // Record the original token before retirement callbacks; never consult a newer ref in catch.
  run.attempt = beginExtensionAuthOperation(run.owner.identity, kind);
  if (locallyCurrent(run)) run.owner.attempt.current = run.attempt;
  requireRun(run);
  invalidateProtectedCommunityState(run.owner.query, () => requireRun(run));
  requireRun(run);
}
function authRequest(run: AuthRun, kind: AuthKind, args: readonly string[]) {
  const client = run.owner.client;
  if (kind === 'signOut') {
    const method = client.signOut;
    requireRun(run);
    return Reflect.apply(method, client, []);
  }
  const target = client[kind];
  const method = target.email;
  const input =
    kind === 'signUp'
      ? { email: args[0], password: args[1], name: args[2] }
      : { email: args[0], password: args[1] };
  requireRun(run);
  return Reflect.apply(method, target, [input]);
}
async function finishCredential(run: AuthRun, kind: AuthKind): Promise<AuthActionResult> {
  const { owner, attempt } = run;
  // Successful authentication survives expected login UI unmount, but no newer occurrence.
  if (!attempt || !authenticateExtensionAuthOperation(owner.identity, attempt))
    return supersededAuthResult();
  if (locallyCurrent(run)) owner.pending(false);
  if (!globallyCurrent(run)) return supersededAuthResult();
  setAuthRequired(false);
  if (!globallyCurrent(run)) return supersededAuthResult();
  const resumed = resumeExtensionLoads(owner.identity, attempt);
  const sameAdmission = () =>
    globallyCurrent(run) && (!resumed || getExtensionLoadAdmission() === resumed);
  const query = owner.query;
  const invalidate = query.invalidateQueries;
  const input =
    kind === 'signUp' ? { queryKey: authSessionKey } : { predicate: refetchableOnAuthChange };
  if (!sameAdmission()) return supersededAuthResult();
  await Reflect.apply(invalidate, query, [input]);
  return sameAdmission() ? { ok: true } : supersededAuthResult();
}
async function finishSignOut(run: AuthRun): Promise<AuthActionResult> {
  const { query } = run.owner;
  const set = query.setQueryData;
  const setInput = [authSessionKey, null];
  requireRun(run);
  Reflect.apply(set, query, setInput);
  const remove = query.removeQueries;
  const removeInput = {
    predicate: (query: { queryKey: readonly unknown[] }) => isBootQueryKey(query.queryKey),
  };
  requireRun(run);
  Reflect.apply(remove, query, [removeInput]);
  requireRun(run);
  clearBootCache();
  const invalidate = query.invalidateQueries;
  const invalidateInput = { predicate: refetchableOnAuthChange };
  requireRun(run);
  await Reflect.apply(invalidate, query, [invalidateInput]);
  requireRun(run);
  return { ok: true };
}
function failRun(run: AuthRun): AuthActionResult {
  // Local ownership is checked before suspension: an unmounted or superseded catch grants no effect.
  if (!currentRun(run)) return supersededAuthResult();
  suspendExtensionLoads();
  if (!locallyCurrent(run)) return supersededAuthResult();
  const error: AuthError = {
    status: 0,
    code: 'AUTH_STATE_FAILED',
    message: 'Sign-in state could not be confirmed.',
  };
  run.owner.pending(false);
  run.owner.error(error);
  return { ok: false, error };
}
async function performAuthRun(
  owner: ActionOwner,
  kind: AuthKind,
  args: readonly string[]
): Promise<AuthActionResult> {
  owner.pending(true);
  owner.error(null);
  const run: AuthRun = { owner, local: {}, attempt: null };
  owner.local.current = run.local;
  try {
    startRun(run, kind);
    const { error } = await settledAuthCall(() => authRequest(run, kind, args));
    if (!currentRun(run)) {
      if (locallyCurrent(run)) owner.pending(false);
      return supersededAuthResult();
    }
    if (error) {
      owner.pending(false);
      owner.error(error);
      return { ok: false, error };
    }
    if (kind === 'signOut') {
      owner.pending(false);
      return await finishSignOut(run);
    }
    return await finishCredential(run, kind);
  } catch {
    return failRun(run);
  }
}
function useAuthAction<K extends AuthKind>(kind: K): AuthActionState<CredentialArgs[K]> {
  const client = useAuthClient();
  const query = useQueryClient();
  const [identity] = useState<object>(() => ({}));
  const local = useRef<object | null>(null);
  const attempt = useRef<ExtensionAuthOperation | null>(null);
  const [isPending, pending] = useState(false);
  const [error, setError] = useState<AuthError | null>(null);
  useEffect(
    () => () => {
      local.current = null;
      if (attempt.current) cancelExtensionAuthOperation(identity, attempt.current);
    },
    [identity]
  );
  const run = useCallback(
    (...args: CredentialArgs[K]) =>
      performAuthRun(
        { client, query, identity, local, attempt, pending, error: setError },
        kind,
        args
      ),
    [client, query, identity, kind]
  );
  return { run, isPending, error, reset: () => setError(null) };
}
/** Sign in; only the original current successful credential occurrence can resume extension loads. */
export function useSignIn(): AuthActionState<CredentialArgs['signIn']> {
  return useAuthAction('signIn');
}
/** Create the owner account under the same exact occurrence and cache-publication fences. */
export function useSignUp(): AuthActionState<CredentialArgs['signUp']> {
  return useAuthAction('signUp');
}
/** Sign out and retire extensions before publishing the signed-out cache state. */
export function useSignOut(): AuthActionState<CredentialArgs['signOut']> {
  return useAuthAction('signOut');
}

/** The signed-in user, or `null` — a thin read over {@link useAuthSession}. */
export function useCurrentUser(): AuthUser | null {
  const { data } = useAuthSession();
  return data?.user ?? null;
}
