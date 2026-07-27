import { ipcMain } from 'electron';
import type { BrowserWindow } from 'electron';

/**
 * `Cmd/Ctrl+W` — close a tab, or the window if there is no tab to close.
 *
 * The cockpit is growing in-renderer tabs, and Electron's built-in `close` role
 * would take the whole window down with five of them open. So the accelerator
 * asks the renderer first and only closes the window if the renderer has
 * nothing to close.
 *
 * **The contract, in full** (the renderer half is written against
 * `window.electronAPI.onCloseTab` — see `src/preload/index.ts`):
 *
 * 1. A renderer that wants the keystroke announces itself on
 *    `close-tab:subscribe` when it first calls `onCloseTab`, and gives it back
 *    on `close-tab:unsubscribe`.
 * 2. **With no subscriber, the window closes immediately.** No message, no
 *    wait — which is exactly what `Cmd+W` did before tabs existed, and what it
 *    still does in every window whose renderer has not mounted its handler.
 * 3. With a subscriber, main sends `close-tab` with a `requestId`, and the
 *    renderer replies on `close-tab:ack` with `(requestId, handled)`.
 *    `handled: true` means it closed a tab and the window must stay open;
 *    `handled: false` means it had nothing to close.
 * 4. If that reply does not arrive within {@link ACK_TIMEOUT_MS}, the window
 *    closes.
 *
 * Rules 2 and 4 are the whole design. A person pressing Cmd+W must never get
 * nothing — not when the renderer has not shipped its half, not when it is
 * wedged, not when it threw. Nothing ever waits on the renderer, so nothing can
 * deadlock: it is a race the window always eventually wins.
 *
 * Rule 2 is also what keeps the wait off the common path. An ack runs on the
 * renderer's main thread, which a streaming turn can block for a good while, so
 * the timeout below has to be generous — and a generous timeout would be a
 * generous delay on **every** Cmd+W if it applied to windows that were never
 * going to answer.
 */

/** Channel the main process asks a renderer to close a tab on. */
const CLOSE_TAB_CHANNEL = 'close-tab';

/** Channel the renderer replies on (mirrored in `src/preload/index.ts`). */
const CLOSE_TAB_ACK_CHANNEL = 'close-tab:ack';

/** Channel a renderer claims the keystroke on (mirrored in `src/preload/index.ts`). */
const CLOSE_TAB_SUBSCRIBE_CHANNEL = 'close-tab:subscribe';

/** Channel a renderer gives the keystroke back on (mirrored in `src/preload/index.ts`). */
const CLOSE_TAB_UNSUBSCRIBE_CHANNEL = 'close-tab:unsubscribe';

/**
 * How long a **subscribed** renderer gets to answer before the window closes.
 *
 * Deliberately generous, because of what the two outcomes cost. Waiting too
 * long looks like a slow app for a moment; giving up too early destroys a
 * window full of tabs the person did not ask to lose, and can even close the
 * tab *and* the window if the answer lands just after the deadline. A renderer
 * blocked mid-turn on a large transcript can miss a snappy budget by a wide
 * margin, so this is sized as a wedged-renderer backstop rather than a response
 * budget. It is not on the common path: an unsubscribed window closes with no
 * wait at all.
 */
const ACK_TIMEOUT_MS = 3_000;

/** A close-tab request waiting on its renderer. */
interface PendingRequest {
  timeout: ReturnType<typeof setTimeout>;
  /** Which renderer was asked — an ack from anywhere else is ignored. */
  webContentsId: number;
  window: BrowserWindow;
}

let nextRequestId = 1;
const pending = new Map<number, PendingRequest>();

/** `webContents.id`s whose renderer has claimed `Cmd/Ctrl+W`. */
const subscribers = new Set<number>();

/** Whether {@link setupCloseTab} has already registered its listeners. */
let installed = false;

/**
 * Clear pending requests, subscribers and the install guard.
 *
 * @internal Exported for testing only.
 */
export function resetCloseTab(): void {
  for (const request of pending.values()) clearTimeout(request.timeout);
  pending.clear();
  subscribers.clear();
  nextRequestId = 1;
  installed = false;
}

/**
 * Register the renderer-facing channels. Call once, before any window exists.
 */
export function setupCloseTab(): void {
  if (installed) return;
  installed = true;

  ipcMain.on(CLOSE_TAB_SUBSCRIBE_CHANNEL, (event: Electron.IpcMainEvent) => {
    const { id } = event.sender;
    subscribers.add(id);
    // A destroyed renderer must not go on claiming the keystroke. `id` is
    // unique per WebContents instance, so this is housekeeping rather than a
    // correctness fix — but an unbounded set of dead ids is its own bug.
    event.sender.once('destroyed', () => subscribers.delete(id));
  });

  ipcMain.on(CLOSE_TAB_UNSUBSCRIBE_CHANNEL, (event: Electron.IpcMainEvent) => {
    subscribers.delete(event.sender.id);
  });

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
 * Ask `win`'s renderer to close a tab, and close the window if it does not — or
 * close the window straight away if its renderer never claimed the keystroke.
 *
 * @param win - The focused window, or `null` when nothing is focused (a no-op).
 */
export function requestCloseTab(win: BrowserWindow | null): void {
  if (!win || win.isDestroyed()) return;

  const { id } = win.webContents;
  if (!subscribers.has(id)) {
    closeWindow(win);
    return;
  }

  const requestId = nextRequestId++;
  const timeout = setTimeout(() => {
    pending.delete(requestId);
    closeWindow(win);
  }, ACK_TIMEOUT_MS);

  pending.set(requestId, { timeout, webContentsId: id, window: win });
  win.webContents.send(CLOSE_TAB_CHANNEL, requestId);
}

/** Close a window that may have been destroyed while its renderer was thinking. */
function closeWindow(win: BrowserWindow): void {
  if (win.isDestroyed()) return;
  win.close();
}
