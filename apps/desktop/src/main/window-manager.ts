import { BrowserWindow } from 'electron';
import { join } from 'node:path';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { app } from 'electron';

/** Persisted window geometry and maximize state. */
interface WindowState {
  x?: number;
  y?: number;
  width: number;
  height: number;
  isMaximized: boolean;
}

const STATE_FILE = join(app.getPath('userData'), 'window-state.json');

/** Load saved window state from disk. Returns defaults on first launch or error. */
function loadWindowState(): WindowState {
  try {
    return JSON.parse(readFileSync(STATE_FILE, 'utf-8'));
  } catch {
    return { width: 1200, height: 800, isMaximized: false };
  }
}

/** Persist current window bounds and maximize state to disk. */
function saveWindowState(win: BrowserWindow): void {
  const isMaximized = win.isMaximized();
  // When maximized, getBounds() returns screen-sized dimensions.
  // Preserve the last known restored bounds so un-maximizing works correctly.
  const state: WindowState = isMaximized
    ? { ...loadWindowState(), isMaximized: true }
    : { ...win.getBounds(), isMaximized: false };
  mkdirSync(app.getPath('userData'), { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(state));
}

/**
 * Create the main BrowserWindow with native macOS styling.
 *
 * @param serverPort - The port the Express server is listening on.
 * @returns The created BrowserWindow instance.
 */
export function createWindow(serverPort: number): BrowserWindow {
  const state = loadWindowState();

  const win = new BrowserWindow({
    ...state,
    minWidth: 800,
    minHeight: 600,
    title: 'DorkOS',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 16 },
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  if (state.isMaximized) win.maximize();

  // In dev: electron-vite sets ELECTRON_RENDERER_URL for HMR
  // In prod: load the built index.html from dist/renderer/
  if (process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'));
  }

  // Persist window geometry when the window is about to close
  win.on('close', () => saveWindowState(win));

  return win;
}
