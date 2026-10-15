/**
 * The one trust-stop write path Settings has (spec `trust-dial`, decision 6).
 *
 * The global row and every per-runtime row change the same setting, and they
 * change it under the same contract: write the stop straight through (Full
 * autonomy included, ADR 261006-225605), invalidate everything that reads
 * config, show the server's refusal in the server's own words. Written twice,
 * that contract drifts — so it is written once, here, and both rows call it.
 *
 * It lives in `features/settings/model` rather than in a shared layer because it
 * is one feature's own business logic. Same-feature model sharing is what the
 * FSD rules allow; a cross-FEATURE model import is what they forbid.
 *
 * @module features/settings/model/use-trust-stop-writes
 */
import { useCallback, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { PermissionStop } from '@dorkos/shared/agent-runtime';
import { configKeys, useUpdateConfig } from '@/layers/entities/config';
import { settingsForRuntime, useRuntimeCapabilities } from '@/layers/entities/runtime';
import { permissionKeys } from '@/layers/entities/permissions';

/** What {@link useTrustStopWrites} hands back. */
export interface TrustStopWrites {
  /**
   * Change where new sessions start.
   *
   * @param forRuntime - Which runtime's setting, or `null` for the global one.
   * @param stop - The stop to store, or `null` to return a runtime to the
   *   global setting.
   */
  changeTrustStop: (forRuntime: string | null, stop: PermissionStop | null) => void;
  /** The last write failure, in the server's own words, or `null`. */
  writeError: string | null;
  /** Dismiss {@link TrustStopWrites.writeError}. */
  clearWriteError: () => void;
  /** Whether a write is in flight. */
  isPending: boolean;
}

/** Turn a failed config write into one sentence a person can act on. */
function describeWriteFailure(err: unknown): string {
  return (err instanceof Error && err.message) || 'Couldn’t save that. Try again.';
}

/**
 * Write trust stops — global and per runtime — through one path.
 *
 * A per-runtime change needs the capability map to know which config section to
 * write; while that map is in flight the change does nothing (the cards disable
 * their rows through that window for the same reason).
 */
export function useTrustStopWrites(): TrustStopWrites {
  const { data: capabilityMap } = useRuntimeCapabilities();
  const updateConfig = useUpdateConfig();
  const queryClient = useQueryClient();
  const [writeError, setWriteError] = useState<string | null>(null);

  /**
   * Persist one whole-config patch.
   *
   * Invalidates the `configKeys.all` PREFIX, not just this surface's key: the status
   * bar, the sidebar badges and `useFeatureEnabled` read config off a broader
   * key set, and the default is applied live by the server, so every reader has
   * to move with the write.
   */
  const writeConfig = useCallback(
    (patch: Record<string, unknown>) => {
      setWriteError(null);
      updateConfig.mutate(patch, {
        onSuccess: () => {
          void queryClient.invalidateQueries({ queryKey: configKeys.all });
          // The stop is also the Permissions page's Files & commands row, and it
          // counts toward "Full power, N changes".
          void queryClient.invalidateQueries({ queryKey: permissionKeys.all });
        },
        onError: (err) => setWriteError(describeWriteFailure(err)),
      });
    },
    [updateConfig, queryClient]
  );

  const changeTrustStop = useCallback(
    (forRuntime: string | null, stop: PermissionStop | null) => {
      if (forRuntime === null) {
        writeConfig({ runtimes: { defaultTrustStop: stop } });
        return;
      }
      const section = settingsForRuntime(capabilityMap, forRuntime)?.configSection;
      if (!section) return;
      writeConfig({ runtimes: { [section]: { defaultTrustStop: stop } } });
    },
    [capabilityMap, writeConfig]
  );

  const clearWriteError = useCallback(() => setWriteError(null), []);

  return {
    changeTrustStop,
    writeError,
    clearWriteError,
    isPending: updateConfig.isPending,
  };
}
