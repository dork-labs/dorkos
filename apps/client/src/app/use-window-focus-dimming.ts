/**
 * Dims the desktop shell's chrome when the window loses focus (DOR-254).
 *
 * Native mac apps do this — Linear included — as a small but real signal for
 * which window is the active one when several are open. This toggles a
 * `window-blurred` class on `<html>` from `window`'s own `focus`/`blur`
 * events; `index.css` scopes the actual dimming to
 * `.desktop-darwin.window-blurred`, so it's a no-op everywhere else (the
 * browser cockpit, Obsidian, and Windows/Linux desktop — macOS is the only
 * platform where this reads as idiomatic).
 *
 * Gated on {@link isDesktopDarwin} rather than just relying on the CSS scope:
 * the browser cockpit and Obsidian have no reason to carry blur/focus
 * listeners that do nothing.
 *
 * @module app/use-window-focus-dimming
 */
import { useEffect } from 'react';
import { isDesktopDarwin } from '@/layers/shared/lib';

/** Class toggled on `<html>` while the window does not have focus. */
export const WINDOW_BLURRED_CLASS = 'window-blurred';

/**
 * Subscribe once on mount to the window's own `focus`/`blur` events and
 * reflect them as {@link WINDOW_BLURRED_CLASS} on `document.documentElement`.
 * Unsubscribes — and clears the class — on unmount.
 *
 * Mounted once by {@link AppShell}, alongside the other desktop-shell hooks.
 */
export function useWindowFocusDimming(): void {
  useEffect(() => {
    if (!isDesktopDarwin) return;

    const root = document.documentElement;
    const onBlur = (): void => root.classList.add(WINDOW_BLURRED_CLASS);
    const onFocus = (): void => root.classList.remove(WINDOW_BLURRED_CLASS);

    window.addEventListener('blur', onBlur);
    window.addEventListener('focus', onFocus);

    return () => {
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('focus', onFocus);
      root.classList.remove(WINDOW_BLURRED_CLASS);
    };
  }, []);
}
