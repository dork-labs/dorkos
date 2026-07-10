/**
 * Bridges Electron main-process navigation requests to TanStack Router.
 *
 * The desktop shell drives the client through a single `navigate` IPC
 * channel (ADR 260709-210223): menu items (Settings… `Cmd+,`), the dock
 * menu, and — Chunk D — `dorkos://` deep links all funnel through it. In the
 * browser (and Obsidian) `window.electronAPI` is absent, so this is a no-op
 * there.
 *
 * @module app/use-electron-navigate
 */
import { useEffect } from 'react';
import { useNavigate } from '@tanstack/react-router';

/**
 * Subscribe once on mount to `window.electronAPI.onNavigate` and forward
 * every path it delivers to the router, then pull any pending path queued
 * before this window's renderer existed or had subscribed yet (the
 * pending-navigation handoff — see `getPendingNavigate` and the desktop
 * app's `navigation.ts`). This covers a cold-start `dorkos://` deep link and
 * a Settings… click with zero windows open, both of which would otherwise
 * be dropped by the live `navigate` channel alone. Unsubscribes on unmount.
 *
 * Mounted once by {@link AppShell} — the app shell owns the router.
 */
export function useElectronNavigate(): void {
  const navigate = useNavigate();

  useEffect(() => {
    if (!window.electronAPI?.onNavigate) return;
    const unsubscribe = window.electronAPI.onNavigate((path) => {
      void navigate({ href: path });
    });

    void window.electronAPI.getPendingNavigate?.().then((path) => {
      if (path) void navigate({ href: path });
    });

    return unsubscribe;
  }, [navigate]);
}
