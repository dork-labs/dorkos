import { vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type {
  Display,
  HandlerDetails,
  MessageBoxOptions,
  MessageBoxReturnValue,
  Rectangle,
  WindowOpenHandlerResponse,
} from 'electron';
import { MockServerProcess, type SpawnOptions } from './server-child-mock';

/**
 * Test double for Electron's main-process module surface.
 *
 * Mounted via `vi.mock('electron', () => import('./electron-mock'))` in
 * test files. Faithful enough to `app` (including `app.dock`,
 * `setAboutPanelOptions`, and `setAsDefaultProtocolClient`), `BrowserWindow`
 * (including `webContents` with `send`, a unique `id`, and an `on`/`emit`
 * event bus), `session`, `ipcMain` (`on`/`handle` as inspectable `vi.fn()`s — tests
 * invoke a registered handler directly from its mock call args), `screen`,
 * `dialog`, `Menu`, `Tray`, `nativeImage`, `nativeTheme`, `shell`, and
 * `utilityProcess` (the production server-spawn path) to drive the
 * main-process code under test without a real Electron runtime.
 */

/**
 * The directory `app.getPath(...)` answers with, replaced by a fresh one on
 * every {@link resetElectronMock}.
 *
 * Unique per reset because some main-process modules write to `userData` with
 * the REAL `node:fs` (`updater-intent.ts`, whose whole job is a file that
 * survives a restart). A shared constant path made those files outlive the test
 * that wrote them, and a leftover install-intent file is read on the next
 * `setupAutoUpdater` as a failed update — a cross-test failure that would look
 * like a product bug. Nothing is created on disk until a module writes.
 */
let userDataPath = freshUserDataPath();

/** A directory no previous test can have written to. */
function freshUserDataPath(): string {
  return join(tmpdir(), 'dorkos-desktop-test', randomUUID(), 'userData');
}

/** Where the mocked `app.getPath(...)` currently points — for tests that inspect what was written. */
export function mockUserDataPath(): string {
  return userDataPath;
}

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
  private readonly webContentsBus = createEventBus();
  private maximized = false;
  private minimized = false;
  private fullScreen = false;
  /** Construction options, so tests can assert on `show`, `backgroundColor`, `webPreferences`. */
  readonly options: Record<string, unknown>;
  bounds: Rectangle;
  webContents = {
    id: nextWebContentsId++,
    send: vi.fn<(channel: string, ...args: unknown[]) => void>(),
    on: vi.fn((event: string, listener: (...args: unknown[]) => unknown) => {
      this.webContentsBus.on(event, listener);
      return this.webContents;
    }),
    once: vi.fn((event: string, listener: (...args: unknown[]) => unknown) => {
      this.webContentsBus.on(event, listener);
      return this.webContents;
    }),
    /**
     * Captures the handler passed to `setWindowOpenHandler` so tests can
     * invoke it directly with a `HandlerDetails`-shaped object and assert on
     * the returned `WindowOpenHandlerResponse`.
     */
    setWindowOpenHandler:
      vi.fn<(handler: (details: HandlerDetails) => WindowOpenHandlerResponse) => void>(),
    reload: vi.fn<() => void>(),
    /**
     * The document this webContents is on. Modelled because the renderer
     * supervisor derives "is the recovery page showing?" from it rather than
     * latching a flag — a mock that always answered `''` would make that whole
     * decision, and the security boundary resting on it, untestable.
     */
    getURL: vi.fn((): string => this.currentUrl),
    /**
     * Whether the page is still fetching. `false` by default — the state a
     * finished load leaves behind — because the renderer supervisor treats a
     * still-loading page as a slow load rather than a failed one, and a mock
     * that answered `true` would make its whole ladder unreachable.
     */
    isLoading: vi.fn((): boolean => false),
    /** Test helper — not part of the real WebContents API. */
    emit: (event: string, ...args: unknown[]): Promise<void> =>
      this.webContentsBus.emit(event, ...args),
  };

  /** Backing field for `webContents.getURL()`; set by `loadURL`/`loadFile`. */
  private currentUrl = '';

  constructor(options: Record<string, unknown> = {}) {
    this.options = options;
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
  once = vi.fn((event: string, listener: (...args: unknown[]) => unknown) => {
    this.bus.on(event, listener);
    return this;
  });
  off = vi.fn((event: string, listener: (...args: unknown[]) => unknown) => {
    this.bus.off(event, listener);
    return this;
  });
  /** Test helper — not part of the real BrowserWindow API. */
  emit = (event: string, ...args: unknown[]): Promise<void> => this.bus.emit(event, ...args);

  focus = vi.fn<() => void>();
  show = vi.fn<() => void>();
  close = vi.fn<() => void>();
  isDestroyed = vi.fn((): boolean => false);
  isVisible = vi.fn((): boolean => true);
  restore = vi.fn(() => {
    this.minimized = false;
  });
  minimize = vi.fn(() => {
    this.minimized = true;
  });
  maximize = vi.fn(() => {
    this.maximized = true;
  });
  setFullScreen = vi.fn((value: boolean) => {
    this.fullScreen = value;
  });
  isMaximized = vi.fn((): boolean => this.maximized);
  isMinimized = vi.fn((): boolean => this.minimized);
  isFullScreen = vi.fn((): boolean => this.fullScreen);
  getBounds = vi.fn((): Rectangle => this.bounds);
  setBounds = vi.fn((bounds: Partial<Rectangle>) => {
    this.bounds = { ...this.bounds, ...bounds };
  });
  // Both record where the window ended up, the way the real ones do: the
  // supervisor asks `webContents.getURL()` back.
  loadURL = vi.fn(async (url: string): Promise<void> => {
    this.currentUrl = url;
  });
  loadFile = vi.fn(async (filePath: string): Promise<void> => {
    this.currentUrl = pathToFileURL(filePath).href;
  });
  /** Test helper — put the window on `url` without going through a load. */
  setUrl(url: string): void {
    this.currentUrl = url;
  }
  reload = vi.fn<() => void>();
}

export const BrowserWindow = MockBrowserWindowImpl;
/** Alias for tests that want to construct/inspect windows without the electron type name. */
export type MockBrowserWindow = MockBrowserWindowImpl;

const appBus = createEventBus();

export const app = {
  isPackaged: false,
  name: 'DorkOS',
  requestSingleInstanceLock: vi.fn((): boolean => true),
  quit: vi.fn<() => void>(),
  /**
   * Arms a relaunch for whenever this process next exits — which is why tests
   * assert on the ORDER of `relaunch` against `quit` and against the agent
   * confirmation, not merely that it was called. The renderer supervisor's
   * third rung relaunches too, for the same "did it relaunch or merely quit?"
   * question.
   */
  relaunch: vi.fn<(options?: unknown) => void>(),
  /** No-op here; in production it must run before `ready` (see `main/index.ts`). */
  disableHardwareAcceleration: vi.fn<() => void>(),
  getPath: vi.fn((_name?: string): string => userDataPath),
  getVersion: vi.fn((): string => '0.1.0'),
  /**
   * macOS-only in real Electron, and modelled unconditionally here: the code
   * that calls it (`diagnostics.ts`) feature-detects rather than branching on
   * platform, so a mock that omitted it could only ever exercise the absent
   * arm.
   */
  isInApplicationsFolder: vi.fn((): boolean => true),
  setAboutPanelOptions: vi.fn<(options: unknown) => void>(),
  setAsDefaultProtocolClient: vi.fn((): boolean => true),
  dock: {
    setMenu: vi.fn<(menu: unknown) => void>(),
    setBadge: vi.fn<(text: string) => void>(),
  },
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

/**
 * Test double for `session`. Only the two clears the main process makes are
 * modelled (see `cache-hygiene.ts`), and both are drivable to *failure*: on
 * every path that calls them — version-change hygiene, and the renderer
 * supervisor's recovery ladder — swallowing the failure and carrying on is the
 * behavior under test.
 */
export const session = {
  defaultSession: {
    clearCache: vi.fn<() => Promise<void>>(() => Promise.resolve()),
    clearStorageData: vi.fn<(options?: unknown) => Promise<void>>(() => Promise.resolve()),
  },
};

export const ipcMain = {
  on: vi.fn<(channel: string, listener: (...args: unknown[]) => unknown) => void>(),
  handle: vi.fn<(channel: string, listener: (...args: unknown[]) => unknown) => void>(),
};

const screenBus = createEventBus();

export const screen = {
  getAllDisplays: vi.fn((): Display[] => [PRIMARY_DISPLAY]),
  getPrimaryDisplay: vi.fn((): Display => PRIMARY_DISPLAY),
  getDisplayMatching: vi.fn((_bounds: Rectangle): Display => PRIMARY_DISPLAY),
  on: vi.fn((event: string, listener: (...args: unknown[]) => unknown) => {
    screenBus.on(event, listener);
    return screen;
  }),
  /** Test helper — invokes every registered listener for `event`. */
  emit: (event: string, ...args: unknown[]): Promise<void> => screenBus.emit(event, ...args),
};

/**
 * Test double for `Tray`. `new Tray(image)` is captured in
 * {@link trayInstances}, and `setContextMenu` records the template the real
 * `Menu.buildFromTemplate` mock passed through — so a test can click a tray
 * item without a real menu bar.
 */
class MockTrayImpl {
  static instances: MockTrayImpl[] = [];

  private readonly bus = createEventBus();

  constructor(public readonly image: MockNativeImage) {
    MockTrayImpl.instances.push(this);
  }

  setToolTip = vi.fn<(tooltip: string) => void>();
  setTitle = vi.fn<(title: string) => void>();
  setContextMenu = vi.fn<(menu: unknown) => void>();
  destroy = vi.fn<() => void>();
  on = vi.fn((event: string, listener: (...args: unknown[]) => unknown) => {
    this.bus.on(event, listener);
    return this;
  });
  /** Test helper — not part of the real Tray API. */
  emit = (event: string, ...args: unknown[]): Promise<void> => this.bus.emit(event, ...args);

  /** Test helper — the template of the most recently set context menu. */
  contextMenuTemplate(): Electron.MenuItemConstructorOptions[] {
    const calls = this.setContextMenu.mock.calls;
    const last = calls[calls.length - 1]?.[0] as { template?: unknown } | undefined;
    return (last?.template ?? []) as Electron.MenuItemConstructorOptions[];
  }
}

export const Tray = MockTrayImpl;
/** Alias for tests that want to inspect trays without the electron type name. */
export type MockTray = MockTrayImpl;

/** Minimal `NativeImage` stand-in: knows its source path and whether it decoded. */
export interface MockNativeImage {
  path: string;
  isEmpty: () => boolean;
  setTemplateImage: (value: boolean) => void;
  /** Test helper — whether `setTemplateImage(true)` was called. */
  templateImage: boolean;
}

/**
 * File names {@link nativeImage} should pretend it cannot decode, matched
 * against the end of the requested path (the caller builds an absolute one).
 * Cleared by {@link resetElectronMock}.
 */
export const unreadableImageFiles = new Set<string>();

export const nativeImage = {
  createFromPath: vi.fn((path: string): MockNativeImage => {
    const image: MockNativeImage = {
      path,
      templateImage: false,
      isEmpty: () => [...unreadableImageFiles].some((name) => path.endsWith(name)),
      setTemplateImage: (value: boolean) => {
        image.templateImage = value;
      },
    };
    return image;
  }),
};

export const nativeTheme = { shouldUseDarkColors: true };

/**
 * Electron's **own** `autoUpdater` — the one behind `process._linkedBinding`,
 * not electron-updater's wrapper (that lives in `electron-updater-mock.ts`).
 * `before-quit-for-update` is announced here on both platforms, so
 * `auto-updater.ts` listens on it; a test drives it with `.emit(...)`.
 */
export const autoUpdater = new EventEmitter();

/**
 * Electron's `dialog.showMessageBox` is overloaded: anchored to a window, or
 * not. Modelling both arms keeps the arguments in `.mock.calls`, which is how
 * tests assert *which* window a dialog was anchored to — a zero-argument stub
 * types those calls as empty tuples and loses that.
 */
export type ShowMessageBox = (
  ...args: [options: MessageBoxOptions] | [window: unknown, options: MessageBoxOptions]
) => Promise<MessageBoxReturnValue>;

export const dialog = {
  showMessageBox: vi.fn<ShowMessageBox>(() =>
    Promise.resolve({ response: 0, checkboxChecked: false })
  ),
  showErrorBox: vi.fn<(title: string, content: string) => void>(),
};

export const Menu = {
  buildFromTemplate: vi.fn((template: unknown) => ({ template })),
  setApplicationMenu: vi.fn<(menu: unknown) => void>(),
};

export const shell = {
  openExternal: vi.fn<(url: string) => Promise<void>>(),
  showItemInFolder: vi.fn<(fullPath: string) => void>(),
};

/**
 * Test double for `Notification`. `new Notification(options)` is captured in
 * {@link MockNotificationImpl.instances}, with `options` preserved verbatim so
 * a test can assert exactly what `notifications/wrapper.ts` built. `on(...)`
 * records listeners on a per-instance bus; `emitAction`/`emitReply`/`emitClick`
 * drive them the way the real Notification would fire `action`/`reply`/`click`.
 */
class MockNotificationImpl {
  static instances: MockNotificationImpl[] = [];
  static isSupported = vi.fn((): boolean => true);

  private readonly bus = createEventBus();

  constructor(public readonly options: Record<string, unknown>) {
    MockNotificationImpl.instances.push(this);
  }

  show = vi.fn<() => void>();
  close = vi.fn<() => void>();
  on = vi.fn((event: string, listener: (...args: unknown[]) => unknown) => {
    this.bus.on(event, listener);
    return this;
  });

  /** Test helper — fire the `action` event with Electron's `(event, index)` shape. */
  emitAction(index: number): Promise<void> {
    return this.bus.emit('action', {}, index);
  }
  /** Test helper — fire the `reply` event with Electron's `(event, text)` shape. */
  emitReply(text: string): Promise<void> {
    return this.bus.emit('reply', {}, text);
  }
  /** Test helper — fire the `click` event. */
  emitClick(): Promise<void> {
    return this.bus.emit('click', {});
  }
}

export const Notification = MockNotificationImpl;
/** Alias for tests that want to inspect notifications without the electron type name. */
export type MockNotification = MockNotificationImpl;

/**
 * Every child `utilityProcess.fork()` has returned, in spawn order — the
 * production counterpart to `child-process-mock`'s `forkedChildren`.
 */
export const utilityProcessChildren: MockServerProcess[] = [];

export const utilityProcess = {
  fork: vi.fn((entry: string, _args: string[], options: SpawnOptions) => {
    const child = new MockServerProcess(entry, options);
    utilityProcessChildren.push(child);
    return child;
  }),
};

/** Reset all mock state between tests — call from `beforeEach`. */
export function resetElectronMock(): void {
  MockBrowserWindowImpl.instances.length = 0;
  MockTrayImpl.instances.length = 0;
  MockNotificationImpl.instances.length = 0;
  MockNotificationImpl.isSupported = vi.fn(() => true);
  appBus.clear();
  screenBus.clear();
  unreadableImageFiles.clear();
  utilityProcessChildren.length = 0;
  utilityProcess.fork.mockClear();

  app.isPackaged = false;
  app.requestSingleInstanceLock = vi.fn(() => true);
  app.quit = vi.fn();
  app.relaunch = vi.fn();
  app.disableHardwareAcceleration = vi.fn();
  userDataPath = freshUserDataPath();
  app.getPath = vi.fn((_name?: string) => userDataPath);
  app.getVersion = vi.fn(() => '0.1.0');
  app.isInApplicationsFolder = vi.fn(() => true);
  app.setAboutPanelOptions = vi.fn();
  app.setAsDefaultProtocolClient = vi.fn(() => true);
  app.dock = { setMenu: vi.fn(), setBadge: vi.fn() };

  session.defaultSession.clearCache = vi.fn(() => Promise.resolve());
  session.defaultSession.clearStorageData = vi.fn(() => Promise.resolve());

  ipcMain.on = vi.fn();
  ipcMain.handle = vi.fn();

  screen.getAllDisplays = vi.fn(() => [PRIMARY_DISPLAY]);
  screen.getPrimaryDisplay = vi.fn(() => PRIMARY_DISPLAY);
  screen.getDisplayMatching = vi.fn(() => PRIMARY_DISPLAY);
  // Recreating `screen.on` would unbind it from the bus above; clearing its
  // call log is what tests actually need from it.
  screen.on.mockClear();

  nativeImage.createFromPath.mockClear();
  nativeTheme.shouldUseDarkColors = true;
  autoUpdater.removeAllListeners();

  dialog.showMessageBox = vi.fn<ShowMessageBox>(() =>
    Promise.resolve({ response: 0, checkboxChecked: false })
  );
  dialog.showErrorBox = vi.fn();

  Menu.buildFromTemplate = vi.fn((template: unknown) => ({ template }));
  Menu.setApplicationMenu = vi.fn();

  shell.openExternal = vi.fn();
  shell.showItemInFolder = vi.fn();
}
