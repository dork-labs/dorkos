import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import log from 'electron-log';
import { createWindow, isWebLink, makeRendererUrlAccessor } from './window-manager';
import { watchDisplayChanges } from './window-state';
import { startServer, stopServer, getServerPort } from './server-process';
import { PortUnavailableError } from './server-port';
import { setupMenu, setupDockMenu } from './menu';
import { setupAboutPanel } from './about';
import {
  setupAutoUpdater,
  restartToUpdate,
  getLastUpdateStatus,
  isRestartingToUpdate,
  consumeUpdateRestart,
  recordUpdateInstallIntent,
} from './auto-updater';
import { checkForManualOverwrite } from './updater/manual-overwrite';
import { hasTray, setTrayActivity, setupTray } from './tray';
import { getActiveAgentCount, watchAgentActivity } from './agent-activity';
import { watchNotifications } from './notifications';
import { announceBackgroundRunning } from './background-notice';
import { armQuitGuard } from './quit-guard';
import { setupCloseTab } from './close-tab';
import { setupAdminActions } from './admin';
import { clearHttpCacheOnVersionChange } from './cache-hygiene';
import { describeLogLocation } from './log-location';
import { offerMoveToApplications } from './install-location';
import {
  attachRendererSupervisor,
  setupRendererRecovery,
  shouldDisableHardwareAcceleration,
} from './renderer-health';
import {
  ACTIVITY_ROUTE,
  findDeepLinkArg,
  parseDeepLink,
  registerReadinessReset,
  requestNavigate,
  resolvePendingNavigate,
} from './navigation';
import { GET_FULLSCREEN_STATE_CHANNEL } from './fullscreen';
import { GET_FOCUS_STATE_CHANNEL } from './window-focus';

/** The custom URL scheme `dorkos://` deep links arrive on. */
const DEEP_LINK_PROTOCOL = 'dorkos';

let mainWindow: BrowserWindow | null = null;

/**
 * The app's own origin, re-read on every use. The port comes from the
 * supervisor rather than a local copy: a crash and restart gives the server a
 * new one, and a window built around the old port would treat the app's own
 * pages as foreign links.
 */
const getRendererUrl = makeRendererUrlAccessor(getServerPort);

/**
 * Create the main window and track its lifecycle. The app keeps running after
 * the window closes (there is a tray to get back from), so the reference is
 * nulled on 'closed' to prevent later handlers (second-instance, activate)
 * from touching a destroyed BrowserWindow.
 */
function createTrackedWindow(): void {
  const options = { getRendererUrl, role: 'primary' as const };
  mainWindow = createWindow(options);
  // Watch it from the moment it exists: a window that never paints is the one
  // failure nothing else in the shell can see (renderer-health/).
  attachRendererSupervisor(mainWindow, options);
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
  // Clicking back into the window is one of the two moments a person expects
  // the version they just installed (see updater/manual-overwrite.ts). Silent unless
  // the app on disk is genuinely newer than the one running.
  mainWindow.on('focus', () => {
    void checkForManualOverwrite(getMainWindow);
  });
  // A reload or renderer crash keeps this window's webContents.id but drops
  // the renderer's `navigate` subscription — reset the deep-link readiness
  // mark so requestNavigate queues instead of sending into the void.
  registerReadinessReset(mainWindow);
}

/**
 * Point-in-time accessor for the tracked main window. Passed to the menu
 * (rather than a captured `BrowserWindow`) so click handlers always see the
 * current window, even after it has been recreated.
 */
function getMainWindow(): BrowserWindow | null {
  return mainWindow;
}

/**
 * Whether an `invoke` came from the tracked main window's renderer. Guards the
 * read-once/replay handlers (`get-pending-navigate`, `get-update-status`) so a
 * stray invoke (devtools, a second cockpit window) can't steal state meant
 * for the primary renderer. `webContents.id` is unique per instance, so this
 * naturally rejects a destroyed-then-recreated window's old id.
 *
 * This is what scopes deep links and the update card to the primary window: a
 * second window opened with `window.open` is a full cockpit, but menu
 * navigation, `dorkos://` links and the "restart to install" card all land in
 * the primary one.
 */
