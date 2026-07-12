/**
 * Reads the desktop app's native updater state for the sidebar card.
 *
 * @module features/session-list/model/use-desktop-updater
 */
import { useCallback, useEffect, useState } from 'react';

/** What {@link useDesktopUpdater} exposes to the sidebar footer. */
export interface DesktopUpdater {
  /** True when running inside the desktop shell (the preload bridge is present). */
  isDesktop: boolean;
  /** Latest native updater status, or `null` until the first event arrives. */
  status: DesktopUpdateStatus | null;
  /** Restart the app to install a downloaded update. */
  restart: () => void;
  /** Trigger a foreground "check for updates" (also shows native dialogs). */
  check: () => void;
}

/**
 * Subscribe to the desktop native updater so the sidebar can show an in-app
 * "restart to install" card instead of the web/npm upgrade command (which
 * doesn't apply to a packaged `.app`).
 *
 * In the browser and Obsidian `window.electronAPI` is absent, so `isDesktop`
 * is `false`, `status` stays `null`, and the caller falls back to the web
 * upgrade card. Unsubscribes on unmount.
 */
export function useDesktopUpdater(): DesktopUpdater {
  const isDesktop = typeof window !== 'undefined' && !!window.electronAPI?.onUpdateStatus;
  const [status, setStatus] = useState<DesktopUpdateStatus | null>(null);

  useEffect(() => {
    if (!window.electronAPI?.onUpdateStatus) return;
    return window.electronAPI.onUpdateStatus(setStatus);
  }, []);

  const restart = useCallback(() => {
    window.electronAPI?.restartToUpdate?.();
  }, []);

  const check = useCallback(() => {
    window.electronAPI?.checkForUpdates?.();
  }, []);

  return { isDesktop, status, restart, check };
}
