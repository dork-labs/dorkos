/** Whether the current platform is macOS/iOS (used for shortcut display). */
export const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

/**
 * The noun for "the computer this runs on", adapted to the platform: `this Mac`
 * on macOS, `this computer` everywhere else. Used by the connect surfaces and the
 * model menu so the local-privacy copy ("nothing you type leaves …") reads
 * naturally on each OS.
 */
export function localDeviceNoun(): string {
  return isMac ? 'this Mac' : 'this computer';
}

/**
 * Whether the app is running inside the macOS desktop shell (Electron).
 *
 * Reflects the `desktop-darwin` class the bootstrap script in `index.html`
 * stamps onto `<html>` before first paint (from `window.electronAPI.platform`
 * exposed by the preload script's contextBridge). Drives styling that only
 * makes sense against macOS's frameless window — the drag region and the
 * traffic-light inset — see the `desktop-darwin` custom variant in
 * `index.css`. Chrome that applies to every desktop platform, like the
 * selection-default (DOR-562), instead uses the platform-neutral `desktop`
 * class/variant, which is stamped alongside this one on every OS running the
 * shell.
 */
export const isDesktopDarwin =
  typeof document !== 'undefined' && document.documentElement.classList.contains('desktop-darwin');

/**
 * Whether the cockpit is running inside our own Electron shell, on any platform.
 *
 * A function rather than a module-load constant like {@link isDesktopDarwin}.
 * That one reflects a CSS class stamped before first paint and is read by
 * styling; this one is read by behaviour, so it must not bake in module-load
 * ordering, and a test has to be able to flip surfaces without re-importing.
 *
 * Feature-detects a **method**, not the bridge object — the same rule every
 * other `electronAPI` consumer follows (`api-base-url.ts`,
 * `use-desktop-updater.ts`, `use-electron-navigate.ts`, and `openInBrowser` in
 * `link-navigation.ts`), so a host exposing a partial bridge cannot pass for the
 * whole shell. `getServerPort` is the probe because it is the method the shell
 * has exposed since its first build and never gained a guard —
 * `api-base-url.ts` already asks exactly this of it.
 */
export function isDesktopShell(): boolean {
  return typeof window !== 'undefined' && typeof window.electronAPI?.getServerPort === 'function';
}
