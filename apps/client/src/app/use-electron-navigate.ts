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
 * every path it delivers to the router. Unsubscribes on unmount.
 *
 * Mounted once by {@link AppShell} — the app shell owns the router.
 */
export function useElectronNavigate(): void {
  const navigate = useNavigate();

  useEffect(() => {
    if (!window.electronAPI?.onNavigate) return;
    return window.electronAPI.onNavigate((path) => {
      void navigate({ href: path });
    });
  }, [navigate]);
}
