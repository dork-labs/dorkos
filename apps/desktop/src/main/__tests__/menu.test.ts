import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';

vi.mock('electron', () => import('./electron-mock'));
vi.mock('../auto-updater', () => ({ checkForUpdatesInteractive: vi.fn() }));
vi.mock('../close-tab', () => ({ requestCloseTab: vi.fn() }));
vi.mock('../diagnostics', () => ({ saveDiagnosticReportInteractive: vi.fn() }));

/**
 * `vi.mock('electron', factory)` memoizes its result for the whole test
 * file, so the mock state is fetched through the `'electron'` specifier
 * (matching the pattern in `index.test.ts`) rather than imported directly.
 */
async function getElectronMock() {
  const electron = await import('electron');
  return electron as unknown as typeof import('./electron-mock');
}

/** Recursively find a menu item by label within a template (including submenus). */
function findItem(
  template: Electron.MenuItemConstructorOptions[],
  label: string
): Electron.MenuItemConstructorOptions | undefined {
  for (const item of template) {
    if (item.label === label) return item;
    if (item.submenu && Array.isArray(item.submenu)) {
      const found = findItem(item.submenu as Electron.MenuItemConstructorOptions[], label);
      if (found) return found;
    }
  }
  return undefined;
}

describe('setupMenu (B1)', () => {
  // setupMenu now branches on process.platform (DOR-310); this suite asserts
  // the darwin layout, so pin the platform rather than inherit the runner's.
  const realPlatform = process.platform;
  beforeAll(() => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
  });
  afterAll(() => {
    Object.defineProperty(process, 'platform', { value: realPlatform });
  });
  beforeEach(() => {
    vi.clearAllMocks();
    // `../menu` imports `../navigation`, which holds module-level pending-
    // navigation state (Chunk D) — reset so tests don't leak readiness/
    // pending-path state into each other. `electron` (and the mocked
    // `../auto-updater`) stay memoized across resetModules (see
    // `getElectronMock`'s doc comment), so this only re-evaluates the real
    // modules under test.
    vi.resetModules();
  });

  it('Window has minimize/zoom, Close Tab on Cmd+W, Close Window on Shift+Cmd+W, and front', async () => {
    const { Menu, resetElectronMock } = await getElectronMock();
    resetElectronMock();
    const { setupMenu } = await import('../menu');

    setupMenu(() => null, vi.fn());
    const template = vi.mocked(Menu.buildFromTemplate).mock.calls[0][0] as
      Electron.MenuItemConstructorOptions[] | undefined;
    const windowMenu = template!.find((item) => item.role === 'windowMenu')!
      .submenu as Electron.MenuItemConstructorOptions[];

    // Supplying a submenu alongside the role replaces the default one rather
    // than being ignored — verified against a real Electron build.
    expect(windowMenu.map((item) => item.label ?? item.role)).toEqual([
      'minimize',
      'zoom',
      undefined,
      'Close Tab',
      'Close Window',
      undefined,
      'front',
    ]);
  });

  it('Check for Updates… is enabled when packaged and disabled when not, and click triggers checkForUpdatesInteractive', async () => {
    const { app, Menu, resetElectronMock } = await getElectronMock();
    resetElectronMock();
    app.isPackaged = true;
    const { setupMenu } = await import('../menu');
    const { checkForUpdatesInteractive } = await import('../auto-updater');

    setupMenu(() => null, vi.fn());
    const template = vi.mocked(Menu.buildFromTemplate).mock.calls[0][0] as
      Electron.MenuItemConstructorOptions[] | undefined;
    const appMenu = template![0].submenu as Electron.MenuItemConstructorOptions[];
    const checkForUpdates = appMenu.find((item) => item.label === 'Check for Updates…');

    expect(checkForUpdates!.enabled).toBe(true);
    checkForUpdates!.click!({} as never, undefined, {} as never);
    expect(checkForUpdatesInteractive).toHaveBeenCalledTimes(1);
  });

  it('Settings… sends the navigate IPC immediately when the renderer is ready, and ensures the window', async () => {
    const { BrowserWindow, Menu, resetElectronMock } = await getElectronMock();
    resetElectronMock();
    const { setupMenu } = await import('../menu');
    const { SETTINGS_ROUTE, resolvePendingNavigate } = await import('../navigation');

    const win = new BrowserWindow({ width: 1200, height: 800 });
    // Simulate the renderer having already subscribed (client hook mount).
    resolvePendingNavigate(win.webContents.id);
    const ensureWindow = vi.fn();
    setupMenu(() => win as unknown as Electron.BrowserWindow, ensureWindow);

    const template = vi.mocked(Menu.buildFromTemplate).mock.calls[0][0] as
      Electron.MenuItemConstructorOptions[] | undefined;
    const settingsItem = findItem(template!, 'Settings…');
    settingsItem!.click!({} as never, undefined, {} as never);

    expect(win.webContents.send).toHaveBeenCalledWith('navigate', SETTINGS_ROUTE);
    expect(ensureWindow).toHaveBeenCalledTimes(1);
  });

  it('Settings… with zero windows open queues the path and ensures a window (pending-navigation handoff)', async () => {
    const { Menu, resetElectronMock } = await getElectronMock();
    resetElectronMock();
    const { setupMenu } = await import('../menu');
    const { SETTINGS_ROUTE, resolvePendingNavigate } = await import('../navigation');

    const ensureWindow = vi.fn();
    setupMenu(() => null, ensureWindow);

    const template = vi.mocked(Menu.buildFromTemplate).mock.calls[0][0] as
      Electron.MenuItemConstructorOptions[] | undefined;
    const settingsItem = findItem(template!, 'Settings…');
    settingsItem!.click!({} as never, undefined, {} as never);

    expect(ensureWindow).toHaveBeenCalledTimes(1);
    // Delivered once a window exists and its renderer picks up the pending path.
    expect(resolvePendingNavigate(1)).toBe(SETTINGS_ROUTE);
  });

  it('Help menu has the 3 external items wired to shell.openExternal', async () => {
    const { Menu, shell, resetElectronMock } = await getElectronMock();
    resetElectronMock();
    const { setupMenu } = await import('../menu');

    setupMenu(() => null, vi.fn());
    const template = vi.mocked(Menu.buildFromTemplate).mock.calls[0][0] as
      Electron.MenuItemConstructorOptions[] | undefined;
    const help = template!.find((item) => item.role === 'help');
    const helpItems = help!.submenu as Electron.MenuItemConstructorOptions[];
    // The 3 links, a separator, then Save Diagnostic Report….
    expect(helpItems).toHaveLength(5);

    helpItems[0].click!({} as never, undefined, {} as never);
    expect(shell.openExternal).toHaveBeenCalledWith('https://dorkos.ai/docs');

    helpItems[1].click!({} as never, undefined, {} as never);
    expect(shell.openExternal).toHaveBeenCalledWith('https://github.com/dork-labs/dorkos/issues');

    helpItems[2].click!({} as never, undefined, {} as never);
    expect(shell.openExternal).toHaveBeenCalledWith('https://dorkos.ai');
  });
});

