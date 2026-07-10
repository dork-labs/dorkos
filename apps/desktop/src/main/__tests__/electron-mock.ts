import { vi } from 'vitest';
import type { Display, Rectangle } from 'electron';

/**
 * Test double for Electron's main-process module surface.
 *
 * Mounted via `vi.mock('electron', () => import('./electron-mock'))` in
 * test files. Faithful enough to `app` (including `app.dock`,
 * `setAboutPanelOptions`, and `setAsDefaultProtocolClient`), `BrowserWindow`
 * (including `webContents.send` and a unique `webContents.id`), `ipcMain`
 * (`on`/`handle` as inspectable `vi.fn()`s — tests invoke a registered
 * handler directly from its mock call args), `screen`, `dialog`, `Menu`, and
 * `shell` to drive the main-process code under test without a real Electron
 * runtime.
 */

const DEFAULT_USER_DATA_PATH = '/tmp/dorkos-desktop-test/userData';

/** A minimal ordered event bus: register listeners, then await them all on emit. */
function createEventBus(): {
  on: (event: string, listener: (...args: unknown[]) => unknown) => void;
  off: (event: string, listener: (...args: unknown[]) => unknown) => void;
  emit: (event: string, ...args: unknown[]) => Promise<void>;
  clear: () => void;
} {
  const listeners = new Map<string, Array<(...args: unknown[]) => unknown>>();
  return {
    on(event, listener) {
      const existing = listeners.get(event) ?? [];
      existing.push(listener);
      listeners.set(event, existing);
    },
    off(event, listener) {
      const existing = listeners.get(event);
      if (!existing) return;
      const index = existing.indexOf(listener);
      if (index !== -1) existing.splice(index, 1);
    },
    async emit(event, ...args) {
      for (const listener of [...(listeners.get(event) ?? [])]) {
        await listener(...args);
      }
    },
    clear() {
      listeners.clear();
    },
  };
}

/** Build a fully-populated `Display` fixture; override only the fields a test cares about. */
export function makeDisplay(overrides: Partial<Display> = {}): Display {
  const workArea: Rectangle = overrides.workArea ?? { x: 0, y: 0, width: 1440, height: 900 };
  const bounds: Rectangle = overrides.bounds ?? workArea;
  return {
    id: 1,
    label: '',
    bounds,
    workArea,
    workAreaSize: { width: workArea.width, height: workArea.height },
    size: { width: bounds.width, height: bounds.height },
    scaleFactor: 2,
    rotation: 0,
    internal: true,
    monochrome: false,
    accelerometerSupport: 'unknown',
    touchSupport: 'unknown',
    displayFrequency: 60,
    colorSpace: 'srgb',
    colorDepth: 24,
    depthPerComponent: 8,
    detected: true,
    maximumCursorSize: { width: 0, height: 0 },
    nativeOrigin: { x: 0, y: 0 },
    ...overrides,
  };
}

const PRIMARY_DISPLAY = makeDisplay();

/** Monotonic counter backing each mock window's `webContents.id` — mirrors real Electron's uniqueness guarantee. */
let nextWebContentsId = 1;

class MockBrowserWindowImpl {
  static instances: MockBrowserWindowImpl[] = [];
  static getAllWindows = vi.fn((): MockBrowserWindowImpl[] => MockBrowserWindowImpl.instances);
  static getFocusedWindow = vi.fn(
    (): MockBrowserWindowImpl | null => MockBrowserWindowImpl.instances[0] ?? null
  );

  private readonly bus = createEventBus();
  private maximized = false;
  private minimized = false;
  bounds: Rectangle;
  webContents = { id: nextWebContentsId++, send: vi.fn() };

  constructor(options: Record<string, unknown> = {}) {
    this.bounds = {
      x: typeof options.x === 'number' ? options.x : 0,
      y: typeof options.y === 'number' ? options.y : 0,
      width: typeof options.width === 'number' ? options.width : 1200,
      height: typeof options.height === 'number' ? options.height : 800,
    };
    MockBrowserWindowImpl.instances.push(this);
  }

