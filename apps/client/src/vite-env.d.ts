/// <reference types="vite/client" />

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
}

declare global {
  interface Window {
    electronAPI?: ElectronAPI;
  }
}

export {};
