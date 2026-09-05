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
    | { state: 'error'; message: string }
    /**
     * An update was staged, the app restarted for it, and the version that
     * came back up is still the old one. Decided by the main process at
     * launch, from the intent file it wrote before quitting; `attempts` is how
     * many times this same version has failed to land.
     */
    | { state: 'install-failed'; version: string; attempts: number };

  /**
   * How the desktop shell answers "Restart Server" and "Reset All Data",
   * mirrored from the main process's `AdminActionResult` (`main/admin/index.ts`,
   * where this union is the source of truth). Kept in sync by hand, like
   * {@link DesktopUpdateStatus}.
   *
   * A result rather than a rejection because Electron wraps whatever an IPC
   * handler throws — `Error invoking remote method '…': Error: …` — and the
   * whole point of moving these two actions onto the bridge is that neither can
   * put a machine's account of a failure in front of a person again. `message`
   * is written to be read out loud.
   */
  type DesktopAdminResult = { ok: true } | { ok: false; message: string };

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
    /**
     * Restart the DorkOS server through the desktop shell's own supervisor
     * (DOR-542), instead of `POST /api/admin/restart` — which the server refuses
     * whenever a supervisor owns its lifecycle, because it restarts by
     * re-execing itself and there is nothing here to re-exec into.
     *
     * A success usually ends with this window being reloaded onto the restarted
     * server, so the resolved value is mostly read on the way to a failure.
     *
     * **Optional on purpose.** Absent in the browser cockpit, in the Obsidian
     * embed, and in any desktop build predating this — see
     * `shared/lib/desktop-admin.ts`, which is where the choice between this and
     * the HTTP route is made.
     */
    restartServer?(): Promise<DesktopAdminResult>;
    /**
     * Delete everything DorkOS has stored and restart the server on an empty
     * data directory — the desktop half of "Reset All Data". Same optionality
     * and the same reason as {@link restartServer}.
     */
    resetAllData?(): Promise<DesktopAdminResult>;
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
     * @returns `true` if the shell opened it, `false` if its http(s)-only
     * policy declined. A host running an older preload resolves `undefined`,
     * which the seam treats as "no answer" rather than as a decline.
     */
    openExternal(url: string): Promise<boolean>;
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
    /**
     * Report that this window really came up, to the desktop shell's renderer
     * supervisor (DOR-1453). Silence past its deadline is what makes it reload
     * the window, and eventually replace it with a static recovery page.
     *
     * **Called from one place only** — the boot sentinel's `done()` in
     * `index.html` — so the shell and the sentinel cannot end up with two
     * different definitions of "the app is up". Nothing else in the client
     * should call it.
     *
     * **Optional on purpose.** Absent in the browser cockpit, in the Obsidian
     * embed, and in any desktop build predating the supervisor.
     */
    reportAlive?(): void;
    /**
     * Subscribe to this window's fullscreen state (DOR-563). macOS retracts
     * the traffic lights into the auto-hiding menu bar while fullscreen
     * holds, so the renderer drops the space it otherwise reserves for them.
     *
     * **Optional on purpose.** Absent in the browser cockpit, in the
     * Obsidian embed, and in any desktop build predating this.
     *
     * @returns An unsubscribe function that removes the listener.
     */
    onFullscreenChange?(cb: (isFullScreen: boolean) => void): () => void;
    /**
     * Whether this window is fullscreen right now. Called once on mount right
     * after {@link onFullscreenChange}, so a renderer that mounts (or
     * remounts) after the window already entered fullscreen still recovers
     * the current state.
     */
    getFullscreenState?(): Promise<boolean>;
    /**
     * Subscribe to this window's OS-level focus state (DOR-254). Deliberately
     * the window's own `focus`/`blur`, not the document's: clicking into an
     * `<iframe>` the cockpit hosts (an MCP app frame, an embedded browser)
     * fires the document's own DOM `blur` with no OS focus change at all, so
     * only the main process can answer this correctly.
     *
     * **Optional on purpose.** Absent in the browser cockpit, in the
     * Obsidian embed, and in any desktop build predating this.
     *
     * @returns An unsubscribe function that removes the listener.
     */
    onFocusChange?(cb: (isFocused: boolean) => void): () => void;
    /**
     * Whether this window has OS focus right now. Called once on mount right
     * after {@link onFocusChange}, so a renderer that mounts (or remounts)
     * while the window already lacks focus still recovers the current state.
     */
    getFocusState?(): Promise<boolean>;
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
