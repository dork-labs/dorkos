/**
 * Native paste-key + delegated-login connect hooks (ADR-0318, T1 tasks 2.4/2.5).
 *
 * Both flows resolve the same way a successful T0 provision does: on success
 * they invalidate the shared `['requirements']` key so the runtime flips to
 * Ready with no manual "Check again", and `['models']` so the model menu shows
 * what the new connection actually offers. The secret is passed once to the
 * transport and never returned, cached, or logged — the store response carries
 * only a reference.
 *
 * These live in `entities/runtime` rather than beside the connect flow that was
 * their first caller: signing a runtime in is runtime-scoped model logic, and
 * TWO features now need it — the settings connect flow (`features/runtime-connect`)
 * and the chat auth-error card that signs in without leaving the conversation
 * (`features/chat`, DOR-1651). A feature may not reach into another feature's
 * model, so the shared half sits one layer down, the same way `McpSigninBody` /
 * `useMcpSigninFlow` sit in `entities/agent` for their two callers.
 *
 * @module entities/runtime/model/use-credential-connect
 */
import { useMemo } from 'react';
import {
  useMutation,
  useMutationState,
  useQueryClient,
  type MutationState,
} from '@tanstack/react-query';
import type { DelegateLoginOptions, DelegatedLoginResult } from '@dorkos/shared/runtime-connect';
import { MODELS_KEY } from '@/layers/shared/lib';
import { useTransport } from '@/layers/shared/model';
import { REQUIREMENTS_KEY } from './use-runtime-requirements';

/** The native paste-key connect: store an API key, flip the runtime to Ready. */
export interface UseStoreRuntimeCredential {
  /** Store the pasted key. No-op on empty input; re-callable after a failure. */
  store: (secret: string) => void;
  /** True while the key is being stored. */
  isPending: boolean;
  /** True once the key was stored (before the requirements refetch flips Ready). */
  isSuccess: boolean;
  /** True when storing the key failed (network/HTTP or a rejected key). */
  isError: boolean;
  /** Honest failure message, or `null` when not failed. */
  errorMessage: string | null;
  /** Clear the mutation state (e.g. when toggling back to the sign-in path). */
  reset: () => void;
}

/**
 * Store a runtime's native API key (`claude-code` / `codex` paste-key path).
 *
 * @param type - Runtime type whose credential is being stored.
 */
export function useStoreRuntimeCredential(type: string): UseStoreRuntimeCredential {
  const transport = useTransport();
  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationFn: (secret: string) => transport.storeRuntimeCredential(type, secret),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: [...REQUIREMENTS_KEY] });
      // The catalog changed with the connection: a new provider's models are
      // now offered, and the old ones may not be (DOR-1660).
      void queryClient.invalidateQueries({ queryKey: [...MODELS_KEY] });
    },
  });

  return {
    store: (secret: string) => {
      if (secret.trim().length === 0) return;
      mutation.mutate(secret);
    },
    isPending: mutation.isPending,
    isSuccess: mutation.isSuccess,
    isError: mutation.isError,
    errorMessage: mutation.isError
      ? ((mutation.error as Error).message ?? 'Could not save the API key.')
      : null,
    reset: mutation.reset,
  };
}

/** The delegated vendor-login connect: run `claude auth login` / `codex login` terminal-free. */
export interface UseDelegateRuntimeLogin {
  /** Trigger the delegated login. Re-callable after a failure (retry). */
  login: () => void;
  /** True while the CLI login is in flight (awaiting completion detection). */
  isPending: boolean;
  /** True once the CLI reported a completed login. */
  isSuccess: boolean;
  /** True when the login failed, was denied, or timed out. */
  isError: boolean;
  /** Honest failure message, or `null` when not failed. */
  errorMessage: string | null;
}