function isTrackedRenderer(event: Electron.IpcMainInvokeEvent): boolean {
  const win = getMainWindow();
  return !!win && !win.isDestroyed() && event.sender.id === win.webContents.id;
}

/**
 * What the "DorkOS couldn't start" box says.
 *
 * Most start-up failures are opaque (a crash, a failed migration, a spawn that
 * never got off the ground), so the default is a generic apology plus the two
 * things that usually help: try again, and here is where the log is.
 *
 * A {@link PortUnavailableError} is the exception, and it is the reason this is
 * a function. Those messages already name the port, why it could not be had,
 * and the setting that changes it — and "try restarting the app" is not merely
 * unhelpful there, it contradicts them: a port someone pinned is still taken on
 * the next launch, which is the whole premise of having refused. Leading with
 * advice the next paragraph disproves teaches people to stop reading these
 * boxes.
 *
 * @param err - Whatever `startServer` rejected with.
 * @returns The dialog body.
 */
function startupFailureMessage(err: unknown): string {
  const detail = err instanceof Error ? err.message : String(err);
  if (err instanceof PortUnavailableError) return detail;
  return (
    "DorkOS couldn't start its background server, so it can't continue. " +
    `Try restarting the app. If this keeps happening, check ${describeLogLocation()} for ` +
    `details.\n\n${detail}`
  );
}

/**
 * Focus the existing main window (restoring it first if minimized), or
 * create one if none exists yet. Shared by `second-instance` and the Dock
 * menu's "Show DorkOS" item so there is one path for "bring the app forward".
 */
function showMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    if (getServerPort()) {
      createTrackedWindow();
    } else {
      // Narrow window (DOR-564): a second-instance launch, a Dock click, or
      // a deep link arriving before the server has a port to serve from.
      // Silent otherwise — someone double-clicking the icon during a slow
      // start would see nothing happen and have no idea why.
      log.info('[window] showMainWindow called with no server port yet; nothing to show.');
    }
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  // Windows are created hidden and revealed on their first frame, so a window
  // asked for before it has painted needs showing as well as focusing.
  mainWindow.show();
  mainWindow.focus();
}

/**
 * Route a raw `dorkos://` URL through the app's navigation path, from
 * whichever platform channel delivered it (macOS `open-url`, or a Windows/Linux
 * `process.argv` / `second-instance` scan). A well-formed link navigates via
 * {@link requestNavigate} — which ensures/focuses a window and tolerates a
 * renderer that isn't subscribed yet; a malformed one just brings the app
 * forward.
 *
 * @param url - The raw deep-link URL string.
 */
function handleDeepLinkUrl(url: string): void {
  const path = parseDeepLink(url);
  if (path) {
    requestNavigate(getMainWindow, showMainWindow, path);
  } else {
    showMainWindow();
  }
}