describe('setupMenu on win32/linux (DOR-310)', () => {
  const originalPlatform = process.platform;

  beforeEach(() => {
    vi.clearAllMocks();
    // See the darwin suite's beforeEach for why this is needed.
    vi.resetModules();
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
  });

  it.each(['win32', 'linux'] as const)(
    'builds a File/Edit/View/Window/Help layout on %s',
    async (platform) => {
      Object.defineProperty(process, 'platform', { value: platform });
      const { Menu, resetElectronMock } = await getElectronMock();
      resetElectronMock();
      const { setupMenu } = await import('../menu');

      setupMenu(() => null, vi.fn());

      const template = vi.mocked(Menu.buildFromTemplate).mock.calls[0][0] as
        Electron.MenuItemConstructorOptions[] | undefined;
      expect(template).toBeDefined();
      expect(template!.map((item) => item.label)).toEqual([
        'File',
        'Edit',
        'View',
        'Window',
        'Help',
      ]);
      expect(Menu.setApplicationMenu).toHaveBeenCalledTimes(1);
    }
  );

  it('Window has minimize, Close Tab, Close Window, and a hidden Alt+F4 close item', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    const { Menu, resetElectronMock } = await getElectronMock();
    resetElectronMock();
    const { setupMenu } = await import('../menu');

    setupMenu(() => null, vi.fn());
    const template = vi.mocked(Menu.buildFromTemplate).mock.calls[0][0] as
      Electron.MenuItemConstructorOptions[] | undefined;
    const windowMenu = template!.find((item) => item.label === 'Window')!
      .submenu as Electron.MenuItemConstructorOptions[];

    expect(windowMenu.map((item) => item.label ?? item.role)).toEqual([
      'minimize',
      'Close Tab',
      'Close Window',
      'close',
    ]);

    // DOR-561: Alt+F4 closes the active window (Windows convention), not
    // the whole app. Hidden so it doesn't add a second visible "Close
    // Window" row next to the CmdOrCtrl+Shift+W one.
    const altF4Item = windowMenu.find((item) => item.accelerator === 'Alt+F4');
    expect(altF4Item).toBeDefined();
    expect(altF4Item!.role).toBe('close');
    expect(altF4Item!.visible).toBe(false);
  });
});

