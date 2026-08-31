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
 * **Mounted once**, by {@link AppShell} — pass the result down to
 * {@link TitlebarDragStrip} rather than calling this a second time. Each call
 * opens its own IPC subscription and fires its own replay `invoke`, so two
 * mounted call sites means two subscriptions doing identical work.
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
 *
 * The replay is guarded against two races, both against the same fact:
 * `getFullscreenState` is an async round-trip. A fast unmount before it
 * resolves must not let a now-stale answer set state nothing is reading —
 * and a real `onFullscreenChange` event landing WHILE the replay is still in
 * flight must not have its answer clobbered a moment later by the replay's
 * older one resolving after it.
 */
export function useElectronFullscreen(): boolean {
  const [isFullscreen, setIsFullscreen] = useState(false);

  useEffect(() => {
    if (!window.electronAPI?.onFullscreenChange) return;
    let live = true;
    let sawLiveUpdate = false;

    const unsubscribe = window.electronAPI.onFullscreenChange((state) => {
      sawLiveUpdate = true;
      setIsFullscreen(state);
    });

    void window.electronAPI.getFullscreenState?.().then((state) => {
      if (live && !sawLiveUpdate) setIsFullscreen(state);
    });

    return () => {
      live = false;
      unsubscribe();
    };
  }, []);

  return isFullscreen;
}
