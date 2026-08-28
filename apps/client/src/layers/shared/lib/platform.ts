export interface PlatformAdapter {
  /** Whether running inside Obsidian */
  isEmbedded: boolean;
  /** Open a file by path (no-op in standalone) */
  openFile: (path: string) => Promise<void>;
  /**
   * Whether this window has a searchable copy of the message history behind it
   * (DOR-1563).
   *
   * **A capability, not a shell.** It used to be answered by `isEmbedded`, which
   * was right only for as long as no embed could open the index — and that
   * stopped being true when the Obsidian plugin started shipping SQLite. A
   * browser always has one, because there is a server on the other end of the
   * Transport. An embed has one only if it opened a database at bootstrap, which
   * it can fail to do for reasons that have nothing to do with being an embed: a
   * DorkOS that has never run, a database older than message search, an Obsidian
   * whose Electron the plugin carries no SQLite build for.
   *
   * Optional so every host that predates the question keeps the answer it had —
   * see {@link platformCanSearchMessages} for the fallback and why it is safe.
   */
  canSearchMessages?: boolean;
}

// Default: standalone web adapter
const webAdapter: PlatformAdapter = {
  isEmbedded: false,
  openFile: async () => {},
};

let currentAdapter: PlatformAdapter = webAdapter;

/** Replace the active platform adapter (e.g., when running inside Obsidian). */
export function setPlatformAdapter(adapter: PlatformAdapter) {
  currentAdapter = adapter;
}

/** Return the current platform adapter. */
export function getPlatform(): PlatformAdapter {
  return currentAdapter;
}

/**
 * Whether the message-search surfaces should exist in this window (DOR-1563).
 *
 * **The gate for ⌘⇧F and for ⌘K's hand-off row.** A surface that cannot do the
 * thing should not be offered: a search box with no index behind it takes two
 * characters and a debounce to admit it, states four kinds of coverage that are
 * all false, and is advertised from the palette on the way in.
 *
 * A host that does not answer falls back to "a browser can, an embed cannot",
 * which is exactly what this used to be — so every caller that predates the
 * capability keeps the answer it already had, and only a host that has actually
 * opened an index says otherwise.
 *
 * @returns `true` when there is something behind the search box.
 */
export function platformCanSearchMessages(): boolean {
  return currentAdapter.canSearchMessages ?? !currentAdapter.isEmbedded;
}

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
 * exposed by the preload script's contextBridge). Drives the drag-region,
 * traffic-light inset, and desktop selection-default styling — see the
 * `desktop-darwin` custom variant in `index.css`.
 */
export const isDesktopDarwin =
  typeof document !== 'undefined' && document.documentElement.classList.contains('desktop-darwin');

/**
 * Whether the cockpit is running inside our own Electron shell, on any platform.
 *
 * **This is the tab gate** (DOR-568). In-window tabs are a desktop-app feature
 * and nothing else, because a browser already has tabs and ours would be a
 * second strip stacked under the real one — strictly the worse of the two: our
 * tabs cannot be bookmarked one at a time, are not brought back by the browser's
 * own session restore, and cannot be dragged out into their own window. So the
 * tab strip, the tab shortcuts, and "Open in New Window" all ask this first. The
 * Obsidian embed has no bridge and answers `false`, which is also the right
 * answer there: one pane inside someone else's app has nowhere else to put
 * anything.
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
