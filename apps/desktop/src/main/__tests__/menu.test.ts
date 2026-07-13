import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('electron', () => import('./electron-mock'));
vi.mock('../auto-updater', () => ({ checkForUpdatesInteractive: vi.fn() }));

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

  it('builds top-level roles: custom app menu, editMenu, viewMenu, windowMenu, help', async () => {
    const { Menu, resetElectronMock } = await getElectronMock();
    resetElectronMock();
    const { setupMenu } = await import('../menu');

    setupMenu(() => null, vi.fn());

    const template = vi.mocked(Menu.buildFromTemplate).mock.calls[0][0] as
      | Electron.MenuItemConstructorOptions[]
      | undefined;
    expect(template).toBeDefined();
    expect(template![0].label).toBe('DorkOS');
    expect(template!.some((item) => item.role === 'editMenu')).toBe(true);
    expect(template!.some((item) => item.role === 'viewMenu')).toBe(true);
    expect(template!.some((item) => item.role === 'windowMenu')).toBe(true);
    expect(template!.some((item) => item.role === 'help')).toBe(true);
    expect(Menu.setApplicationMenu).toHaveBeenCalledTimes(1);
  });

  it('app menu has About, a gated Check for Updates…, and Settings… with CmdOrCtrl+, accelerator', async () => {
    const { app, Menu, resetElectronMock } = await getElectronMock();
    resetElectronMock();
    app.isPackaged = false;
    const { setupMenu } = await import('../menu');

    setupMenu(() => null, vi.fn());
    const template = vi.mocked(Menu.buildFromTemplate).mock.calls[0][0] as
      | Electron.MenuItemConstructorOptions[]
      | undefined;
    const appMenu = template![0].submenu as Electron.MenuItemConstructorOptions[];

    expect(appMenu.some((item) => item.role === 'about')).toBe(true);

    const checkForUpdates = appMenu.find((item) => item.label === 'Check for Updates…');
    expect(checkForUpdates).toBeDefined();
    expect(checkForUpdates!.enabled).toBe(false);

    const settingsItem = appMenu.find((item) => item.label === 'Settings…');
    expect(settingsItem).toBeDefined();
    expect(settingsItem!.accelerator).toBe('CmdOrCtrl+,');
  });

  it('Check for Updates… is enabled when packaged and disabled when not, and click triggers checkForUpdatesInteractive', async () => {
    const { app, Menu, resetElectronMock } = await getElectronMock();
    resetElectronMock();
    app.isPackaged = true;
    const { setupMenu } = await import('../menu');
    const { checkForUpdatesInteractive } = await import('../auto-updater');

    setupMenu(() => null, vi.fn());
    const template = vi.mocked(Menu.buildFromTemplate).mock.calls[0][0] as
      | Electron.MenuItemConstructorOptions[]
      | undefined;
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
      | Electron.MenuItemConstructorOptions[]
      | undefined;
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
      | Electron.MenuItemConstructorOptions[]
      | undefined;
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
      | Electron.MenuItemConstructorOptions[]
      | undefined;
    const help = template!.find((item) => item.role === 'help');
    const helpItems = help!.submenu as Electron.MenuItemConstructorOptions[];
    expect(helpItems).toHaveLength(3);

    helpItems[0].click!({} as never, undefined, {} as never);
    expect(shell.openExternal).toHaveBeenCalledWith('https://dorkos.ai/docs');

    helpItems[1].click!({} as never, undefined, {} as never);
    expect(shell.openExternal).toHaveBeenCalledWith('https://github.com/dork-labs/dorkos/issues');

    helpItems[2].click!({} as never, undefined, {} as never);
    expect(shell.openExternal).toHaveBeenCalledWith('https://dorkos.ai');
  });
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
      | Electron.MenuItemConstructorOptions[]
      | undefined;
    expect(template).toHaveLength(1);
    expect(template![0].label).toBe('Show DorkOS');

    template![0].click!({} as never, undefined, {} as never);
    expect(showMainWindow).toHaveBeenCalledTimes(1);
  });

  it('does nothing off darwin', async () => {
    const { app, resetElectronMock } = await getElectronMock();
    resetElectronMock();
    const { setupDockMenu } = await import('../menu');

    Object.defineProperty(process, 'platform', { value: 'win32' });
    setupDockMenu(vi.fn());

    expect(app.dock.setMenu).not.toHaveBeenCalled();
  });
});
