import { useEffect } from 'react';
import { useAppStore } from '@/layers/shared/model';

/**
 * Hydrate right panel state from localStorage on mount.
 *
 * Calls `loadRightPanelState` once when the component mounts, restoring the
 * persisted open/closed state and active tab for the shell-level right panel.
 */
export function useRightPanelPersistence(): void {
  const loadRightPanelState = useAppStore((s) => s.loadRightPanelState);

  useEffect(() => {
    loadRightPanelState();
  }, [loadRightPanelState]);
}
