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
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  useMutation,
  useMutationState,
  useQuery,
  useQueryClient,
  type MutationState,
  type QueryClient,
  type UseQueryResult,
} from '@tanstack/react-query';
import type {
  CredentialCheckResult,
  DelegateLoginOptions,
  DelegatedLoginResult,
  RuntimeKeyStatus,
} from '@dorkos/shared/runtime-connect';
import { MODELS_KEY } from '@/layers/shared/lib';
import { useTransport } from '@/layers/shared/model';
import { REQUIREMENTS_KEY } from './use-runtime-requirements';

/**
 * TanStack Query key factory for "is this runtime's key already saved". Shared
 * so a completed save can invalidate the exact key the form reads.
 *
 * @param type - Runtime type the status belongs to.
 */
export function runtimeKeyStatusKey(type: string): readonly [string, string] {
  return ['runtime-key-status', type] as const;
}

/**
 * Whether this runtime's own key is already saved, and its last four characters.
 *
 * The form used to reopen with an empty field and no way to tell a saved key
 * from none at all (DOR-2123). Only fetched when the key form is actually on
 * screen, because that is the only place the answer is shown.
 *
 * @param type - Runtime type (`'claude-code'` | `'codex'`).
 * @param enabled - Whether to ask (true when the key form is visible).
 */
export function useRuntimeKeyStatus(
  type: string,
  enabled = true
): UseQueryResult<RuntimeKeyStatus> {
  const transport = useTransport();
  return useQuery<RuntimeKeyStatus>({
    queryKey: runtimeKeyStatusKey(type),
    queryFn: () => transport.getRuntimeKeyStatus(type),
    enabled,
    staleTime: 30_000,
  });
}

/** The Test action for a runtime's own key: try it, save nothing. */
export interface UseCheckRuntimeCredential {
  /** Try the pasted key, or the saved one when nothing is pasted. */
  check: (secret: string) => void;
  /** True while the service is being asked. */
  isPending: boolean;
  /** The answer, or `null` when nothing has been tried since the last reset. */
  result: CredentialCheckResult | null;
  /**
   * Whether the answer is about the key ALREADY SAVED rather than a typed one.
   * The surface says which, because "it works" about the wrong key is worse
   * than no answer at all.
   */
  checkedSavedKey: boolean;
  /** Forget the last answer — called when the key field is edited. */
  reset: () => void;
}

/**
 * Try a runtime's own key against the service that issues it, saving nothing.
 * Runs the SAME server check a save runs, so what a person tests is what a save
 * will do.
 *
 * @param type - Runtime type (`'claude-code'` | `'codex'`).
 */
export function useCheckRuntimeCredential(type: string): UseCheckRuntimeCredential {
  const transport = useTransport();

  const mutation = useMutation({
    mutationFn: (secret: string) =>
      transport.checkRuntimeCredential(type, secret.trim().length > 0 ? secret : null),
    // A refused key is rendered in the form, right where it can be fixed. A
    // toast on top of that is the same news twice, one copy of it out of context.
    meta: { suppressErrorToast: true },
  });

  const result: CredentialCheckResult | null =
    mutation.data ??
    (mutation.isError
      ? {
          ok: false,
          reason: 'unexpected',
          message: (mutation.error as Error).message || 'Couldn’t check the key.',
        }
      : null);

  return {
    check: (secret: string) => mutation.mutate(secret),
    isPending: mutation.isPending,
    result,
    // Derived BESIDE the answer, so it is false when there is no answer. Read
    // off the request that produced it rather than off the field as it stands
    // now, because the field may have been edited since.
    checkedSavedKey: result !== null && (mutation.variables ?? '').trim().length === 0,
    reset: mutation.reset,
  };
}

/** Which half of a save is running: the check, or the write. */
export type RuntimeKeyPhase = 'checking' | 'saving';

/** The native paste-key connect: check an API key, store it, flip the runtime to Ready. */
export interface UseStoreRuntimeCredential {
  /** Check and store the pasted key. No-op on empty input; re-callable after a failure. */
  store: (secret: string) => void;
  /** True while the key is being checked or stored. */
  isPending: boolean;
  /** Which half is running, so the progress line can say which. */
  phase: RuntimeKeyPhase | null;
  /** True once the key was stored (before the requirements refetch flips Ready). */
  isSuccess: boolean;
  /** True when the key was refused, or could not be stored. */
  isError: boolean;
  /** Honest failure message, or `null` when not failed. */
  errorMessage: string | null;
  /** Clear the mutation state (e.g. when toggling back to the sign-in path). */
  reset: () => void;
}

/**
 * Store a runtime's native API key (`claude-code` / `codex` paste-key path).
 *
 * The key is checked against the service that issues it FIRST, and nothing is
 * stored when the service refuses it (DOR-2123). The check is its own call so
 * the surface can say "Checking your key…" and then "Saving…" truthfully and
 * show the service's own plain-language line; the server re-checks on the save
 * regardless, so this is the progress report, never the enforcement.
 *
 * @param type - Runtime type whose credential is being stored.
 */
