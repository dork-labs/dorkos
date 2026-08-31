import { app, BrowserWindow, Menu, shell } from 'electron';
import { requestNavigate, SETTINGS_ROUTE } from './navigation';
import { checkForUpdatesInteractive } from './auto-updater';
import { requestCloseTab } from './close-tab';
import { saveDiagnosticReportInteractive } from './diagnostics';

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

/**
 * Build the two closing items every platform's Window menu shares.
 *
 * `CmdOrCtrl+W` used to be Electron's `close` role, which takes the whole
 * window down — wrong once the cockpit has tabs in it, where the keystroke
 * means "close this tab". It now asks the focused renderer first and closes the
 * window only if the renderer has nothing to close or does not answer (see
 * `close-tab.ts`). `CmdOrCtrl+Shift+W` keeps the old, unconditional behaviour,
 * so there is always a keystroke that closes the window itself.
 *
 * **Labelled "Close Tab" since DOR-540**, which is the change that shipped the
 * renderer's `onCloseTab` handler — the rename this comment used to ask for.
 * The cockpit now subscribes for the whole life of the shell, so the item
 * closes a tab whenever there is one, and closes the window on the last tab.
 * That is what Chrome's "Close Tab" does too, so the name is honest in both
 * cases; `Close Window` remains for closing the window outright.
 */
function buildWindowClosingItems(): Electron.MenuItemConstructorOptions[] {
  return [
    {
      label: 'Close Tab',
      accelerator: 'CmdOrCtrl+W',
      // Looked up here rather than taken from the click handler's second
      // argument, which Electron types as the broader `BaseWindow`.
      click: () => requestCloseTab(BrowserWindow.getFocusedWindow()),
    },
    { label: 'Close Window', accelerator: 'CmdOrCtrl+Shift+W', role: 'close' },
  ];
}

/**
 * Windows/Linux only: reclaims `Alt+F4` from Electron's `role: 'quit'`
 * default and rebinds it to closing the active window (DOR-561).
 *
 * `Alt+F4` means "close the active window" on Windows, not "quit the
 * application" — but since DOR-538, closing the window deliberately does
 * NOT quit (the server keeps running and the tray is the way back). Binding
 * the keystroke everyone reaches for to dismiss a window to `role: 'quit'`
 * tore down the whole app and every running agent instead, which is the
 * opposite of what that feature shipped to do.
 *
 * Hidden because "Close Window" already has a visible entry for this exact
 * role (`CmdOrCtrl+Shift+W`, from {@link buildWindowClosingItems}); this item
 * exists only to give `Alt+F4` somewhere correct to go, not to add a second
 * visible menu row that does the same thing.
 */
function buildAltF4CloseItem(): Electron.MenuItemConstructorOptions {
  return { visible: false, accelerator: 'Alt+F4', role: 'close' };
}

/**
 * Build the "Save Diagnostic Report…" item every platform's Help menu shares.
 *
 * Lives in the menu bar, not in the cockpit, because the failure it exists for
 * is a window that renders nothing: the native menu is still there when the
 * renderer is not. Ungated on `app.isPackaged` — a dev build's logs are worth
 * collecting too, and the report says which kind of build it came from.
 */
function buildDiagnosticsItem(): Electron.MenuItemConstructorOptions {
  return {
    label: 'Save Diagnostic Report…',
    click: () => void saveDiagnosticReportInteractive(),
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
  const diagnosticsItem = buildDiagnosticsItem();
  const windowClosingItems = buildWindowClosingItems();

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
          // Deliberate (DOR-564): Electron's default `viewMenu` role includes
          // "Toggle Developer Tools", and this is not gated on
          // `app.isPackaged` — DevTools is reachable in every build,
          // including a production one someone installed from dorkos.ai.
          // For a developer-facing product that's a defensible default (the
          // audience this ships to already expects to be able to inspect
          // it), but it's an unexamined one without this comment saying so.
          // It compounds the still-missing renderer CSP (DOR-560): DevTools
          // plus no CSP is a wider attack surface than either alone. See the
          // matching note on the Windows/Linux `toggleDevTools` item below.
          { role: 'viewMenu' },
          // The role is kept while the submenu is replaced. Dropping it and
          // hand-building a "Window" menu costs the macOS windows menu — the
          // role is what hands this submenu to `NSApp.setWindowsMenu:`, which
          // is what adds the automatic list of open windows and the checkmark
          // on the frontmost one. That matters more now, not less: this is the
          // release where a second cockpit window became possible. Verified
          // against a real Electron build that the custom submenu survives the
          // role rather than being replaced by the default.
          {
            role: 'windowMenu',
            submenu: [
              { role: 'minimize' },
              { role: 'zoom' },
              { type: 'separator' },
              ...windowClosingItems,
              { type: 'separator' },
              { role: 'front' },
            ],
          },
          {
            role: 'help',
            submenu: [...helpLinkItems, { type: 'separator' }, diagnosticsItem],
          },
        ]
      : [
          {
            label: 'File',
            submenu: [
              settingsItem,
              { type: 'separator' },
              // Windows convention is "Exit", not "Quit" — but unlike on
              // other platforms this item carries no accelerator: `Alt+F4`
              // is the platform's close-the-active-window keystroke, not
              // quit, and is rebound to `role: 'close'` instead (DOR-561,
              // see buildAltF4CloseItem). Quitting stays reachable via this
              // menu item and the tray.
              { label: 'Exit', role: 'quit' },
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
              // Deliberate, not gated on `app.isPackaged` — see the matching
              // note on macOS's `viewMenu` role above for why, and DOR-560
              // for the missing CSP this compounds.
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
            submenu: [{ role: 'minimize' }, ...windowClosingItems, buildAltF4CloseItem()],
          },
          {
            label: 'Help',
            submenu: [
              ...helpLinkItems,
              { type: 'separator' },
              diagnosticsItem,
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
