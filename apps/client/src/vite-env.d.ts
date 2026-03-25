/// <reference types="vite/client" />

/** API exposed by the Electron preload script via contextBridge. */
interface ElectronAPI {
  /** Get the port the Express server is listening on. */
  getServerPort(): number;
  /** Get the app version string. */
  getAppVersion(): string;
  /** The current platform (darwin, win32, linux). */
  platform: NodeJS.Platform;
}

declare global {
  interface Window {
    electronAPI?: ElectronAPI;
  }
}

export {};
