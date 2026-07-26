import { ipcMain } from 'electron';
import type { BrowserWindow } from 'electron';

/**
 * `Cmd/Ctrl+W` — close a tab, or the window if there is no tab to close.
 *
 * The cockpit is growing in-renderer tabs, and Electron's built-in `close` role
 * would take the whole window down with five of them open. So the accelerator
 * now asks the renderer first and only closes the window if the renderer does
 * not take it.
 *
 * **The contract, in full** (the renderer half is written against
 * `window.electronAPI.onCloseTab` — see `src/preload/index.ts`):
 *
 * 1. Main sends `close-tab` with a `requestId` to the focused window.
 * 2. The renderer replies on `close-tab:ack` with `(requestId, handled)`.
 *    `handled: true` means it closed a tab and the window must stay open;
 *    `handled: false` means it had nothing to close.
 * 3. If no matching reply arrives within {@link ACK_TIMEOUT_MS}, the window
 *    closes.
 *
 * Rule 3 is the whole design. A person pressing Cmd+W must never get nothing —
 * not when the renderer has not shipped its half yet, not when it is wedged,
 * not when it threw. The timeout cannot deadlock because nothing waits on the
 * renderer: it is a race the window always eventually wins.
 */

/** Channel the main process asks a renderer to close a tab on. */
const CLOSE_TAB_CHANNEL = 'close-tab';

/** Channel the renderer replies on (mirrored in `src/preload/index.ts`). */
const CLOSE_TAB_ACK_CHANNEL = 'close-tab:ack';

/**
 * How long the renderer gets to answer before the window closes.
 *
 * Short enough that an unanswered Cmd+W still feels instant, long enough to
 * survive a renderer busy painting a streaming turn.
 */
const ACK_TIMEOUT_MS = 250;

/** A close-tab request waiting on its renderer. */
interface PendingRequest {
  timeout: ReturnType<typeof setTimeout>;
  /** Which renderer was asked — an ack from anywhere else is ignored. */
  webContentsId: number;
  window: BrowserWindow;
}

let nextRequestId = 1;
const pending = new Map<number, PendingRequest>();

/** Whether {@link setupCloseTab} has already registered its listener. */
let installed = false;

/**
 * Clear pending requests and the install guard.
 *
 * @internal Exported for testing only.
 */
export function resetCloseTab(): void {
  for (const request of pending.values()) clearTimeout(request.timeout);
  pending.clear();
  nextRequestId = 1;
  installed = false;
}

/**
 * Register the renderer's reply channel. Call once, before any window exists.
 */
export function setupCloseTab(): void {
  if (installed) return;
  installed = true;
  ipcMain.on(
    CLOSE_TAB_ACK_CHANNEL,
    (event: Electron.IpcMainEvent, requestId: unknown, handled: unknown) => {
      if (typeof requestId !== 'number') return;
      const request = pending.get(requestId);
      // Identity-guarded like the other renderer IPC in `index.ts`: only the
      // renderer that was asked may answer, so a stray sender cannot keep a
      // window open that a person asked to close.
      if (!request || request.webContentsId !== event.sender.id) return;

      pending.delete(requestId);
      clearTimeout(request.timeout);
      if (handled !== true) closeWindow(request.window);
    }
  );
}

/**
 * Ask `win`'s renderer to close a tab, and close the window if it does not.
 *
 * @param win - The focused window, or `null` when nothing is focused (a no-op).
 */
export function requestCloseTab(win: BrowserWindow | null): void {
  if (!win || win.isDestroyed()) return;

  const requestId = nextRequestId++;
  const timeout = setTimeout(() => {
    pending.delete(requestId);
    closeWindow(win);
  }, ACK_TIMEOUT_MS);

  pending.set(requestId, { timeout, webContentsId: win.webContents.id, window: win });
  win.webContents.send(CLOSE_TAB_CHANNEL, requestId);
}

/** Close a window that may have been destroyed while its renderer was thinking. */
function closeWindow(win: BrowserWindow): void {
  if (win.isDestroyed()) return;
  win.close();
}
