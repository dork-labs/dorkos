import { useEffect } from 'react';
import { useAppStore } from '@/layers/shared/model';

/**
 * Register the `Cmd+Shift+A` / `Ctrl+Shift+A` key handler that toggles the
 * agent hub in the right panel for the currently selected agent.
 *
 * Toggle behavior:
 * - If the right panel is open and showing the agent-hub tab → close the panel.
 * - Otherwise → switch to the agent-hub tab and open the panel.
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
        if (rightPanelOpen && activeRightPanelTab === 'agent-hub') {
          setRightPanelOpen(false);
        } else {
          setActiveRightPanelTab('agent-hub');
          setRightPanelOpen(true);
        }
      }
    };

    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [setRightPanelOpen, setActiveRightPanelTab]);
}
