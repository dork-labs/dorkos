/**
 * Guided Ollama install hook (spec: opencode-connect-overhaul §13).
 *
 * The client half of the one-click, password-free Ollama install. Wraps
 * `transport.provisionOllama` in a TanStack Query mutation, captures streamed
 * install-progress frames, and on completion invalidates the Ollama detection
 * query so the local panel re-probes — landing in the running panel when Ollama
 * started, or showing honest "now start it" guidance when it installed but is not
 * yet reachable. Mirrors {@link useProvisionRuntime}, adapted to the richer
 * {@link OllamaProvisionResult} (install method + fresh detection re-probe).
 *
 * @module features/runtime-connect/model/use-provision-ollama
 */
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { RuntimeProvisionProgress } from '@dorkos/shared/transport';
import type { OllamaProvisionResult } from '@dorkos/shared/runtime-connect';
import { useTransport } from '@/layers/shared/model';
import { OLLAMA_DETECTION_KEY } from './use-opencode-provider';

/** Result of {@link useProvisionOllama}: the install mutation plus its latest progress frame. */
export interface UseProvisionOllama {
  /** Trigger the guided install. Idempotent to re-call after a failure (retry). */
  provision: () => void;
  /** True while the installer is running. */
  isPending: boolean;
  /**
   * True when the install failed — either a thrown error (network/HTTP) or an
   * honest `{ ok: false }` result (installer non-zero exit, or no one-click path).
   */
  isError: boolean;
  /** Honest, retryable failure message for the Connect surface, or `null`. */
  errorMessage: string | null;
  /** The most recent streamed install-progress frame, or `null` before the first. */
  progress: RuntimeProvisionProgress | null;
  /** Terminal result once resolved (may carry `ok: false`), or `undefined`. */
  result: OllamaProvisionResult | undefined;
}

/**
 * Install Ollama on demand, then re-probe local detection.
 *
 * On a successful install `['runtime-connect', 'ollama']` is invalidated so the
 * local panel refetches: it lands in the running panel when Ollama started, or
 * shows honest guidance to start it when it installed-but-not-running. A failed
 * install never flips the panel — it surfaces one honest, retryable error.
 */
export function useProvisionOllama(): UseProvisionOllama {
  const transport = useTransport();
  const queryClient = useQueryClient();
  const [progress, setProgress] = useState<RuntimeProvisionProgress | null>(null);

  const mutation = useMutation({
    mutationFn: () => {
      setProgress(null);
      return transport.provisionOllama((frame) => setProgress(frame));
    },
    onSuccess: (result) => {
      // Re-probe on any completed install (running or not) so the panel reflects
      // the true post-install state; a failed install leaves detection untouched.
      if (result.ok) {
        void queryClient.invalidateQueries({ queryKey: OLLAMA_DETECTION_KEY });
      }
    },
  });

  const failed = mutation.isError || mutation.data?.ok === false;
  const errorMessage = mutation.isError
    ? (mutation.error as Error).message
    : (mutation.data?.error ?? null);

  return {
    provision: () => mutation.mutate(),
    isPending: mutation.isPending,
    isError: failed,
    errorMessage: failed ? (errorMessage ?? 'Could not install Ollama.') : null,
    progress,
    result: mutation.data,
  };
}
