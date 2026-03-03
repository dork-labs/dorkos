import { useEffect } from 'react';
import { useAppStore } from '@/layers/shared/model';

/**
 * Register the global Cmd+K / Ctrl+K keyboard shortcut to toggle the command palette.
 *
 * Also closes any open ResponsiveDialog before opening the palette.
 * Follows the same pattern as the Cmd+B sidebar toggle in App.tsx.
 */
export function useGlobalPalette() {
  const toggleGlobalPalette = useAppStore((s) => s.toggleGlobalPalette);
  const setGlobalPaletteOpen = useAppStore((s) => s.setGlobalPaletteOpen);
  const setSettingsOpen = useAppStore((s) => s.setSettingsOpen);
  const setPulseOpen = useAppStore((s) => s.setPulseOpen);
  const setRelayOpen = useAppStore((s) => s.setRelayOpen);
  const setMeshOpen = useAppStore((s) => s.setMeshOpen);
  const globalPaletteOpen = useAppStore((s) => s.globalPaletteOpen);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        // Close any open feature dialogs before opening the palette
        if (!globalPaletteOpen) {
          setSettingsOpen(false);
          setPulseOpen(false);
          setRelayOpen(false);
          setMeshOpen(false);
        }
        toggleGlobalPalette();
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [toggleGlobalPalette, setSettingsOpen, setPulseOpen, setRelayOpen, setMeshOpen, globalPaletteOpen]);

  return {
    globalPaletteOpen,
    setGlobalPaletteOpen,
    toggleGlobalPalette,
  };
}
