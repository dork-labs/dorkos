/**
 * OpenCode Local (Ollama) + Direct-provider connect hooks (ADR-0318, T1 task 2.8).
 *
 * The Local path is the zero-auth hero: detect a running Ollama and, when a
 * model is pulled, select it as OpenCode's provider with no account. The Direct
 * path stores an OpenAI-compatible provider key by reference and records the
 * provider + optional base URL. Both invalidate `['requirements']` so OpenCode
 * flips to Ready.
 *
 * @module features/runtime-connect/model/use-opencode-provider
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { OllamaStatus } from '@dorkos/shared/runtime-connect';
import { REQUIREMENTS_KEY } from '@/layers/entities/runtime';
import { useTransport } from '@/layers/shared/model';

/** Provider id recorded when connecting the Local (Ollama) path. */
export const OLLAMA_PROVIDER_ID = 'ollama';

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
    queryKey: ['runtime-connect', 'ollama'],
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
    },
  });

  return {
    connect: (model: string) => mutation.mutate(model),
    isPending: mutation.isPending,
    isSuccess: mutation.isSuccess,
    isError: mutation.isError,
    errorMessage: mutation.isError
      ? ((mutation.error as Error).message ?? 'Could not connect to Ollama.')
      : null,
  };
}

/** Arguments for a Direct-provider connect. */
export interface DirectProviderInput {
  /** OpenAI-compatible provider id, e.g. `openai`. */
  providerId: string;
  /** The raw provider API key. Stored by reference; never returned or cached. */
  key: string;
  /** Optional OpenAI-compatible base URL override. */
  baseURL?: string;
}

/** The Direct-provider connect: store a provider key + optional base URL. */
export interface UseConnectDirectProvider {
  /** Store the key and record the provider + base URL. No-op on empty key. */
  connect: (input: DirectProviderInput) => void;
  /** True while storing. */
  isPending: boolean;
  /** True once stored (before the requirements refetch flips Ready). */
  isSuccess: boolean;
  /** True when the key could not be stored. */
  isError: boolean;
  /** Honest failure message, or `null` when not failed. */
  errorMessage: string | null;
}

/**
 * Connect OpenCode to a direct provider with a pasted key + optional base URL.
 *
 * A single server call stores the key by reference AND records the provider id +
 * base URL (never secrets) in config — one atomic write, not two. On success
 * `['requirements']` is invalidated so OpenCode flips to Ready.
 */
export function useConnectDirectProvider(): UseConnectDirectProvider {
  const transport = useTransport();
  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationFn: ({ providerId, key, baseURL }: DirectProviderInput) =>
      transport.storeProviderCredential(providerId, key, baseURL?.trim() || null),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: [...REQUIREMENTS_KEY] });
    },
  });

  return {
    connect: (input: DirectProviderInput) => {
      if (input.key.trim().length === 0 || input.providerId.trim().length === 0) return;
      mutation.mutate(input);
    },
    isPending: mutation.isPending,
    isSuccess: mutation.isSuccess,
    isError: mutation.isError,
    errorMessage: mutation.isError
      ? ((mutation.error as Error).message ?? 'Could not save the provider key.')
      : null,
  };
}
