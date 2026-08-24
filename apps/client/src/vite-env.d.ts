/// <reference types="vite/client" />

declare global {
  /**
   * The release version this bundle was built from, injected by Vite's `define`
   * (see `vite-define.ts`, which both the web config and the desktop shell's
   * renderer build with). Used as the persisted query cache's buster, so a new
   * build never paints from a previous build's remembered answers.
   *
   * **Declaring a global here is what makes an unsubstituted one compile**, so a
   * bundler that was never given the `define` emits the bare identifier and
   * throws at runtime. That is checked in the emitted bundle by
   * `apps/desktop/scripts/check-renderer-defines.ts`, which reads this file for
   * the names it looks for.
   */
  const __APP_VERSION__: string;

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
    /**
     * Get the port the Express server is listening on, or `null` when it is
     * not serving — during startup, after a crash, between restarts. Mirrors
     * the desktop preload's contract; `null` is a normal answer, and
     * `shared/lib/api-base-url.ts` is where the cockpit decides what to do
     * with it.
     */
    getServerPort(): number | null;
    /** Get the app version string. */
    getAppVersion(): string;
    /** The current platform (darwin, win32, linux). */
    platform: NodeJS.Platform;
    /**
     * Open a URL in the system browser.
     *
     * The reason the seam in `shared/lib/link-navigation.ts` prefers this over
     * `window.open`: at the app's own `http://localhost:<port>` origin the
     * shell turns `window.open` into a second cockpit window, so a promise to
     * leave would not be kept. Only `http`/`https` URLs are opened.
     *
     * @param url - The URL to hand to the browser.
     */
    openExternal(url: string): Promise<void>;
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
     * Subscribe to `Cmd/Ctrl+W` so the renderer can close one of its in-window
     * tabs instead of the whole window (DOR-540). Mirrors the contract in the
     * desktop preload — read that for the authoritative version.
     *
     * **Subscribing is what claims the keystroke**, and the answer decides what
     * happens: return `true` when you closed a tab and the window stays open;
     * return `false` or nothing and the window closes, which is the right
     * answer for the last tab. Throwing, or taking longer than the main
     * process's backstop timeout, also closes the window — so the handler must
     * do its work **synchronously**.
     *
     * **Optional on purpose.** It is absent in the browser cockpit, in the
     * Obsidian embed, and in any desktop build predating the menu item, so
     * every caller must guard on it.
     *
     * @returns An unsubscribe function that removes the listener.
     */
    onCloseTab?(cb: () => boolean | void): () => void;
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
    /**
     * Replay the last actionable update status (`downloading`/`downloaded`),
     * or `null`. Called once on mount right after {@link onUpdateStatus} so a
     * window recreated after `update-downloaded` fired still recovers a
     * waiting update (macOS close→reopen).
     */
    getUpdateStatus(): Promise<DesktopUpdateStatus | null>;
  }

  interface Window {
    electronAPI?: ElectronAPI;
    /**
     * The boot sentinel installed by the inline script in `index.html`
     * (DOR-1451). Absent wherever that document is not the host page — the
     * Obsidian embed, and any test that mounts the app directly — so every
     * caller must guard on it.
     */
    __dorkosBoot?: {
      /**
       * Boot succeeded: cancel the watchdog and stop buffering early errors.
       * Called once, at `main.tsx`'s render call.
       */
      done(): void;
    };
  }
}

export {};
