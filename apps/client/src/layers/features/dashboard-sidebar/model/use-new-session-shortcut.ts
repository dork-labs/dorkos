/**
 * `⌘N` — the New menu's fast path (BC-45).
 *
 * **Desktop only, and the listener says so.** A browser claims Cmd/Ctrl+N for
 * its own new window before the page ever sees the keydown, so a listener there
 * could not run — and a `preventDefault` it never gets to call would only make
 * the registry's promise ("every chord the panel lists does something") harder
 * to check. Gating the listener on the same flag `SHORTCUTS.NEW_SESSION` marks
 * `desktopOnly` keeps one fact in one place, and is what
 * `shortcuts-registered.test.tsx` proves in both directions.
 *
 * A hook rather than an effect inside `NewMenu` so the chord can be mounted —
 * and fired — without the menu's router, query client and transport around it.
 *
 * @module features/dashboard-sidebar/model/use-new-session-shortcut
 */
import { useEffect } from 'react';
import { isDesktopShell } from '@/layers/shared/lib';

/**
 * Listen for `⌘N` and start a session with it.
 *
 * @param onNewSession - What the chord runs.
 */
export function useNewSessionShortcut(onNewSession: () => void): void {
  useEffect(() => {
    if (!isDesktopShell()) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.shiftKey || event.altKey) return;
      if (event.key.toLowerCase() !== 'n') return;
      event.preventDefault();
      onNewSession();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onNewSession]);
}
