import { app, Menu, shell } from 'electron';
import type { BrowserWindow } from 'electron';
import { sendNavigate, SETTINGS_ROUTE } from './navigation';

/**
 * Set up the native macOS application menu.
 *
 * App menu: About DorkOS, a (currently disabled) Check for Updates… item,
 * Settings… (`Cmd+,`), and the standard services/hide/quit roles. Also
 * provides the standard Edit/View/Window role menus and a custom Help menu
 * with external links.
 *
 * @param getMainWindow - Accessor for the current main window, looked up at
 *   click-time rather than captured — the tracked window is recreated across
 *   its lifetime (macOS close-then-reopen, `second-instance` focus), so a
 *   reference captured when the menu was built would go stale and silently
 *   stop delivering the `navigate` IPC.
 */
export function setupMenu(getMainWindow: () => BrowserWindow | null): void {
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        {
          label: 'Check for Updates…',
          // Disabled until Chunk C wires `checkForUpdatesInteractive()`.
          // Chunk C changes this to `enabled: app.isPackaged` (unsigned/dev
          // builds can't apply updates) and adds the `click` handler.
          enabled: false,
        },
        { type: 'separator' },
        {
          label: 'Settings…',
          accelerator: 'Cmd+,',
          click: () => sendNavigate(getMainWindow(), SETTINGS_ROUTE),
        },
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
      submenu: [
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
