import { app, Menu, shell } from 'electron';
import type { BrowserWindow } from 'electron';
import { requestNavigate, SETTINGS_ROUTE } from './navigation';
import { checkForUpdatesInteractive } from './auto-updater';

/**
 * Set up the application menu. The template is macOS-shaped (an app-name
 * submenu, macOS-only `services`/`hide` roles) but installs on every platform;
 * Electron silently drops the mac-only roles off macOS, so it stays functional
 * on Windows/Linux (if non-idiomatic there — a native File/Edit/… layout is a
 * tracked Windows follow-up, DOR-230-class QA).
 *
 * App menu: About DorkOS, a Check for Updates… item (enabled only in
 * packaged builds — dev builds can't apply updates), Settings… (`CmdOrCtrl+,`,
 * so the accelerator fires on Windows/Linux too), and the standard
 * services/hide/quit roles. Also provides the standard Edit/View/Window role
 * menus and a custom Help menu with external links.
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
export function setupMenu(
  getMainWindow: () => BrowserWindow | null,
  ensureWindow: () => void
): void {
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        {
          label: 'Check for Updates…',
          // Unsigned/unpackaged dev builds can't apply updates.
          enabled: app.isPackaged,
          click: () => checkForUpdatesInteractive(),
        },
        { type: 'separator' },
        {
          label: 'Settings…',
          accelerator: 'CmdOrCtrl+,',
          click: () => requestNavigate(getMainWindow, ensureWindow, SETTINGS_ROUTE),
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
