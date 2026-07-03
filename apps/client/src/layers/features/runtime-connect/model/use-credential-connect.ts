/**
 * Native paste-key + delegated-login connect hooks (ADR-0318, T1 tasks 2.4/2.5).
 *
 * Both flows resolve the same way a successful T0 provision does: on success
 * they invalidate the shared `['requirements']` key so the runtime flips to
 * Ready with no manual "Check again". The secret is passed once to the
 * transport and never returned, cached, or logged — the store response carries
 * only a reference.
 *
 * @module features/runtime-connect/model/use-credential-connect
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { REQUIREMENTS_KEY } from '@/layers/entities/runtime';
import { useTransport } from '@/layers/shared/model';

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
 * @param type - Runtime type to sign in (`'claude-code'` | `'codex'`).
 */
export function useDelegateRuntimeLogin(type: string): UseDelegateRuntimeLogin {
  const transport = useTransport();
  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationFn: () => transport.delegateRuntimeLogin(type),
    onSuccess: (result) => {
      if (result.ok) {
        void queryClient.invalidateQueries({ queryKey: [...REQUIREMENTS_KEY] });
      }
    },
  });

  const failed = mutation.isError || mutation.data?.ok === false;
  const rawError = mutation.isError
    ? (mutation.error as Error).message
    : (mutation.data?.error ?? null);

  return {
    login: () => mutation.mutate(),
    isPending: mutation.isPending,
    isSuccess: mutation.data?.ok === true,
    isError: failed,
    errorMessage: failed ? (rawError ?? 'Sign-in failed. Please try again.') : null,
  };
}