  on = vi.fn((event: string, listener: (...args: unknown[]) => unknown) => {
    this.bus.on(event, listener);
    return this;
  });
  off = vi.fn((event: string, listener: (...args: unknown[]) => unknown) => {
    this.bus.off(event, listener);
    return this;
  });
  /** Test helper — not part of the real BrowserWindow API. */
  emit = (event: string, ...args: unknown[]): Promise<void> => this.bus.emit(event, ...args);

  focus = vi.fn();
  isDestroyed = vi.fn((): boolean => false);
  restore = vi.fn(() => {
    this.minimized = false;
  });
  minimize = vi.fn(() => {
    this.minimized = true;
  });
  maximize = vi.fn(() => {
    this.maximized = true;
  });
  isMaximized = vi.fn((): boolean => this.maximized);
  isMinimized = vi.fn((): boolean => this.minimized);
  getBounds = vi.fn((): Rectangle => this.bounds);
  setBounds = vi.fn((bounds: Partial<Rectangle>) => {
    this.bounds = { ...this.bounds, ...bounds };
  });
  loadURL = vi.fn();
  loadFile = vi.fn();
}

export const BrowserWindow = MockBrowserWindowImpl;
/** Alias for tests that want to construct/inspect windows without the electron type name. */
export type MockBrowserWindow = MockBrowserWindowImpl;

const appBus = createEventBus();

export const app = {
  isPackaged: false,
  name: 'DorkOS',
  requestSingleInstanceLock: vi.fn((): boolean => true),
  quit: vi.fn(),
  getPath: vi.fn((): string => DEFAULT_USER_DATA_PATH),
  getVersion: vi.fn((): string => '0.1.0'),
  setAboutPanelOptions: vi.fn(),
  setAsDefaultProtocolClient: vi.fn((): boolean => true),
  dock: { setMenu: vi.fn() },
  on: vi.fn((event: string, listener: (...args: unknown[]) => unknown) => {
    appBus.on(event, listener);
    return app;
  }),
  off: vi.fn((event: string, listener: (...args: unknown[]) => unknown) => {
    appBus.off(event, listener);
    return app;
  }),
  /** Test helper — invokes every registered listener for `event`, awaiting async ones. */
  emit: (event: string, ...args: unknown[]): Promise<void> => appBus.emit(event, ...args),
  removeAllListeners: (): void => appBus.clear(),
};

export const ipcMain = {
  on: vi.fn(),
  handle: vi.fn(),
};

export const screen = {
  getAllDisplays: vi.fn((): Display[] => [PRIMARY_DISPLAY]),
  getPrimaryDisplay: vi.fn((): Display => PRIMARY_DISPLAY),
};

export const dialog = {
  showMessageBox: vi.fn(() => Promise.resolve({ response: 0, checkboxChecked: false })),
};

export const Menu = {
  buildFromTemplate: vi.fn((template: unknown) => ({ template })),
  setApplicationMenu: vi.fn(),
};

export const shell = {
  openExternal: vi.fn(),
};

/** Reset all mock state between tests — call from `beforeEach`. */
export function resetElectronMock(): void {
  MockBrowserWindowImpl.instances.length = 0;
  appBus.clear();

  app.isPackaged = false;
  app.requestSingleInstanceLock = vi.fn(() => true);
  app.quit = vi.fn();
  app.getPath = vi.fn(() => DEFAULT_USER_DATA_PATH);
  app.getVersion = vi.fn(() => '0.1.0');
  app.setAboutPanelOptions = vi.fn();
  app.setAsDefaultProtocolClient = vi.fn(() => true);
  app.dock = { setMenu: vi.fn() };

  ipcMain.on = vi.fn();
  ipcMain.handle = vi.fn();

  screen.getAllDisplays = vi.fn(() => [PRIMARY_DISPLAY]);
  screen.getPrimaryDisplay = vi.fn(() => PRIMARY_DISPLAY);

  dialog.showMessageBox = vi.fn(() => Promise.resolve({ response: 0, checkboxChecked: false }));

  Menu.buildFromTemplate = vi.fn((template: unknown) => ({ template }));
  Menu.setApplicationMenu = vi.fn();

  shell.openExternal = vi.fn();
}
