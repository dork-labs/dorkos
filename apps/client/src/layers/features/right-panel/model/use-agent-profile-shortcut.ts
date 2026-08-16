import { useEffect } from 'react';
import { useAppStore } from '@/layers/shared/model';
import { PROFILE_PANEL_ID } from '@/layers/features/profile';

/**
 * Register the `Cmd+Shift+A` / `Ctrl+Shift+A` key handler that toggles the
 * profile in the right panel for the currently selected agent.
 *
 * Toggle behavior:
 * - If the right panel is open and showing the Profile tab → close the panel.
 * - Otherwise → switch to the Profile tab and open the panel.
 *
 * Follows the same document-level listener pattern as useRightPanelShortcut.
 */
export function useAgentProfileShortcut(): void {
  const setRightPanelOpen = useAppStore((s) => s.setRightPanelOpen);
  const setActiveRightPanelTab = useAppStore((s) => s.setActiveRightPanelTab);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === 'A') {
        e.preventDefault();
        const { rightPanelOpen, activeRightPanelTab } = useAppStore.getState();
        if (rightPanelOpen && activeRightPanelTab === PROFILE_PANEL_ID) {
          setRightPanelOpen(false);
        } else {
          setActiveRightPanelTab(PROFILE_PANEL_ID);
          setRightPanelOpen(true);
        }
      }
    };

    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [setRightPanelOpen, setActiveRightPanelTab]);
}
