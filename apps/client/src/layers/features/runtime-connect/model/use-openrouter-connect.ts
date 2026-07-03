/**
 * OpenRouter (OpenCode Gateway) connect hooks (ADR-0318, T1 task 2.8).
 *
 * Three surfaces: the always-available paste-key path, the OAuth-PKCE path (a
 * browser-only, ToS-clean native flow), and the model catalog that populates
 * the picker's dropdown. Every success invalidates `['requirements']` so
 * OpenCode flips to Ready. Keys are never returned or cached — only references
 * are persisted server-side.
 *
 * @module features/runtime-connect/model/use-openrouter-connect
 */
import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { OpenRouterModel } from '@dorkos/shared/runtime-connect';
import { REQUIREMENTS_KEY } from '@/layers/entities/runtime';
import { useTransport } from '@/layers/shared/model';

/** Query key for the OpenRouter model catalog (short-TTL cached server-side too). */
const OPENROUTER_MODELS_KEY = ['runtime-connect', 'openrouter', 'models'] as const;

/**
 * Fetch the OpenRouter model catalog for the Gateway model dropdown.
 *
 * Gated by `enabled` so it only fetches once a key/OAuth connection has
 * populated the picker — never on an unauthenticated cold render.
 *
 * @param enabled - Whether to fetch (true once OpenRouter is connected).
 */
export function useOpenRouterModels(enabled: boolean) {
  const transport = useTransport();
  return useQuery<OpenRouterModel[]>({
    queryKey: [...OPENROUTER_MODELS_KEY],
    queryFn: () => transport.getOpenRouterModels(),
    enabled,
    staleTime: 5 * 60_000,
  });
}

/** The paste-key Gateway connect: validate + store an OpenRouter key. */
export interface UseStoreOpenRouterKey {
  /** Store the pasted OpenRouter key. No-op on empty input. */
  store: (key: string) => void;
  /** True while the key is being validated + stored. */
  isPending: boolean;
  /** True once the key validated and was stored as a reference. */
  isSuccess: boolean;
  /** True when the key was rejected or could not be stored. */
  isError: boolean;
  /** Honest failure message, or `null` when not failed. */
  errorMessage: string | null;
}

/**
 * Validate + store an OpenRouter API key (Gateway paste-key path).
 *
 * The transport resolves `{ ok: false, error }` for an invalid key (not a
 * throw), so both are folded into one honest error path. Only a validated key
 * invalidates `['requirements']` and the model catalog.
 */
export function useStoreOpenRouterKey(): UseStoreOpenRouterKey {
  const transport = useTransport();
  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationFn: (key: string) => transport.storeOpenRouterKey(key),
    onSuccess: (result) => {
      if (result.ok) {
        void queryClient.invalidateQueries({ queryKey: [...REQUIREMENTS_KEY] });
        void queryClient.invalidateQueries({ queryKey: [...OPENROUTER_MODELS_KEY] });
      }
    },
  });

  const failed = mutation.isError || mutation.data?.ok === false;
  const rawError = mutation.isError
    ? (mutation.error as Error).message
    : (mutation.data?.error ?? null);

  return {
    store: (key: string) => {
      if (key.trim().length === 0) return;
      mutation.mutate(key);
    },
    isPending: mutation.isPending,
    isSuccess: mutation.data?.ok === true,
    isError: failed,
    errorMessage: failed ? (rawError ?? 'Could not save the OpenRouter key.') : null,
  };
}

/** The OAuth-PKCE Gateway connect: open the authorize URL, poll to completion. */
export interface UseOpenRouterOAuth {
  /** Begin the flow: mint state, open the authorize URL in a new tab, start polling. */
  begin: () => void;
  /** True from `begin()` until the flow resolves (connected or error). */
  isPending: boolean;
  /** True once the loopback callback exchanged the code for a scoped key. */
  isSuccess: boolean;
  /** True when the flow failed, was denied, or could not start. */
  isError: boolean;
  /** Honest failure message, or `null` when not failed. */
  errorMessage: string | null;
}

/**
 * Run the OpenRouter OAuth-PKCE flow.
 *
 * `begin()` asks the server to mint a verifier + state, opens the returned
 * authorize URL in a new tab, and polls the flow status until it flips to
 * `connected` (invalidating requirements + catalog) or `error`. The
 * `code_verifier` never leaves the server.
 *
 * Browser-only: callers gate this behind `!getPlatform().isEmbedded` and offer
 * the paste-key path instead in the Obsidian embedding (DirectTransport stubs
 * the flow honestly).
 */
export function useOpenRouterOAuth(): UseOpenRouterOAuth {
  const transport = useTransport();
  const queryClient = useQueryClient();
  const [flowState, setFlowState] = useState<string | null>(null);
  const [startError, setStartError] = useState<string | null>(null);

  const start = useMutation({
    mutationFn: () => transport.startOpenRouterOAuth(),
    onMutate: () => setStartError(null),
    onSuccess: ({ authorizeUrl, state }) => {
      window.open(authorizeUrl, '_blank', 'noopener,noreferrer');
      setFlowState(state);
    },
    onError: (err) =>
      setStartError((err as Error).message ?? 'Could not start OpenRouter sign-in.'),
  });

  const statusQuery = useQuery({
    queryKey: ['runtime-connect', 'openrouter', 'oauth', flowState],
    queryFn: () => transport.getOpenRouterOAuthStatus(flowState as string),
    enabled: flowState !== null,
    refetchInterval: (query) => (query.state.data?.status === 'pending' ? 1500 : false),
  });

  const status = statusQuery.data?.status;

  useEffect(() => {
    if (status === 'connected') {
      void queryClient.invalidateQueries({ queryKey: [...REQUIREMENTS_KEY] });
      void queryClient.invalidateQueries({ queryKey: [...OPENROUTER_MODELS_KEY] });
    }
  }, [status, queryClient]);

  const isPending = start.isPending || (flowState !== null && status === 'pending');
  const isError = !!startError || status === 'error';
  const errorMessage = isError
    ? (startError ?? statusQuery.data?.error ?? 'OpenRouter sign-in failed. Please try again.')
    : null;

  return {
    begin: () => start.mutate(),
    isPending,
    isSuccess: status === 'connected',
    isError,
    errorMessage,
  };
}
