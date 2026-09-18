/**
 * OpenCode Local (Ollama) + Direct-provider connect hooks (ADR-0318, T1 task 2.8).
 *
 * The Local path is the zero-auth hero: detect a running Ollama and, when a
 * model is pulled, select it as OpenCode's provider with no account. The Direct
 * path stores an OpenAI-compatible provider key by reference and records the
 * provider + optional base URL. Both invalidate `['requirements']` so OpenCode
 * flips to Ready, and `['models']` so the menu reflects the provider just
 * selected.
 *
 * @module features/runtime-connect/model/use-opencode-provider
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import type {
  CredentialCheckResult,
  OllamaStatus,
  OpenCodeDirectSetup,
} from '@dorkos/shared/runtime-connect';
import { REQUIREMENTS_KEY } from '@/layers/entities/runtime';
import { MODELS_KEY } from '@/layers/shared/lib';
import { useTransport } from '@/layers/shared/model';

/** Provider id recorded when connecting the Local (Ollama) path. */
export const OLLAMA_PROVIDER_ID = 'ollama';

/**
 * TanStack Query key for local Ollama detection. Shared so the guided-install
 * hook can invalidate the exact same key it re-probes on (a completed install
 * must refresh this panel).
 */
export const OLLAMA_DETECTION_KEY = ['runtime-connect', 'ollama'] as const;

/**
 * Detect a local Ollama for the Local path.
 *
 * Bounded server-side; gated by `enabled` so it only probes when the Local tab
 * is active. Cached with a short stale window so re-opening the picker is
 * instant without hammering the probe.
 *
 * @param enabled - Whether to run detection (true when the Local tab is shown).
 */
export function useOllamaDetection(enabled: boolean) {
  const transport = useTransport();
  return useQuery<OllamaStatus>({
    queryKey: OLLAMA_DETECTION_KEY,
    queryFn: () => transport.detectOllama(),
    enabled,
    staleTime: 30_000,
  });
}

/** The zero-auth Local connect: select a detected Ollama model as OpenCode's provider. */
export interface UseConnectOllama {
  /** Select the given local model as OpenCode's provider (no auth). */
  connect: (model: string) => void;
  /** True while the provider selection is being persisted. */
  isPending: boolean;
  /** True once selected (before the requirements refetch flips Ready). */
  isSuccess: boolean;
  /** True when the selection could not be persisted. */
  isError: boolean;
  /** Honest failure message, or `null` when not failed. */
  errorMessage: string | null;
}

/**
 * Connect OpenCode to a local Ollama model with zero auth.
 *
 * Records `runtimes.opencode.provider = 'ollama'` via config (no secret is
 * involved — this is the honest, private, free path) and invalidates
 * `['requirements']` so OpenCode flips to Ready.
 */
export function useConnectOllama(): UseConnectOllama {
  const transport = useTransport();
  const queryClient = useQueryClient();

  const mutation = useMutation({
    // The model is carried for identity/UX; the persisted selection is the
    // provider (per-session model selection lives on the session, not config).
    mutationFn: (_model: string) =>
      transport.updateConfig({ runtimes: { opencode: { provider: OLLAMA_PROVIDER_ID } } }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: [...REQUIREMENTS_KEY] });
      // The catalog changed with the connection: a new provider's models are
      // now offered, and the old ones may not be (DOR-1660).
      void queryClient.invalidateQueries({ queryKey: [...MODELS_KEY] });
    },
  });

  return {
    connect: (model: string) => mutation.mutate(model),
    isPending: mutation.isPending,
    isSuccess: mutation.isSuccess,
    isError: mutation.isError,
    errorMessage: mutation.isError
      ? ((mutation.error as Error).message ?? 'Couldn’t connect to Ollama.')
      : null,
  };
}

/** Arguments for a Direct-provider connect. */
export interface DirectProviderInput {
  /** OpenAI-compatible provider id, e.g. `openai`. */
  providerId: string;
  /**
   * The raw provider API key. Stored by reference; never returned or cached. An
   * EMPTY string means "keep the key already saved" — how a base-URL-only change
   * is expressed without making someone re-paste a key DorkOS already holds.
   */
  key: string;
  /** Optional OpenAI-compatible base URL override. */
  baseURL?: string;
}

/**
 * TanStack Query key for what the "your own key" form already has saved. Shared
 * so a completed save can invalidate the exact key the form reads.
 */
export const OPENCODE_DIRECT_SETUP_KEY = ['runtime-connect', 'opencode', 'direct'] as const;

/**
 * Read back what the "your own key" form should show when it is reopened: the
 * saved service, its base URL, and whether a key is saved (last four characters
 * only). Reopening that form used to show three empty fields, which reads as
 * "nothing is saved" even when something was (DOR-2123).
 */
