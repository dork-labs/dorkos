import { contextBridge, ipcRenderer } from 'electron';

/**
 * Preload script — runs in a privileged context before the renderer loads.
 *
 * Exposes a minimal API to the renderer via contextBridge.
 * Never expose raw ipcRenderer — only specific invoke/sendSync calls.
 */
contextBridge.exposeInMainWorld('electronAPI', {
  /** Get the port the Express server is listening on (synchronous). */
  getServerPort: (): number => ipcRenderer.sendSync('get-server-port'),
  /** Get the app version from package.json (synchronous). */
  getAppVersion: (): string => ipcRenderer.sendSync('get-app-version'),
  /** The current platform (darwin, win32, linux). */
  platform: process.platform,
  /**
   * Subscribe to main-process navigation requests (menu items, the dock
   * menu, and — Chunk D — `dorkos://` deep links), all funneled through the
   * single `navigate` IPC channel (ADR 260709-210223). `cb` receives the
   * client route path to navigate to.
   *
   * @returns An unsubscribe function that removes the listener.
   */
  onNavigate: (cb: (path: string) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, path: string): void => cb(path);
    ipcRenderer.on('navigate', listener);
    return () => ipcRenderer.removeListener('navigate', listener);
  },
  /**
   * Pending-navigation handoff: also marks this renderer as "ready" for the
   * `navigate` hot path (see `navigation.ts`'s `resolvePendingNavigate`).
   * Called once by `useElectronNavigate` on mount, right after subscribing
   * via `onNavigate` — covers a path requested (menu click, `dorkos://` deep
   * link) before this window's renderer existed or had subscribed yet.
   *
   * @returns The queued path, or `null` if nothing is pending.
   */
  getPendingNavigate: (): Promise<string | null> => ipcRenderer.invoke('get-pending-navigate'),
});