// Only one instance of the app may run at a time — two copies would each
// spawn their own server process against the same ~/.dork SQLite store.
// This must run before any ready-work (IPC handlers, window creation).
const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  app.quit();
} else {
  // Before anything else, because it cannot be done later: Electron ignores
  // `disableHardwareAcceleration()` once 'ready' has fired. The flag is set by
  // the renderer supervisor's third recovery rung, after reloading and
  // clearing caches both failed to get a window to paint, and it is cleared by
  // the first renderer that reports alive — one relaunch cycle, not a
  // permanent downgrade.
  if (shouldDisableHardwareAcceleration()) {
    app.disableHardwareAcceleration();
    log.warn(
      '[renderer] Starting with hardware acceleration off after repeated renderer failures.'
    );
  }

  // A second launch attempt was blocked by the lock above; bring the
  // existing window to the front instead of doing nothing. If the window
  // was closed (macOS keeps the app alive with zero windows), recreate it.
  //
  // On Windows/Linux a warm `dorkos://` activation arrives as the `argv` of
  // this event (the OS launches a second instance that fails the lock and
  // hands its command line here), so scan it for a deep link and route it;
  // with no link attached it's a plain re-focus. macOS routes warm deep
  // links through `open-url` instead, and passes no meaningful argv here.
  app.on('second-instance', (_event, argv: string[]) => {
    const url = Array.isArray(argv) ? findDeepLinkArg(argv) : null;
    if (url) {
      handleDeepLinkUrl(url);
    } else {
      showMainWindow();
    }
    // The launch that lands here may be a NEWER copy of the app: someone
    // installed an update by hand while this process stayed alive, and the
    // lock above just handed their double-click to the old version. Focusing
    // the old window is not what they asked for — see updater/manual-overwrite.ts.
    void checkForManualOverwrite(getMainWindow);
  });

  // Register `dorkos://` as this app's protocol handler. Cross-platform and
  // safe to call before 'ready'; idempotent across launches.
  app.setAsDefaultProtocolClient(DEEP_LINK_PROTOCOL);

  // macOS delivers `dorkos://` activations through `open-url` — including a
  // cold-start deep link, which can fire before 'ready' (before any window or
  // server exists). Per Electron's docs this listener must be registered as
  // early as possible, before 'ready', to reliably catch that case. This
  // event is macOS-only, so scope its registration there; Windows/Linux
  // deliver deep links via argv instead (see below and `second-instance`).
  if (process.platform === 'darwin') {
    app.on('open-url', (event, url) => {
      event.preventDefault();
      handleDeepLinkUrl(url);
    });
  } else {
    // Windows/Linux cold-start deep link: the OS appends the `dorkos://` URL
    // to this process's command line. Scan it once at startup and route it
    // through the same pending-navigation path — the queued path is delivered
    // once the window's renderer subscribes on mount (see navigation.ts).
    const coldStartUrl = findDeepLinkArg(process.argv);
    if (coldStartUrl) handleDeepLinkUrl(coldStartUrl);
  }

  // Own the way out before anything can ask for it: every quit — Cmd+Q, the
  // menu, the tray, the Dock, `quitAndInstall()`, the crash dialog — goes
  // through this one handler, which confirms when agents are mid-run and
  // always stops the server before the process goes (see quit-guard.ts).
  armQuitGuard({
    countActiveAgents: getActiveAgentCount,
    getWindow: getMainWindow,
    shutdown: stopServer,
    consumeUpdateRestart,
    recordUpdateInstallIntent,
  });

  // Register IPC handlers for the preload bridge.
  // These must be registered before the window is created.
  setupCloseTab();

  // Renderer supervision's process-wide half: the heartbeat channel, the
  // recovery page's actions, and crash logging for windows the ladder does not
  // cover. Before the window for a reason — the renderer can report alive as
  // soon as its first document runs, and a heartbeat nothing is listening for
  // is a "failure" the ladder would go on to recover from.
  setupRendererRecovery();

  // Settings → Advanced's "Restart Server" and "Reset All Data". Both are the
  // supervisor's work here rather than the server's, because a server that ends
  // its own process inside a UtilityProcess never comes back (see `admin/`).
  setupAdminActions({ getRendererUrl });

  ipcMain.on('get-server-port', (event) => {
    event.returnValue = getServerPort();
  });

  // Open a URL outside the app. The renderer needs this for one address in
  // particular: its own. `window.open` at our own origin is claimed by the
  // window-open handler and becomes a second cockpit window — right for "open
  // in a new tab", wrong for "open this in my browser", which is what Settings
  // → Server offers so the cockpit can be bookmarked.
  //
  // Same policy as the link guards, through the same predicate: http(s) only,
  // anything else ignored. That leaves this bridge no more powerful than the
  // `target="_blank"` the renderer already has — it removes the own-origin
  // exception and nothing else.
  //
  // Deliberately NOT gated on `isTrackedRenderer`, unlike the handlers below.
  // Those guard read-once state meant for one renderer; this is stateless and
  // owns nothing, and a second cockpit window (`window.open` at our own origin)
  // is a full cockpit whose Settings → Server must work too.
  // Answers whether the URL actually left, because the renderer's link seam
  // reports refusals to the person now (DOR-547) and cannot report one it was
  // never told about. A dropped `mailto:`/`tel:` used to resolve here exactly
  // like a successful `https:` — the same silent-click shape the seam exists to
  // remove, reintroduced one process later.
  ipcMain.handle('open-external', async (_event, url: unknown): Promise<boolean> => {
    if (typeof url !== 'string' || !isWebLink(url)) return false;
    await shell.openExternal(url);
    return true;
  });

  // Update surface for the renderer's in-app card (see auto-updater.ts). The
  // card triggers a restart-to-install; the updater pushes lifecycle events
  // back on the `update:status` channel and retains the last actionable status
  // for `get-update-status` to replay to a renderer that mounted after the
  // event fired (macOS close→reopen). No-ops in dev (unpackaged builds can't
  // apply updates).
  ipcMain.on('update:restart', () => {
    void restartToUpdate();
  });

  // Replay the last `downloading`/`downloaded` status — called once by the
  // client's useDesktopUpdater hook right after it subscribes on mount, so a
  // window recreated after the event recovers a waiting update. Guarded to the
  // tracked renderer like `get-pending-navigate`.
  ipcMain.handle('get-update-status', (event) => {
    if (!isTrackedRenderer(event)) return null;
    return getLastUpdateStatus();
  });

  // Renderer-readiness + pending-navigation pickup (see navigation.ts) —
  // called by the client's useElectronNavigate hook right after it
  // subscribes to `onNavigate` on mount. Only the tracked main window's
  // renderer may mark readiness or drain the slot: a stray invoke (devtools,
  // a future auxiliary window) must not steal the pending path or trick
  // requestNavigate into hot-path-sending to the wrong webContents.
  ipcMain.handle('get-pending-navigate', (event) => {
    if (!isTrackedRenderer(event)) return null;
    return resolvePendingNavigate(event.sender.id);
  });

  // Initial-state replay for `useElectronFullscreen` (see `./fullscreen`'s
  // `forwardFullscreenState`, which pushes changes but has nothing to send a
  // renderer that mounts — or remounts — after the window already entered
  // fullscreen). Answers about the calling renderer's own window, so unlike
  // the handlers above it needs no `isTrackedRenderer` gate: there is nothing
  // here for a second window to steal.
  ipcMain.handle(GET_FULLSCREEN_STATE_CHANNEL, (event) => {
    return BrowserWindow.fromWebContents(event.sender)?.isFullScreen() ?? false;
  });

  // Initial-state replay for `useWindowFocusDimming` (see `./window-focus`'s
  // `forwardFocusState`). Same shape as the fullscreen replay above, and for
  // the same reason: a renderer that mounts (or remounts, after a reload)
  // while the window already lacks focus would otherwise never dim until the
  // next focus/blur transition.
  ipcMain.handle(GET_FOCUS_STATE_CHANNEL, (event) => {
    return BrowserWindow.fromWebContents(event.sender)?.isFocused() ?? false;
  });

  app.on('ready', async () => {
    // 0. Before anything is started: a copy running from the disk image or
    // Downloads cannot update itself, so offer once to move it into
    // Applications (see install-location/).
    //
    // First in the sequence, and it has to be. A successful move quits and
    // relaunches this process — with the server already forked, that leaves a
    // child holding the port and the ~/.dork store the relaunched instance is
    // seconds away from wanting, racing its own predecessor's shutdown. Moving
    // before anything exists to orphan makes that race impossible rather than
    // merely unlikely.
    //
    // Wrapped because being first also makes it the one await with nothing
    // behind it yet: an unhandled throw here returns from 'ready' having
    // started no server and created no window, and Electron surfaces that
    // nowhere. A courtesy about where the app is installed must never be the
    // reason it does not start.
    try {
      if (await offerMoveToApplications()) return;
    } catch (err) {
      log.warn('[install] The install-location check failed; starting anyway.', err);
    }

    // 1. Start Express in a UtilityProcess. On 4242 whenever that is free, so
    // the address stays the one the docs name; on a port someone pinned, or not
    // at all (see server-port.ts). A rejection here previously vanished
    // silently — Electron doesn't surface a rejected async 'ready' handler
    // anywhere — leaving the app running with zero windows and no way for the
    // user to know why. showErrorBox is synchronous/blocking, so it's
    // guaranteed to be seen before the app quits.
    try {
      // The accessor lets the supervisor anchor its crash dialog to whichever
      // window is current, the same way setupAutoUpdater does.
      await startServer(getMainWindow);
    } catch (err) {
      dialog.showErrorBox("DorkOS couldn't start", startupFailureMessage(err));
      app.quit();
      return;
    }

    // Must land before any window loads: a cache carried over from the previous
    // version can serve a shell naming bundles this build does not ship.
    await clearHttpCacheOnVersionChange();

    // 2. Create the main window (the renderer fetches the server port via IPC)
    createTrackedWindow();

    // 3. Set up the native menu bar, macOS About panel, and Dock menu
    setupMenu(getMainWindow, showMainWindow);
    setupAboutPanel();
    setupDockMenu(showMainWindow);

    // 4. Put DorkOS in the menu bar / system tray. This is what makes closing
    // the window safe: the app stays running, and the tray is how you get it
    // back and how you see whether anything is happening.
    setupTray({
      showWindow: showMainWindow,
      openActivity: () => requestNavigate(getMainWindow, showMainWindow, ACTIVITY_ROUTE),
    });

    // 5. Follow the server's own event stream so the tray — and the quit
    // confirmation — know how many agents are mid-run, with no window open and
    // no polling.
    watchAgentActivity({ getPort: getServerPort, onChange: setTrayActivity });

    // 5.5. Native OS notifications for Blocking Asks (always) and Notable
    // activity (while no DorkOS window has focus) — the same shared stream
    // `watchAgentActivity` just subscribed to (see `event-stream.ts`).
    watchNotifications({
      getPort: getServerPort,
      isWindowUnfocused: () => BrowserWindow.getFocusedWindow() === null,
      focusAndNavigate: (path) => requestNavigate(getMainWindow, showMainWindow, path),
    });

    // 6. Rescue windows stranded by a monitor being unplugged while we run.
    watchDisplayChanges(() => BrowserWindow.getAllWindows());

    // 7. Check for updates in the background (non-blocking). No-ops in dev
    // (unpackaged builds can't apply updates) — see auto-updater.ts.
    setupAutoUpdater(getMainWindow);
  });

  // Closing the last window does not quit: the server keeps running, so agents
  // keep working, and the tray is how you come back. One rule for every
  // platform, replacing the old split where macOS stayed alive and Windows
  // quit outright.
  //
  // The condition is "is there a way back", not "which OS is this" — if the
  // tray could not be created (no image for this platform, an unreadable one),
  // quitting is the only honest thing left. An app running with no window and
  // no icon is one nobody can reach.
  app.on('window-all-closed', () => {
    // This stays unconditional. An app with no window and no way back is the
    // one state this whole design exists to prevent, so nothing may return
    // above it — least of all a flag owned by another module, which is what
    // an earlier version of this handler did. Quitting during an update
    // restart is harmless anyway: it is what `quitAndInstall()` was about to
    // do, and the quit guard keeps it silent.
    if (!hasTray()) {
      app.quit();
      return;
    }
    // `autoUpdater.quitAndInstall()` closes every window and only *then* calls
    // `app.quit()`, so this fires on the update-restart path exactly as if a
    // person had closed the last window by hand. Left ungated they get "DorkOS
    // is still running" — with a Quit button — in the middle of an update, and
    // the one-time notice is burnt for good. `isQuitting()` cannot catch it: on
    // that path `before-quit` has not happened yet.
    if (isRestartingToUpdate()) return;
    // Someone who thinks they quit and didn't files a bug report. Say it once.
    void announceBackgroundRunning();
  });

  // macOS convention: clicking the dock icon re-creates the window
  // if all windows have been closed.
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0 && getServerPort()) {
      createTrackedWindow();
    }
  });
}
