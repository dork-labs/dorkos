/**
 * Lets the desktop shell's `Cmd/Ctrl+W` close a tab instead of the window.
 *
 * The shell's Window menu owns the accelerator and sends a `close-tab` message
 * down; this is the renderer half. It subscribes **only while more than one tab
 * is open**, so the last `Cmd+W` in a window falls through and closes the
 * window, exactly as it does today.
 *
 * Absent everywhere else, and correct there by doing nothing: in the browser
 * cockpit `Cmd/Ctrl+W` belongs to the browser and we must not fight it, and if
 * the desktop half of this contract has not shipped yet, `onCloseTab` is simply
 * missing from the bridge. Both are the same guard.
 *
 * @module app/use-electron-close-tab
 */
import { useEffect } from 'react';
import { useAppTabsStore } from '@/layers/shared/model';
import { useAppTabActions } from '@/layers/features/app-tabs';

/**
 * Subscribe to the desktop shell's Close Tab command while a tab is closeable.
 * Mounted once by {@link AppShell}.
 */
export function useElectronCloseTab(): void {
  const { closeActive } = useAppTabActions();
  const closeable = useAppTabsStore((s) => s.tabs.length > 1);

  useEffect(() => {
    if (!closeable) return;
    const api = window.electronAPI;
    if (!api?.onCloseTab) return;
    return api.onCloseTab(() => closeActive());
  }, [closeable, closeActive]);
}
