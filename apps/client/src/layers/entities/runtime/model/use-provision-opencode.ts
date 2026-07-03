/**
 * On-demand OpenCode provisioning — the client half of the one-click install
 * (ADR-0317). Wraps `transport.provisionOpenCode` in a TanStack Query mutation,
 * captures streamed progress frames, and on success invalidates the shared
 * `['requirements']` key so OpenCode flips to Ready with no manual "Check
 * again".
 *
 * @module entities/runtime/model/use-provision-opencode
 */
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTransport } from '@/layers/shared/model';
import type { RuntimeProvisionProgress, RuntimeProvisionResult } from '@dorkos/shared/transport';
import { REQUIREMENTS_KEY } from './use-runtime-requirements';

/** Result of {@link useProvisionOpenCode}: the mutation plus the latest progress frame. */
export interface UseProvisionOpenCode {
  /** Trigger the install. Idempotent to re-call after a failure (retry). */
  provision: () => void;
  /** True while the installer is running. */
  isPending: boolean;
  /**
   * True when provisioning failed — either a thrown error (network/HTTP) or an
   * honest `{ ok: false }` result (installer non-zero exit, cleaned up).
   */
  isError: boolean;
  /** Honest failure message for the Connect surface, or `null` when not failed. */
  errorMessage: string | null;
  /** The most recent streamed progress frame, or `null` before the first frame. */
  progress: RuntimeProvisionProgress | null;
  /** Terminal result once resolved (may carry `ok: false`), or `undefined`. */
  result: RuntimeProvisionResult | undefined;
}

/**
 * Provision the OpenCode runtime binary on demand.
 *
 * The mutation resolves to a {@link RuntimeProvisionResult}: a thrown error and
 * a resolved `{ ok: false }` are both treated as failure so the Connect surface
 * can show one honest, retryable error path. Only a successful (`ok: true`)
 * result invalidates `['requirements']`, so a failed install never flips the
 * UI to Ready.
 */
export function useProvisionOpenCode(): UseProvisionOpenCode {
  const transport = useTransport();
  const queryClient = useQueryClient();
  const [progress, setProgress] = useState<RuntimeProvisionProgress | null>(null);

  const mutation = useMutation({
    mutationFn: () => {
      setProgress(null);
      return transport.provisionOpenCode((frame) => setProgress(frame));
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
    provision: () => mutation.mutate(),
    isPending: mutation.isPending,
    isError: failed,
    errorMessage: failed ? (errorMessage ?? 'Something went wrong.') : null,
    progress,
    result: mutation.data,
  };
}
