import { useEffect } from 'react';
import {
  useAppStore,
  useSettingsDeepLink,
  useTasksDeepLink,
  useRelayDeepLink,
} from '@/layers/shared/model';

/**
 * Register the global Cmd+K / Ctrl+K keyboard shortcut to toggle the command palette.
 *
 * Before opening the palette, clears the URL signals for the feature dialogs
 * (settings, tasks, relay, mesh) so a deep-linked dialog does not stay
 * visible behind the palette. Follows the same pattern as the Cmd+B sidebar
 * toggle in App.tsx.
 */
export function useGlobalPalette() {
  const toggleGlobalPalette = useAppStore((s) => s.toggleGlobalPalette);
  const setGlobalPaletteOpen = useAppStore((s) => s.setGlobalPaletteOpen);
  const globalPaletteOpen = useAppStore((s) => s.globalPaletteOpen);

  const { close: closeSettings } = useSettingsDeepLink();
  const { close: closeTasks } = useTasksDeepLink();
  const { close: closeRelay } = useRelayDeepLink();

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        // Close any deep-linked feature dialogs before opening the palette.
        if (!globalPaletteOpen) {
          closeSettings();
          closeTasks();
          closeRelay();
        }
        toggleGlobalPalette();
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [toggleGlobalPalette, closeSettings, closeTasks, closeRelay, globalPaletteOpen]);

  return {
    globalPaletteOpen,
    setGlobalPaletteOpen,
    toggleGlobalPalette,
  };
}
