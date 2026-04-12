import { useEffect } from 'react';
import { useAppStore } from '@/layers/shared/model';

/**
 * Register the `Cmd+.` / `Ctrl+.` key handler that toggles the right panel.
 *
 * Follows the same pattern as useCanvasShortcut — a document-level keydown
 * listener that calls the store toggle action.
 */
export function useRightPanelShortcut(): void {
  const toggleRightPanel = useAppStore((s) => s.toggleRightPanel);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === '.') {
        e.preventDefault();
        toggleRightPanel();
      }
    };

    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [toggleRightPanel]);
}
