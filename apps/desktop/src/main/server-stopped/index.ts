import { BrowserWindow, ipcMain, type WebContents } from 'electron';
import log from 'electron-log';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { STOPPED_PAGE_FILE } from '../../shared/stopped-page';
import { electronNotificationHost, type NotificationHost } from '../notifications/wrapper';

/**
 * What the app shows while it restarts its server, and when it has given up
 * (DOR-3229).
 *
 * Two states, both quiet. While restarts are still being tried, every window
 * is told so on {@link SERVER_RESTARTING_CHANNEL}, and the app draws a slim
 * "Restarting DorkOS…" bar. Once they have all failed, every window shows the
 * bundled "DorkOS stopped" page with one button, and — only if no DorkOS window
 * is in front — one system notification, once per run of the app.
 *
 * @module main/server-stopped
 */

/** IPC channel the main process says whether restarts are under way on. */
export const SERVER_RESTARTING_CHANNEL = 'server:restarting';

/** IPC channel the stopped page's "Restart DorkOS" goes out on. */
export const RESTART_AFTER_STOP_CHANNEL = 'server-stopped:restart';

/** What "Restart DorkOS" runs: start over, from a fresh count of tries. */
let restartAfterStop: (() => Promise<void>) | null = null;

/** Whether the one system notification has been sent this run. */
let notified = false;

/** Where the notification is shown; swapped for a fake in tests. */
let notificationHost: NotificationHost = electronNotificationHost;

/** Absolute path of the bundled stopped page. */
function stoppedPagePath(): string {
  return resolve(join(__dirname, STOPPED_PAGE_FILE));
}

/**
 * Is `url` the bundled stopped page? Compared as a resolved path, as the
 * recovery page is (`renderer-health/index.ts`), because this is a security
 * boundary: only that page may ask for a restart.
 *
 * @param url - The URL to test, usually `webContents.getURL()`.
 */
export function isStoppedPageUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'file:') return false;
    return resolve(fileURLToPath(parsed)) === stoppedPagePath();
  } catch {
    return false;
  }
}

/**
 * Tell every window whether the server is being restarted. The app shows a
 * slim bar while it is; the caller decides when, so the first two seconds
 * show nothing.
 *
 * @param restarting - Whether restarts are under way.
 */
export function setServerRestarting(restarting: boolean): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(SERVER_RESTARTING_CHANNEL, restarting);
  }
}

/**
 * Show the "DorkOS stopped" page in every window, and send one notification
 * if no DorkOS window is in front.
 *
 * @param tries - How many restarts were tried, for the page's line.
 * @param restart - What "Restart DorkOS" runs.
 */
export function showServerStopped(tries: number, restart: () => Promise<void>): void {
  restartAfterStop = restart;
  log.error(`[server] DorkOS stopped: it couldn't start again after ${tries} tries.`);
  const windows = BrowserWindow.getAllWindows().filter((win) => !win.isDestroyed());
  for (const win of windows) {
    void win.loadFile(stoppedPagePath(), { query: { tries: String(tries) } }).catch((err) => {
      log.error('[server] Could not show the stopped page.', err);
    });
  }
  if (notified || BrowserWindow.getFocusedWindow() || !notificationHost.isSupported()) return;
  notified = true;
  notificationHost.show({
    title: 'DorkOS stopped',
    body: 'Click to restart',
    onClick: () => {
      const front = windows.find((win) => !win.isDestroyed());
      front?.show();
      front?.focus();
      void runRestartAfterStop();
    },
  });
}

/** Run "Restart DorkOS" once; a second click while it runs does nothing. */
let inFlight: Promise<void> | null = null;
function runRestartAfterStop(): Promise<void> {
  if (!restartAfterStop) return Promise.resolve();
  inFlight ??= restartAfterStop().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

/**
 * Whether a restart request came from the stopped page itself. The app's own
 * page runs third-party extension code, so it may not ask.
 *
 * @param contents - The sender of the invoke.
 */
function isStoppedPageSender(contents: WebContents): boolean {
  return isStoppedPageUrl(contents.getURL());
}

/** Answer the stopped page's "Restart DorkOS". Call once, at startup. */
export function registerServerStoppedIpc(): void {
  ipcMain.handle(RESTART_AFTER_STOP_CHANNEL, async (event) => {
    if (!isStoppedPageSender(event.sender)) return;
    await runRestartAfterStop();
  });
}

/**
 * Reset module state between tests.
 *
 * @internal Exported for testing only.
 * @param host - The notification host to use.
 */
export function resetServerStoppedForTests(
  host: NotificationHost = electronNotificationHost
): void {
  restartAfterStop = null;
  notified = false;
  inFlight = null;
  notificationHost = host;
}
