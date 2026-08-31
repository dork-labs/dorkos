/**
 * Dims the desktop shell's chrome when the window loses focus (DOR-254).
 *
 * Native mac apps do this — Linear included — as a small but real signal for
 * which window is the active one when several are open. `index.css` scopes
 * the actual dimming to `.desktop-darwin.window-blurred`, so this is a no-op
 * everywhere else (the browser cockpit, Obsidian, and Windows/Linux desktop —
 * macOS is the only platform where this reads as idiomatic).
 *
 * **Deliberately NOT the document's own `window` `focus`/`blur` events.**
 * Those answer "does this DOCUMENT have DOM focus", not "does this WINDOW
 * have OS focus" — and they diverge the moment the cockpit hosts an
 * `<iframe>` (an MCP app frame, an embedded browser/canvas). Clicking into
 * one moves DOM focus into the frame and fires the outer document's `blur`
 * with no OS-level focus change at all, which would dim the whole app for
 * the rest of the session the first time someone used either surface. Only
 * the main process can answer the OS-level question, over
 * `window.electronAPI.onFocusChange` (see `apps/desktop/src/main/window-focus`).
 *
 * @module app/use-window-focus-dimming
 */
import { useEffect } from 'react';
import { isDesktopDarwin } from '@/layers/shared/lib';

/** Class toggled on `<html>` while the window does not have OS focus. */
export const WINDOW_BLURRED_CLASS = 'window-blurred';

/**
 * Subscribe once on mount to `window.electronAPI.onFocusChange` and reflect
 * it as {@link WINDOW_BLURRED_CLASS} on `document.documentElement`, then pull
 * the current state right after (the same replay-on-mount shape as
 * {@link import('./use-electron-fullscreen').useElectronFullscreen}), so a
 * renderer that mounts — or remounts — while the window already lacks focus
 * still dims. Unsubscribes — and clears the class — on unmount.
 *
 * Gated on {@link isDesktopDarwin} rather than just relying on the CSS scope:
 * the browser cockpit and Obsidian have no reason to carry a focus
 * subscription that does nothing, and `window.electronAPI.onFocusChange` is
 * absent there anyway.
 *
 * The replay is guarded against two races, both against the same fact:
 * `getFocusState` is an async round-trip. A fast unmount before it resolves
 * must not set a class nothing is reading — and a real `onFocusChange` event
 * landing WHILE the replay is still in flight must not have its answer
 * clobbered a moment later by the replay's older one resolving after it.
 *
 * Mounted once by {@link AppShell}, alongside the other desktop-shell hooks.
 */
export function useWindowFocusDimming(): void {
  useEffect(() => {
    if (!isDesktopDarwin) return;
    if (!window.electronAPI?.onFocusChange) return;

    const root = document.documentElement;
    const applyFocusState = (focused: boolean): void => {
      root.classList.toggle(WINDOW_BLURRED_CLASS, !focused);
    };

    let live = true;
    let sawLiveUpdate = false;

    const unsubscribe = window.electronAPI.onFocusChange((focused) => {
      sawLiveUpdate = true;
      applyFocusState(focused);
    });

    void window.electronAPI.getFocusState?.().then((focused) => {
      if (live && !sawLiveUpdate) applyFocusState(focused);
    });

    return () => {
      live = false;
      unsubscribe();
      root.classList.remove(WINDOW_BLURRED_CLASS);
    };
  }, []);
}
