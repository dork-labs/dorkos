import { app, Menu, shell } from 'electron';
import type { BrowserWindow } from 'electron';
import { requestNavigate, SETTINGS_ROUTE } from './navigation';
import { checkForUpdatesInteractive } from './auto-updater';

/**
 * Build the "Settings…" menu item. Shared by every platform's menu —
 * `CmdOrCtrl+,` so the accelerator fires on Windows/Linux too.
 *
 * @param getMainWindow - Accessor for the current main window, looked up at
 *   click-time rather than captured — the tracked window is recreated across
 *   its lifetime (macOS close-then-reopen, `second-instance` focus), so a
 *   reference captured when the menu was built would go stale and silently
 *   stop delivering the `navigate` IPC.
 * @param ensureWindow - Focuses the existing main window or creates one if
 *   none exists (`index.ts`'s `showMainWindow`). Settings… can be clicked
 *   with zero windows open on macOS, so it routes through
 *   {@link requestNavigate} rather than sending directly.
 */
function buildSettingsItem(
  getMainWindow: () => BrowserWindow | null,
  ensureWindow: () => void
): Electron.MenuItemConstructorOptions {
  return {
    label: 'Settings…',
    accelerator: 'CmdOrCtrl+,',
    click: () => requestNavigate(getMainWindow, ensureWindow, SETTINGS_ROUTE),
  };
}

/**
 * Build the "Check for Updates…" menu item. Shared by every platform's
 * menu, gated on `app.isPackaged` — unsigned/unpackaged dev builds can't
 * apply updates.
 */
function buildCheckForUpdatesItem(): Electron.MenuItemConstructorOptions {
  return {
    label: 'Check for Updates…',
    enabled: app.isPackaged,
    click: () => checkForUpdatesInteractive(),
  };
}

/** Build the 3 external links every platform's Help menu shares. */
function buildHelpLinkItems(): Electron.MenuItemConstructorOptions[] {
  return [
    {
      label: 'DorkOS Documentation',
      click: () => shell.openExternal('https://dorkos.ai/docs'),
    },
    {
      label: 'Report an Issue',
      click: () => shell.openExternal('https://github.com/dork-labs/dorkos/issues'),
    },
    {
      label: 'dorkos.ai',
      click: () => shell.openExternal('https://dorkos.ai'),
    },
  ];
}

/**
 * Set up the application menu. Platform-branched (DOR-310): macOS keeps its
 * existing app-name-submenu shape (About/Check for Updates/Settings/
 * services/hide/quit, plus the standard Edit/View/Window/Help role menus).
 * Windows and Linux get an idiomatic File/Edit/View/Window/Help layout
 * instead — neither platform has an app-name-menu convention, so Settings…
 * and Quit move into File, and About/Check for Updates move into Help.
 *
 * Settings…, Check for Updates…, and the Help links reuse the exact same
 * items/handlers on every platform (see {@link buildSettingsItem},
 * {@link buildCheckForUpdatesItem}, {@link buildHelpLinkItems}) — only the
 * surrounding menu shape differs per platform.
 *
 * @param getMainWindow - Accessor for the current main window; see
 *   {@link buildSettingsItem}.
 * @param ensureWindow - Focuses the existing main window or creates one if
 *   none exists (`index.ts`'s `showMainWindow`); see {@link buildSettingsItem}.
 */
export function setupMenu(
  getMainWindow: () => BrowserWindow | null,
  ensureWindow: () => void
): void {
  const settingsItem = buildSettingsItem(getMainWindow, ensureWindow);
  const checkForUpdatesItem = buildCheckForUpdatesItem();
  const helpLinkItems = buildHelpLinkItems();

  const template: Electron.MenuItemConstructorOptions[] =
    process.platform === 'darwin'
      ? [
          {
            label: app.name,
            submenu: [
              { role: 'about' },
              { type: 'separator' },
              checkForUpdatesItem,
              { type: 'separator' },
              settingsItem,
              { type: 'separator' },
              { role: 'services' },
              { type: 'separator' },
              { role: 'hide' },
              { role: 'hideOthers' },
              { role: 'unhide' },
              { type: 'separator' },
              { role: 'quit' },
            ],
          },
          { role: 'editMenu' },
          { role: 'viewMenu' },
          { role: 'windowMenu' },
          {
            role: 'help',
            submenu: helpLinkItems,
          },
        ]
      : [
          {
            label: 'File',
            submenu: [
              settingsItem,
              { type: 'separator' },
              // Windows convention is "Exit", not "Quit"; Alt+F4 is the
              // idiomatic accelerator (role: 'quit' provides the behavior).
              { label: 'Exit', role: 'quit', accelerator: 'Alt+F4' },
            ],
          },
          {
            label: 'Edit',
            submenu: [
              { role: 'undo' },
              { role: 'redo' },
              { type: 'separator' },
              { role: 'cut' },
              { role: 'copy' },
              { role: 'paste' },
              { role: 'selectAll' },
            ],
          },
          {
            label: 'View',
            submenu: [
              { role: 'reload' },
              { role: 'forceReload' },
              { role: 'toggleDevTools' },
              { type: 'separator' },
              { role: 'resetZoom' },
              { role: 'zoomIn' },
              { role: 'zoomOut' },
              { type: 'separator' },
              { role: 'togglefullscreen' },
            ],
          },
          {
            label: 'Window',
            submenu: [{ role: 'minimize' }, { role: 'close' }],
          },
          {
            label: 'Help',
            submenu: [
              ...helpLinkItems,
              { type: 'separator' },
              checkForUpdatesItem,
              { type: 'separator' },
              { role: 'about' },
            ],
          },
        ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/**
 * Set the macOS Dock (right-click/long-press) menu: a single "Show DorkOS"
 * item that focuses the existing main window or recreates it, via the same
 * path `second-instance` uses (see `index.ts`'s `showMainWindow`).
 *
 * A no-op off macOS — the Dock menu concept doesn't exist elsewhere.
 *
 * @param showMainWindow - Focuses the existing main window, or creates one if none exists.
 */
export function setupDockMenu(showMainWindow: () => void): void {
  if (process.platform !== 'darwin') return;

  app.dock?.setMenu(
    Menu.buildFromTemplate([
      {
        label: 'Show DorkOS',
        click: () => showMainWindow(),
      },
    ])
  );
}
