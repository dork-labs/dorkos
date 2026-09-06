/**
 * Put a test on the desktop surface, or take it off again.
 *
 * `isDesktopShell()` (`shared/lib/platform`) feature-detects a method on the
 * Electron preload bridge, so a test changes surface by installing or removing
 * that bridge — no module mock, no `vi.resetModules()`, and the same signal the
 * real app reads. Every gate this repo puts on the desktop app (the tab strip,
 * the tab shortcuts, "Open in a new window") is provable on both sides in one file
 * because of that.
 *
 * The stub is deliberately partial: one method, the one being probed. A gate
 * that passed only for a complete bridge would be testing the stub.
 *
 * @module test-helpers/desktop-shell
 */

/**
 * Install a minimal Electron preload bridge, so the code under test believes it
 * is in the desktop app. Pair with {@link leaveDesktopShell} in `afterEach`.
 */
export function enterDesktopShell(): void {
  window.electronAPI = { getServerPort: () => 4242 } as unknown as ElectronAPI;
}

/** Remove the bridge, putting the code under test back in a browser. */
export function leaveDesktopShell(): void {
  delete window.electronAPI;
}
