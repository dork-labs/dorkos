/**
 * The standing Full-autonomy acknowledgement (`ui.autonomyAcknowledgedAt`, spec
 * `trust-dial` decision 5): read it, record it, clear it.
 *
 * One hook because two surfaces need the same answer and must never disagree
 * about it — the Trust Dial, which sends the standing consent with every
 * autonomy change instead of stopping to ask, and Settings, which shows the date
 * back with a way to reset it.
 *
 * The read rides {@link useConfig}, the one config query the cockpit
 * already subscribes to, so nothing here adds a request.
 *
 * @module entities/config/model/use-autonomy-acknowledgement
 */
import { useCallback } from 'react';
import { useConfig } from './use-config';
import { useUpdateConfig } from './use-update-config';

/** What {@link useAutonomyAcknowledgement} hands back. */
export interface AutonomyAcknowledgement {
  /**
   * When this person read what Full autonomy means and asked not to be shown it
   * again (ISO 8601), or `null` when they have not — which is the shipped state
   * and the state a Reset returns them to.
   */
  acknowledgedAt: string | null;
  /** Record the acknowledgement, stamped now. */
  acknowledge: () => void;
  /** Clear it, so the dialog asks again. */
  clear: () => void;
  /**
   * Whether this install can keep a standing acknowledgement at all.
   *
   * False in Obsidian. `DirectTransport` serves the cockpit from an in-process
   * embedded runtime with no config file behind it: its `updateConfig` is a
   * documented no-op (`embedded-mode-stubs.ts`) and its `getConfig` builds no
   * `ui` block at all. So "don't show this again" there would tick, save
   * nothing, raise no error, and ask again forever — the worst shape a setting
   * can take, because the person is told it worked.
   *
   * The absent `ui` block IS the signal, rather than a transport-kind check:
   * whether config round-trips is a property of the backend answering, and a
   * capability read from the answer stays true if embedded mode ever grows real
   * config. Surfaces that offer the choice must hide it when this is false.
   */
  canRemember: boolean;
  /** Whether a write is in flight. */
  isPending: boolean;
}

/**
 * Read and write the standing Full-autonomy acknowledgement.
 *
 * Writes are fire-and-forget. A failed write leaves the person exactly where
 * they were — being asked again next time — which is the safe direction for
 * both operations: a failed `acknowledge` keeps the dialog, and a failed `clear`
 * keeps a consent they did give.
 */
export function useAutonomyAcknowledgement(): AutonomyAcknowledgement {
  const { data: config } = useConfig();
  const updateConfig = useUpdateConfig();

  const acknowledge = useCallback(() => {
    updateConfig.mutate({ ui: { autonomyAcknowledgedAt: new Date().toISOString() } });
  }, [updateConfig]);

  const clear = useCallback(() => {
    updateConfig.mutate({ ui: { autonomyAcknowledgedAt: null } });
  }, [updateConfig]);

  return {
    acknowledgedAt: config?.ui?.autonomyAcknowledgedAt ?? null,
    acknowledge,
    clear,
    // Undefined while the query is still in flight, which reads as "cannot
    // remember" — the honest direction for the frame before the answer arrives.
    // Offering the choice and withdrawing it a tick later is worse than
    // withholding it and letting it appear.
    canRemember: config?.ui !== undefined,
    isPending: updateConfig.isPending,
  };
}
