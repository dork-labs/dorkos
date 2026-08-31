/**
 * Tracks whether the desktop shell's window is fullscreen (DOR-563).
 *
 * macOS retracts the traffic lights into the auto-hiding menu bar while a
 * window is fullscreen. `AppShell` and `TitlebarDragStrip` normally reserve
 * space for them (the tab strip's `desktop-darwin:pl-20`, the drag strip's
 * `h-11` band) — this hook is what lets them drop that reservation for as
 * long as fullscreen holds, in the one mode where screen space is the entire
 * point.
 *
 * In the browser and Obsidian `window.electronAPI` is absent, so this always
 * answers `false` there.
 *
 * @module app/use-electron-fullscreen
 */
import { useEffect, useState } from 'react';

/**
 * Subscribe once on mount to `window.electronAPI.onFullscreenChange` and pull
 * the current state right after (the same replay-on-mount shape as
 * {@link import('./use-electron-navigate').useElectronNavigate} pulling
 * `getPendingNavigate`), so a renderer that mounts — or remounts — after the
 * window already entered fullscreen still reflects it. Unsubscribes on
 * unmount.
 */
export function useElectronFullscreen(): boolean {
  const [isFullscreen, setIsFullscreen] = useState(false);

  useEffect(() => {
    if (!window.electronAPI?.onFullscreenChange) return;
    const unsubscribe = window.electronAPI.onFullscreenChange(setIsFullscreen);

    void window.electronAPI.getFullscreenState?.().then(setIsFullscreen);

    return unsubscribe;
  }, []);

  return isFullscreen;
}
