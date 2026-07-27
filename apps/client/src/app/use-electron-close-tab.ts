/**
 * Lets the desktop shell's `Cmd/Ctrl+W` close a tab instead of the window.
 *
 * The shell's Window menu owns the accelerator; this is the renderer half.
 * Subscribing is what claims the keystroke, and the answer decides the outcome:
 * `true` means a tab closed and the window stays open, anything else means the
 * window closes. So this subscribes for the whole life of the shell and answers
 * truthfully each time, rather than subscribing only while a tab happens to be
 * closeable — the shell relabels the menu item to "Close Tab" while a
 * subscriber exists, and a subscription that came and went with the tab count
 * would make that label flicker between two names for one key.
 *
 * The answer has to be synchronous: the main process races the reply against a
 * backstop timeout and the window wins ties. Closing a tab is a synchronous
 * store write, so the navigation that follows it can settle in its own time.
 *
 * Absent everywhere else, and correct there by doing nothing: in the browser
 * cockpit `Cmd/Ctrl+W` belongs to the browser and we must not fight it, and the
 * Obsidian embed has no shell at all. Both are the same guard.
 *
 * @module app/use-electron-close-tab
 */
import { useEffect } from 'react';
import { useAppTabActions } from '@/layers/features/app-tabs';

/**
 * Subscribe to the desktop shell's Close Tab command. Mounted once by
 * {@link AppShell}.
 */
export function useElectronCloseTab(): void {
  const { closeActive } = useAppTabActions();

  useEffect(() => {
    const api = window.electronAPI;
    if (!api?.onCloseTab) return;
    // `closeActive` reports whether there was a tab to close. On the last tab
    // it answers `false`, which is exactly what lets the window close.
    return api.onCloseTab(() => closeActive());
  }, [closeActive]);
}
