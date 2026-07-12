/// <reference types="vite/client" />

declare global {
  /**
   * Native updater lifecycle, mirrored from the desktop main process over the
   * `update:status` IPC channel (see the desktop app's `auto-updater.ts`,
   * where this union is the source of truth as `UpdateStatus`). The client
   * package can't import from the desktop main process, so this is kept in
   * sync by hand.
   */
  type DesktopUpdateStatus =
    | { state: 'checking' }
    | { state: 'available'; version: string }
    | { state: 'not-available' }
    | { state: 'downloading'; percent: number }
    | { state: 'downloaded'; version: string }
    | { state: 'error'; message: string };

  /** API exposed by the Electron preload script via contextBridge. */
  interface ElectronAPI {
    /** Get the port the Express server is listening on. */
    getServerPort(): number;
    /** Get the app version string. */
    getAppVersion(): string;
    /** The current platform (darwin, win32, linux). */
    platform: NodeJS.Platform;
    /**
     * Subscribe to main-process navigation requests (menu items, dock menu,
     * `dorkos://` deep links — ADR 260709-210223). `cb` receives the client
     * route path to navigate to.
     *
     * @returns An unsubscribe function that removes the listener.
     */
    onNavigate(cb: (path: string) => void): () => void;
    /**
     * Pending-navigation handoff: pulls a path that was requested (menu
     * click, `dorkos://` deep link) before this window's renderer existed or
     * had subscribed to `onNavigate` yet. Read-once — the main process clears
     * it after this resolves, so call it exactly once, right after
     * subscribing.
     *
     * @returns The queued path, or `null` if nothing is pending.
     */
    getPendingNavigate(): Promise<string | null>;
    /**
     * Ask the native updater to run a foreground check (the same path as the
     * "Check for Updates…" menu item). Any outcome arrives via
     * {@link onUpdateStatus}; "up to date" and errors also show a native dialog.
     */
    checkForUpdates(): void;
    /**
     * Restart the app to install a downloaded update — wired to the in-app
     * card's "Restart to install" button. Only meaningful after an
     * {@link onUpdateStatus} `downloaded` event.
     */
    restartToUpdate(): void;
    /**
     * Subscribe to native updater lifecycle events so the in-app sidebar card
     * can reflect them. `cb` receives a {@link DesktopUpdateStatus}.
     *
     * @returns An unsubscribe function that removes the listener.
     */
    onUpdateStatus(cb: (status: DesktopUpdateStatus) => void): () => void;
  }

  interface Window {
    electronAPI?: ElectronAPI;
  }
}

export {};
