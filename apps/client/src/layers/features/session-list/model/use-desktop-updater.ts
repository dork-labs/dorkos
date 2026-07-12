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
  /** Latest actionable updater status, or `null` until a `downloading`/`downloaded` event arrives. */
  status: DesktopUpdateStatus | null;
  /** Restart the app to install a downloaded update. */
  restart: () => void;
}

/**
 * Fold a new status into the current one, keeping the card stable.
 *
 * Only `downloading`/`downloaded` are actionable (the card renders them). A
 * transient status (`checking`/`available`/`not-available`/`error`) must not
 * clear an already-showing card — the 4h background re-check emits
 * `checking`→`available`, which would otherwise blink a `downloaded` card out.
 * A genuinely newer download (`downloading`/`downloaded`) may replace it.
 */
function foldStatus(
  prev: DesktopUpdateStatus | null,
  next: DesktopUpdateStatus
): DesktopUpdateStatus | null {
  if (next.state === 'downloading' || next.state === 'downloaded') return next;
  if (prev && (prev.state === 'downloading' || prev.state === 'downloaded')) return prev;
  return next;
}

/**
 * Subscribe to the desktop native updater so the sidebar can show an in-app
 * "restart to install" card instead of the web/npm upgrade command (which
 * doesn't apply to a packaged `.app`).
 *
 * On mount it also replays the last actionable status via `getUpdateStatus`
 * (the analogue of `useElectronNavigate` pulling `getPendingNavigate`), so a
 * window recreated after `update-downloaded` fired still recovers the waiting
 * update. In the browser and Obsidian `window.electronAPI` is absent, so
 * `isDesktop` is `false`, `status` stays `null`, and the caller falls back to
 * the web upgrade card. Unsubscribes on unmount.
 */
export function useDesktopUpdater(): DesktopUpdater {
  const isDesktop = typeof window !== 'undefined' && !!window.electronAPI?.onUpdateStatus;
  const [status, setStatus] = useState<DesktopUpdateStatus | null>(null);

  useEffect(() => {
    const api = window.electronAPI;
    if (!api?.onUpdateStatus) return;

    const unsubscribe = api.onUpdateStatus((next) => {
      setStatus((prev) => foldStatus(prev, next));
    });

    // Replay a status that fired before this renderer subscribed (macOS
    // close→reopen mounts a fresh React tree). Mirrors useElectronNavigate.
    void api.getUpdateStatus?.().then((replayed) => {
      if (replayed) setStatus((prev) => foldStatus(prev, replayed));
    });

    return unsubscribe;
  }, []);

  const restart = useCallback(() => {
    window.electronAPI?.restartToUpdate?.();
  }, []);

  return { isDesktop, status, restart };
}
