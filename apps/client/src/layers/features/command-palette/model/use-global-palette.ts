import { useEffect } from 'react';
import { useAppStore, useSettingsDeepLink, useTasksDeepLink } from '@/layers/shared/model';

/**
 * Register the global Cmd+K / Ctrl+K keyboard shortcut to toggle the command palette.
 *
 * Opening the palette first closes the Settings and Tasks dialogs, so neither
 * is left sitting behind it. It closes them through their deep-link `close()`
 * actions, which own *both* halves of a dialog's open signal — the search param
 * and the app-store flag — because `DialogHost` renders on either and clearing
 * one leaves the other holding the dialog up (DOR-839).
 *
 * That means Cmd+K now dismisses a dialog you opened from the sidebar or the
 * palette, not just one you reached by a link. Before, `close()` cleared only
 * the URL, so a store-opened Settings survived the shortcut and stayed on
 * screen behind the palette.
 *
 * Closing the palette leaves both dialogs alone — nothing was opened, so there
 * is nothing to clear.
 */
export function useGlobalPalette() {
  const toggleGlobalPalette = useAppStore((s) => s.toggleGlobalPalette);
  const setGlobalPaletteOpen = useAppStore((s) => s.setGlobalPaletteOpen);
  const globalPaletteOpen = useAppStore((s) => s.globalPaletteOpen);

  const { close: closeSettings } = useSettingsDeepLink();
  const { close: closeTasks } = useTasksDeepLink();

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        // Close any deep-linked feature dialogs before opening the palette.
        if (!globalPaletteOpen) {
          closeSettings();
          closeTasks();
        }
        toggleGlobalPalette();
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [toggleGlobalPalette, closeSettings, closeTasks, globalPaletteOpen]);

  return {
    globalPaletteOpen,
    setGlobalPaletteOpen,
    toggleGlobalPalette,
  };
}