export function useStoreRuntimeCredential(type: string): UseStoreRuntimeCredential {
  const transport = useTransport();
  const queryClient = useQueryClient();
  const [phase, setPhase] = useState<RuntimeKeyPhase | null>(null);

  const mutation = useMutation({
    mutationFn: async (secret: string) => {
      setPhase('checking');
      const check = await transport.checkRuntimeCredential(type, secret);
      if (!check.ok) return { saved: false as const, message: check.message };
      setPhase('saving');
      await transport.storeRuntimeCredential(type, secret);
      return { saved: true as const, message: null };
    },
    onSettled: () => setPhase(null),
    // The refusal is shown under the key field, where it can be acted on.
    meta: { suppressErrorToast: true },
    onSuccess: (result) => {
      if (!result.saved) return;
      void queryClient.invalidateQueries({ queryKey: [...REQUIREMENTS_KEY] });
      // The catalog changed with the connection: a new provider's models are
      // now offered, and the old ones may not be (DOR-1660).
      void queryClient.invalidateQueries({ queryKey: [...MODELS_KEY] });
      void queryClient.invalidateQueries({ queryKey: [...runtimeKeyStatusKey(type)] });
    },
  });

  const refused = mutation.data?.saved === false;
  return {
    store: (secret: string) => {
      if (secret.trim().length === 0) return;
      mutation.mutate(secret);
    },
    isPending: mutation.isPending,
    phase,
    isSuccess: mutation.data?.saved === true,
    isError: mutation.isError || refused,
    errorMessage: refused
      ? (mutation.data?.message ?? null)
      : mutation.isError
        ? ((mutation.error as Error).message ?? 'Couldn’t save the API key.')
        : null,
    reset: mutation.reset,
  };
}

/** Which account to sign in, and what to do once the sign-in lands. */
export interface UseDelegateRuntimeLoginOptions extends DelegateLoginOptions {
  /**
   * Called when a sign-in completes — **exactly once per sign-in**, no matter
   * how many cards are watching it or how often they unmount and remount.
   *
   * The guarantee is the point, not a courtesy. Its consumer re-sends the
   * failed turn (DOR-1650), so a second call sends the person's message a
   * second time. See {@link reportedSignins} for where the latch lives and why
   * it cannot live in the component.
   */
  onCompleted?: () => void;
}

/**
 * Which sign-ins have already been announced, per QueryClient.
 *
 * Keyed by `mutationId`, which is unique within a client and identifies the
 * sign-in itself rather than any component watching it — and that is the whole
 * point. A latch held in a `useRef` belongs to one component instance and
 * resets on the remount a virtualized transcript performs routinely, so it
 * re-announces a sign-in that finished minutes ago; with `onCompleted` wired to
 * re-send the failed turn (DOR-1650), that is the person's message sent twice.
 *
 * A bare module-level `Set` fixes the remount and breaks something else:
 * `mutationId` restarts at 1 for every new QueryClient, so ids collide between
 * clients and between tests. Keying by client on a `WeakMap` gives each its own
 * namespace and lets the whole entry be collected with the client.
 */
const reportedSignins = new WeakMap<QueryClient, Set<number>>();

/** The set of announced sign-ins for this client, created on first use. */
function reportedFor(client: QueryClient): Set<number> {
  const existing = reportedSignins.get(client);
  if (existing) return existing;
  const created = new Set<number>();
  reportedSignins.set(client, created);
  return created;
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
 * button that does nothing. That refusal is now the FLOOR rather than the
 * experience: a surface that knows it is remote should not offer the sign-in at
 * all — read `useLocalCaller` in `entities/config` and say so instead
 * (DOR-1655). This hook stays honest either way.
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
 * @param options - Which account to sign in, plus an optional `onCompleted`.
 *   Prefer `sessionId` wherever a session exists — the server resolves the
 *   account it is bound to, including for a first turn that failed before
 *   writing a transcript (DOR-1651).
 */
export function useDelegateRuntimeLogin(
  type: string,
  options?: UseDelegateRuntimeLoginOptions
): UseDelegateRuntimeLogin {
  const transport = useTransport();
  const queryClient = useQueryClient();
  const { sessionId, accountRoot, onCompleted } = options ?? {};
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
  // `mutationId` rides along because it names the sign-in itself — the identity
  // the once-only report latches on (see {@link reportedSignins}).
  const shared = useMutationState({
    filters: { mutationKey, exact: true },
    select: (m) => ({
      id: m.mutationId,
      state: m.state as MutationState<DelegatedLoginResult, Error>,
    }),
  });
  const pending = shared.some((s) => s.state.status === 'pending');
  const latest = shared[shared.length - 1];
  const settled = pending ? undefined : latest?.state;
  const settledId = pending ? undefined : latest?.id;

  const failed = !pending && (settled?.status === 'error' || settled?.data?.ok === false);
  const rawError =
    settled?.status === 'error' ? (settled.error?.message ?? null) : (settled?.data?.error ?? null);
  const isSuccess = settled?.data?.ok === true;

  // Held in a ref so a caller passing an inline arrow does not re-run the
  // effect on every render. (That alone would not double-report — the mark
  // below is what guarantees once — but re-running an effect per render to
  // read a flag is noise.)
  const onCompletedRef = useRef(onCompleted);
  onCompletedRef.current = onCompleted;

  useEffect(() => {
    if (!isSuccess || settledId === undefined) return;
    const reported = reportedFor(queryClient);
    if (reported.has(settledId)) return;
    reported.add(settledId);
    onCompletedRef.current?.();
  }, [isSuccess, settledId, queryClient]);

  return {
    // Never start a second attempt while one is running. The pending branch
    // hides the button anyway; this closes the gap for a caller that does not.
    login: () => {
      if (!pending) mutation.mutate();
    },
    isPending: pending,
    isSuccess,
    isError: failed,
    errorMessage: failed ? (rawError ?? 'Sign-in failed. Please try again.') : null,
  };
}