/**
 * Delegate a vendor CLI login (`claude-code` / `codex`).
 *
 * The transport resolves `{ ok: false, error }` for a bounded-timeout or denied
 * login (never throws for those), so a resolved `ok: false` is treated as
 * failure alongside a thrown error — one honest, retryable error path. Only a
 * completed login invalidates `['requirements']`.
 *
 * A loopback-only refusal (the login route is local-only) and the Obsidian
 * embed's honest decline both arrive on that same error path, so a caller that
 * cannot reach the endpoint shows a real message and a retry rather than a
 * button that does nothing. Reaching sign-in from a remote/tunnel client is
 * DOR-1655, not this hook.
 *
 * ## The state is shared, not component-local
 *
 * A sign-in outlives the component that started it. The chat error card lives
 * inside a VIRTUALIZED transcript (overscan 5): scroll the failed turn out of
 * view mid-login and the row unmounts, taking a component-local `useMutation`
 * with it — so scrolling back would show a pristine "Sign in" button and a
 * second click would spawn a second `claude auth login`. The same is true of a
 * second tab, and of two cards for the same runtime in one transcript.
 *
 * So the login is keyed into the shared `MutationCache` and read back with
 * `useMutationState`: every card for the same `(type, account)` reads ONE
 * attempt, a remounted row rejoins the one already running, and the pending
 * state is what hides the button that would start another. The server holds
 * the matching latch, because a client-side one cannot see other tabs.
 *
 * @param type - Runtime type to sign in (`'claude-code'` | `'codex'`).
 * @param options - Which account to sign in. Prefer `sessionId` wherever a
 *   session exists — the server resolves the account it is bound to, including
 *   for a first turn that failed before writing a transcript (DOR-1651).
 */
export function useDelegateRuntimeLogin(
  type: string,
  options?: DelegateLoginOptions
): UseDelegateRuntimeLogin {
  const transport = useTransport();
  const queryClient = useQueryClient();
  const { sessionId, accountRoot } = options ?? {};
  // One key per sign-in TARGET: two cards for the same account share an
  // attempt, while a different account stays its own (the server refuses to run
  // those concurrently anyway, and its refusal must land on the card that asked).
  const mutationKey = useMemo(
    () => ['runtime-login', type, sessionId ?? '', accountRoot ?? ''] as const,
    [type, sessionId, accountRoot]
  );

  const mutation = useMutation({
    mutationKey,
    mutationFn: () =>
      transport.delegateRuntimeLogin(
        type,
        sessionId === undefined && accountRoot === undefined
          ? undefined
          : { sessionId, accountRoot }
      ),
    onSuccess: (result) => {
      if (result.ok) {
        void queryClient.invalidateQueries({ queryKey: [...REQUIREMENTS_KEY] });
        // The catalog changed with the connection: a new provider's models are
        // now offered, and the old ones may not be (DOR-1660).
        void queryClient.invalidateQueries({ queryKey: [...MODELS_KEY] });
      }
    },
  });

  // Read from the cache, not from `mutation`: this instance may have mounted
  // AFTER the login started (a re-rendered virtual row, a second tab), in which
  // case its own observer has never run and only the cache knows.
  const shared = useMutationState({
    filters: { mutationKey, exact: true },
    select: (m) => m.state as MutationState<DelegatedLoginResult, Error>,
  });
  const pending = shared.some((s) => s.status === 'pending');
  const latest = shared[shared.length - 1];
  const settled = pending ? undefined : latest;

  const failed = !pending && (settled?.status === 'error' || settled?.data?.ok === false);
  const rawError =
    settled?.status === 'error' ? (settled.error?.message ?? null) : (settled?.data?.error ?? null);

  return {
    // Never start a second attempt while one is running. The pending branch
    // hides the button anyway; this closes the gap for a caller that does not.
    login: () => {
      if (!pending) mutation.mutate();
    },
    isPending: pending,
    isSuccess: settled?.data?.ok === true,
    isError: failed,
    errorMessage: failed ? (rawError ?? 'Sign-in failed. Please try again.') : null,
  };
}
