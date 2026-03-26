import { useEffect, useRef } from 'react';
import { useAppStore } from '@/layers/shared/model';
import { usePulseEnabled, useCompletedRunBadge } from '@/layers/entities/pulse';
import { toast } from 'sonner';

/**
 * Manage Pulse completion badge and toast notifications as side effects.
 *
 * - Clears the badge when the Pulse panel opens.
 * - Toasts on new run completions (if notifications are enabled).
 * - Flows the unviewed count into Zustand so `useDocumentTitle` can render it.
 */
export function usePulseNotifications(): void {
  const pulseEnabled = usePulseEnabled();
  const { unviewedCount, clearBadge } = useCompletedRunBadge(pulseEnabled);
  const enablePulseNotifications = useAppStore((s) => s.enablePulseNotifications);
  const pulseOpen = useAppStore((s) => s.pulseOpen);
  const { setPulseOpen } = useAppStore();
  const setPulseBadgeCount = useAppStore((s) => s.setPulseBadgeCount);

  // Clear completion badge when Pulse panel opens
  useEffect(() => {
    if (pulseOpen) clearBadge();
  }, [pulseOpen, clearBadge]);

  // Toast on new run completions
  const prevUnviewedRef = useRef(0);
  useEffect(() => {
    if (!enablePulseNotifications) return;
    if (unviewedCount > prevUnviewedRef.current) {
      toast('Pulse run completed', {
        description: 'A scheduled run has finished.',
        duration: 6000,
        action: {
          label: 'View history',
          onClick: () => setPulseOpen(true),
        },
      });
    }
    prevUnviewedRef.current = unviewedCount;
  }, [unviewedCount, enablePulseNotifications, setPulseOpen]);

  // Flow badge count to Zustand so useDocumentTitle can render it
  useEffect(() => {
    setPulseBadgeCount(unviewedCount);
    return () => setPulseBadgeCount(0);
  }, [unviewedCount, setPulseBadgeCount]);
}