describe('Cmd/Ctrl+W — closing (DOR-538)', () => {
  const originalPlatform = process.platform;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
  });

  it.each(['darwin', 'win32'] as const)(
    "routes %s's Cmd+W through the renderer, and keeps a way to close the window",
    async (platform) => {
      Object.defineProperty(process, 'platform', { value: platform });
      const { BrowserWindow, Menu, resetElectronMock } = await getElectronMock();
      resetElectronMock();
      const { setupMenu } = await import('../menu');
      const { requestCloseTab } = await import('../close-tab');

      const focused = new BrowserWindow({ width: 1200, height: 800 });
      BrowserWindow.getFocusedWindow = vi.fn(() => focused);

      setupMenu(() => null, vi.fn());
      const template = vi.mocked(Menu.buildFromTemplate).mock.calls[0][0] as
        Electron.MenuItemConstructorOptions[] | undefined;

      // Labelled "Close Tab" since DOR-540 shipped the renderer's handler: the
      // cockpit subscribes for the life of the shell, so this closes a tab
      // whenever there is one and the window on the last tab.
      const closeItem = findItem(template!, 'Close Tab')!;
      expect(closeItem.accelerator).toBe('CmdOrCtrl+W');
      // Not a role: the renderer decides whether the window survives.
      expect(closeItem.role).toBeUndefined();
      closeItem.click!({} as never, undefined, {} as never);
      expect(requestCloseTab).toHaveBeenCalledWith(focused);

      const closeWindow = findItem(template!, 'Close Window')!;
      expect(closeWindow.accelerator).toBe('CmdOrCtrl+Shift+W');
      expect(closeWindow.role).toBe('close');
    }
  );
});

describe('setupDockMenu (B4)', () => {
  const originalPlatform = process.platform;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
  });

  it('sets a "Show DorkOS" dock menu on darwin', async () => {
    const { app, Menu, resetElectronMock } = await getElectronMock();
    resetElectronMock();
    const { setupDockMenu } = await import('../menu');

    Object.defineProperty(process, 'platform', { value: 'darwin' });
    const showMainWindow = vi.fn();
    setupDockMenu(showMainWindow);

    expect(app.dock.setMenu).toHaveBeenCalledTimes(1);
    const template = vi.mocked(Menu.buildFromTemplate).mock.calls[0][0] as
      Electron.MenuItemConstructorOptions[] | undefined;
    expect(template).toHaveLength(1);
    expect(template![0].label).toBe('Show DorkOS');

    template![0].click!({} as never, undefined, {} as never);
    expect(showMainWindow).toHaveBeenCalledTimes(1);
  });
});