export function useOpenCodeDirectSetup(): UseQueryResult<OpenCodeDirectSetup> {
  const transport = useTransport();
  return useQuery<OpenCodeDirectSetup>({
    queryKey: OPENCODE_DIRECT_SETUP_KEY,
    queryFn: () => transport.getOpenCodeDirectSetup(),
    // What is saved only changes when this form changes it, and the save
    // invalidates this key — so a re-open inside a session is instant.
    staleTime: 30_000,
  });
}

/** The Test action: try a key against its service, saving nothing. */
export interface UseCheckProviderCredential {
  /** Try the key (or, on an empty key, the saved one). */
  check: (input: DirectProviderInput) => void;
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
 * Try a Direct-provider key without saving anything.
 *
 * It calls the SAME server check a save runs, which is the point: a Test that
 * exercised a different code path would be a Test of nothing.
 */
export function useCheckProviderCredential(): UseCheckProviderCredential {
  const transport = useTransport();

  const mutation = useMutation({
    mutationFn: ({ providerId, key, baseURL }: DirectProviderInput) =>
      transport.checkProviderCredential(
        providerId,
        key.trim().length > 0 ? key : null,
        baseURL?.trim() || null
      ),
    // A refused key is rendered in the form, right where it can be fixed. A
    // toast on top of that is the same news twice, one copy of it out of context.
    meta: { suppressErrorToast: true },
  });

  // A transport/HTTP failure is still an answer the person needs, so it is
  // reported in the same shape rather than as a separate error channel.
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
    check: (input: DirectProviderInput) => mutation.mutate(input),
    isPending: mutation.isPending,
    result,
    // Derived BESIDE the answer, so it is false when there is no answer. Read
    // off the request that produced it rather than off the field as it stands
    // now, because the field may have been edited since.
    checkedSavedKey: result !== null && (mutation.variables?.key ?? '').trim().length === 0,
    reset: mutation.reset,
  };
}

/** Which half of a save is running: the check, or the write. */
export type DirectConnectPhase = 'checking' | 'saving';

/** The Direct-provider connect: check the key, then store it + the base URL. */
export interface UseConnectDirectProvider {
  /** Check the key and, if the service accepts it, store it. */
  connect: (input: DirectProviderInput) => void;
  /** True while checking or storing. */
  isPending: boolean;
  /** Which half is running, so the progress line can say which. */
  phase: DirectConnectPhase | null;
  /** True once stored (before the requirements refetch flips Ready). */
  isSuccess: boolean;
  /** True when the key was refused, or could not be stored. */
  isError: boolean;
  /** Honest failure message, or `null` when not failed. */
  errorMessage: string | null;
  /** Forget the last failure — called when the key field is edited. */
  reset: () => void;
}

/**
 * Connect OpenCode to a direct provider with a pasted key + optional base URL.
 *
 * The key is checked against its own service FIRST and nothing is stored when
 * the service refuses it (DOR-2123). The check is a separate call rather than
 * something inferred from the save's failure, for one reason worth the extra
 * round trip: it lets the surface say "Checking your key…" and then "Saving…"
 * truthfully, and it hands back the service's own plain-language line instead of
 * an HTTP error. The server re-checks on the save regardless — this is the
 * honest progress report, never the enforcement.
 *
 * On success `['requirements']` is invalidated so OpenCode flips to Ready, and
 * the saved-setup query so a reopened form shows what was just saved.
 */
export function useConnectDirectProvider(): UseConnectDirectProvider {
  const transport = useTransport();
  const queryClient = useQueryClient();
  const [phase, setPhase] = useState<DirectConnectPhase | null>(null);

  const mutation = useMutation({
    mutationFn: async ({ providerId, key, baseURL }: DirectProviderInput) => {
      const address = baseURL?.trim() || null;
      setPhase('checking');
      const check = await transport.checkProviderCredential(
        providerId,
        key.trim().length > 0 ? key : null,
        address
      );
      if (!check.ok) return { saved: false as const, message: check.message };
      setPhase('saving');
      await transport.storeProviderCredential(providerId, key, address);
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
      void queryClient.invalidateQueries({ queryKey: [...OPENCODE_DIRECT_SETUP_KEY] });
    },
  });

  const refused = mutation.data?.saved === false;
  return {
    connect: (input: DirectProviderInput) => {
      if (input.providerId.trim().length === 0) return;
      mutation.mutate(input);
    },
    isPending: mutation.isPending,
    phase,
    isSuccess: mutation.data?.saved === true,
    isError: mutation.isError || refused,
    errorMessage: refused
      ? (mutation.data?.message ?? null)
      : mutation.isError
        ? ((mutation.error as Error).message ?? 'Couldn’t save your key.')
        : null,
    reset: mutation.reset,
  };
}
