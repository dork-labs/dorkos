/**
 * The one trust-stop write path Settings has (spec `trust-dial`, decision 6).
 *
 * The global row and every per-runtime row change the same setting, and they
 * change it under the same consent contract: ask before Full autonomy, send the
 * acknowledgement with the stop, invalidate everything that reads config, show
 * the server's refusal in the server's own words. Written twice, that contract
 * drifts — so it is written once, here, and both rows call it.
 *
 * It lives in `features/settings/model` rather than in a shared layer because it
 * is one feature's own business logic. Same-feature model sharing is what the
 * FSD rules allow; a cross-FEATURE model import is what they forbid.
 *
 * @module features/settings/model/use-trust-stop-writes
 */
import { useCallback, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { PermissionModeDescriptor, PermissionStop } from '@dorkos/shared/agent-runtime';
import { resolveTrustStops } from '@/layers/shared/lib';
import {
  configKeys,
  useAutonomyAcknowledgement,
  useConfig,
  useUpdateConfig,
} from '@/layers/entities/config';
import { settingsForRuntime, useRuntimeCapabilities } from '@/layers/entities/runtime';

/**
 * A Full-autonomy default waiting on the dialog: which runtime it is for
 * (`null` = the global setting), and the mode whose promise the dialog reads
 * out.
 *
 * Held by the hook rather than by the row, because consent is a conversation
 * with the SERVER — the config route refuses this write without an
 * acknowledgement, and the hook is what makes the write.
 */
export interface PendingAutonomyDefault {
  /** The runtime whose setting is being changed, or `null` for the global one. */
  runtime: string | null;
  /** That runtime's own mode at the autonomy stop, for the dialog to read out. */
  descriptor: PermissionModeDescriptor;
}

/** What {@link useTrustStopWrites} hands back. */
export interface TrustStopWrites {
  /**
   * Change where new sessions start, asking first when that is Full autonomy
   * and this person has no standing acknowledgement.
   *
   * @param forRuntime - Which runtime's setting, or `null` for the global one.
   * @param stop - The stop to store, or `null` to return a runtime to the
   *   global setting. A `null` is never Full autonomy, so it never asks.
   */
  changeTrustStop: (forRuntime: string | null, stop: PermissionStop | null) => void;
  /** The change waiting on the dialog, or `null` when nothing is waiting. */
  pendingAutonomy: PendingAutonomyDefault | null;
  /** The person read what Full autonomy means and said yes. */
  confirmAutonomy: () => void;
  /** They said no. Nothing was written, so nothing has to be undone. */
  cancelAutonomy: () => void;
  /** The last write failure, in the server's own words, or `null`. */
  writeError: string | null;
  /** Dismiss {@link TrustStopWrites.writeError}. */
  clearWriteError: () => void;
  /** Whether a write is in flight. */
  isPending: boolean;
}

/** Turn a failed config write into one sentence a person can act on. */
function describeWriteFailure(err: unknown): string {
  return (err instanceof Error && err.message) || 'Could not save that. Try again.';
}

/**
 * Write trust stops — global and per runtime — through one consent contract.
 *
 * Set-time is consent-time (spec `trust-dial`, decision 6): the acknowledgement
 * given here is what lets every session this default births start bypassed
 * without meeting the dialog again. So a change to Full autonomy stages itself
 * instead of writing, the caller renders the dialog off
 * {@link TrustStopWrites.pendingAutonomy}, and confirming sends the
 * acknowledgement and the stop together.
 *
 * **The server's refusal is the backstop, not this dialog.** Both lookups below
 * read the capability map, and a map still in flight answers neither: a
 * per-runtime change has no section to write into and does nothing (the cards
 * disable their rows through that window for the same reason), and a global
 * change to Full autonomy finds no descriptor, skips the dialog, and goes to the
 * server without an acknowledgement — where the config route refuses it with
 * `428 AUTONOMY_ACK_REQUIRED` and the refusal surfaces as
 * {@link TrustStopWrites.writeError}. Full autonomy is never granted by this
 * hook failing to ask; the worst that window can produce is an error where a
 * dialog belonged.
 */
export function useTrustStopWrites(): TrustStopWrites {
  const { data: config } = useConfig();
  const { data: capabilityMap } = useRuntimeCapabilities();
  const updateConfig = useUpdateConfig();
  const queryClient = useQueryClient();
  const autonomyAck = useAutonomyAcknowledgement();
  const [writeError, setWriteError] = useState<string | null>(null);
  const [pendingAutonomy, setPendingAutonomy] = useState<PendingAutonomyDefault | null>(null);

  const defaultRuntime = config?.executionDefaults?.runtime ?? 'claude-code';

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
        },
        onError: (err) => setWriteError(describeWriteFailure(err)),
      });
    },
    [updateConfig, queryClient]
  );

  /** The `runtimes` patch that sets one trust stop — global when `forRuntime` is null. */
  const trustStopPatch = useCallback(
    (forRuntime: string | null, stop: PermissionStop | null): Record<string, unknown> | null => {
      if (forRuntime === null) return { defaultTrustStop: stop };
      const section = settingsForRuntime(capabilityMap, forRuntime)?.configSection;
      return section ? { [section]: { defaultTrustStop: stop } } : null;
    },
    [capabilityMap]
  );

  /** The mode a runtime declares at its autonomy stop, if it declares one. */
  const autonomyDescriptorFor = useCallback(
    (runtimeType: string): PermissionModeDescriptor | undefined => {
      const declared = capabilityMap?.capabilities[runtimeType]?.permissionModes?.values ?? [];
      return resolveTrustStops(declared).find((s) => s.stop === 'autonomy')?.mode;
    },
    [capabilityMap]
  );

  const changeTrustStop = useCallback(
    (forRuntime: string | null, stop: PermissionStop | null) => {
      const patch = trustStopPatch(forRuntime, stop);
      if (!patch) return;
      if (stop === 'autonomy' && autonomyAck.acknowledgedAt === null) {
        // The runtime whose promise the dialog reads out: the one being changed,
        // or the runtime a new session would land on when the choice is global.
        // Its own sentence, never copy written here — what Full autonomy means
        // differs by agent, and a stand-in would be wrong for somebody.
        const descriptor = autonomyDescriptorFor(forRuntime ?? defaultRuntime);
        if (descriptor) {
          setPendingAutonomy({ runtime: forRuntime, descriptor });
          return;
        }
      }
      writeConfig({ runtimes: patch });
    },
    [trustStopPatch, autonomyAck.acknowledgedAt, autonomyDescriptorFor, defaultRuntime, writeConfig]
  );

  /**
   * Record the acknowledgement and the new default TOGETHER.
   *
   * One request, not two: the server refuses the stop without an
   * acknowledgement, so two requests would race — the stop could land first and
   * bounce — and one patch has no such window. Any refactor that splits this is
   * a defect.
   */
  const confirmAutonomy = useCallback(() => {
    if (!pendingAutonomy) return;
    const patch = trustStopPatch(pendingAutonomy.runtime, 'autonomy');
    setPendingAutonomy(null);
    if (!patch) return;
    writeConfig({
      ui: { autonomyAcknowledgedAt: new Date().toISOString() },
      runtimes: patch,
    });
  }, [pendingAutonomy, trustStopPatch, writeConfig]);

  const cancelAutonomy = useCallback(() => setPendingAutonomy(null), []);
  const clearWriteError = useCallback(() => setWriteError(null), []);

  return {
    changeTrustStop,
    pendingAutonomy,
    confirmAutonomy,
    cancelAutonomy,
    writeError,
    clearWriteError,
    isPending: updateConfig.isPending,
  };
}
