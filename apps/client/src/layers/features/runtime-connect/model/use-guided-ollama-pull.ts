/**
 * Guided Ollama pull hooks (ADR-0318, effortless-runtime-switching T2 task 3.6).
 *
 * The client half of the guided, hardware-aware model pull. Two pieces:
 * - {@link useOllamaModelCatalog}: the curated coding-model catalog assessed
 *   against this machine (honest sizing + a static fit verdict), from the T2
 *   server endpoint (task 3.5).
 * - {@link useGuidedOllamaPull}: trigger a single streamed pull of a curated
 *   model and, on completion, connect OpenCode to it with ZERO auth (record the
 *   Ollama provider) and invalidate `['requirements']` so OpenCode flips to
 *   Ready — the same zero-auth landing as the already-pulled path
 *   ({@link useConnectOllama}), reached after the download instead of before it.
 *
 * DorkOS only detects + triggers a pull; it never owns or manages Ollama.
 *
 * @module features/runtime-connect/model/use-guided-ollama-pull
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  OllamaModelCatalog,
  OllamaPullProgress,
  OllamaPullResult,
} from '@dorkos/shared/runtime-connect';
import { REQUIREMENTS_KEY } from '@/layers/entities/runtime';
import { useTransport } from '@/layers/shared/model';
import { OLLAMA_PROVIDER_ID } from './use-opencode-provider';

/**
 * Fetch the curated coding-model catalog, each entry assessed against this
 * machine's hardware with an honest fit verdict (`runs-well | may-be-slow |
 * too-large`). A static estimate, never a benchmark.
 *
 * Gated by `enabled` so it only probes when the guided-pull surface is shown
 * (Ollama running, no coding model pulled). Cached with a short stale window so
 * re-opening the picker is instant without re-probing hardware.
 *
 * @param enabled - Whether to fetch the catalog (true when the guided pull is shown).
 */
export function useOllamaModelCatalog(enabled: boolean) {
  const transport = useTransport();
  return useQuery<OllamaModelCatalog>({
    queryKey: ['runtime-connect', 'ollama', 'catalog'],
    queryFn: () => transport.getOllamaModelCatalog(),
    enabled,
    staleTime: 60_000,
  });
}

/** Result of {@link useGuidedOllamaPull}: the pull mutation plus its latest progress frame. */
export interface UseGuidedOllamaPull {
  /** Trigger the guided pull of `model`. Idempotent to re-call after a failure (retry). */
  pull: (model: string) => void;
  /** True while the model is downloading (or being connected on completion). */
  isPending: boolean;
  /**
   * True when the pull failed — either a thrown error (network/HTTP) or an
   * honest `{ ok: false }` result (a stream error, a non-2xx, a failed pull).
   */
  isError: boolean;
  /** Honest, retryable failure message for the Connect surface, or `null`. */
  errorMessage: string | null;
  /** The most recent streamed download-progress frame, or `null` before the first. */
  progress: OllamaPullProgress | null;
  /** Terminal result once resolved (may carry `ok: false`), or `undefined`. */
  result: OllamaPullResult | undefined;
}

/**
 * Pull a curated Ollama model, then connect OpenCode to it with zero auth.
 *
 * On a successful pull the hook records `runtimes.opencode.provider = 'ollama'`
 * (no secret — the honest, private, free path, identical to
 * {@link useConnectOllama}) and invalidates `['requirements']`, so OpenCode
 * flips to Ready with no manual "Check again". A failed pull never connects and
 * never flips the UI to Ready — it surfaces one honest, retryable error.
 */
export function useGuidedOllamaPull(): UseGuidedOllamaPull {
  const transport = useTransport();
  const queryClient = useQueryClient();
  const [progress, setProgress] = useState<OllamaPullProgress | null>(null);

  const mutation = useMutation({
    mutationFn: async (model: string) => {
      setProgress(null);
      const result = await transport.pullOllamaModel(model, (frame) => setProgress(frame));
      // Only connect on a genuinely successful pull — an honest `{ ok: false }`
      // stops here so the surface shows a retryable error, never a false Ready.
      if (result.ok) {
        await transport.updateConfig({
          runtimes: { opencode: { provider: OLLAMA_PROVIDER_ID } },
        });
      }
      return result;
    },
    onSuccess: (result) => {
      if (result.ok) {
        void queryClient.invalidateQueries({ queryKey: [...REQUIREMENTS_KEY] });
      }
    },
  });

  const failed = mutation.isError || mutation.data?.ok === false;
  const errorMessage = mutation.isError
    ? (mutation.error as Error).message
    : (mutation.data?.error ?? null);

  return {
    pull: (model: string) => mutation.mutate(model),
    isPending: mutation.isPending,
    isError: failed,
    errorMessage: failed ? (errorMessage ?? 'The pull could not be completed.') : null,
    progress,
    result: mutation.data,
  };
}
