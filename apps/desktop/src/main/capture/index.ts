/**
 * "Capture app view" — a picture of this window, taken by the shell rather than
 * drawn by the page (feedback-attachments decision 6).
 *
 * The feedback dialog can attach a screenshot, and in a browser it has to build
 * one out of the DOM: serialize the app into an SVG, render that, hope every
 * font and shadow came along. Inside the desktop app there is a real window and
 * a real compositor, so `webContents.capturePage()` answers the same question
 * exactly — the pixels the person is looking at, in one call, with no rendering
 * engine of our own to be wrong.
 *
 * It captures the **sender's own page** and nothing else: not the desktop, not
 * another window, not a second app. That is what lets the dialog promise "only
 * the app, never the rest of your screen" and mean it.
 *
 * The renderer hides its own dialog and waits for a repaint before asking (see
 * `shared/lib/app-capture.ts` in the client), because the picture is of the
 * window as it stands and the dialog is standing in front of the thing being
 * reported.
 *
 * @module main/capture
 */
import { ipcMain } from 'electron';
import log from 'electron-log';
import { isCockpitSender } from '../window-manager';

/** IPC channel "Capture app view" arrives on (mirrored in `preload/index.ts`). */
const CAPTURE_APP_VIEW_CHANNEL = 'capture:app-view';

/**
 * What a capture answers with: a PNG `data:` URL, or why there is no picture.
 *
 * A result rather than a thrown error, for the reason
 * {@link import('../admin').AdminActionResult} spells out — Electron wraps
 * whatever an IPC handler throws into `Error invoking remote method '…'`, and a
 * renderer must never put that in front of a person.
 *
 * Mirrored in the client as `DesktopCaptureResult` (`apps/client/src/vite-env.d.ts`).
 */
export type CaptureAppViewResult = { ok: true; dataUrl: string } | { ok: false; message: string };

/** Options for {@link setupAppViewCapture}. */
export interface AppViewCaptureOptions {
  /**
   * Live accessor for the app's own origin, shared with the windows themselves
   * so "is this our own page?" has one answer. Read fresh on every call: the
   * server's port moves across a restart.
   */
  getRendererUrl: () => string | undefined;
}

/**
 * What a person is told when no picture came back.
 *
 * One sentence for every failure on purpose. The reasons a capture can fail —
 * a compositor that had no frame to give, a window mid-teardown — are not
 * distinctions anyone can act on, and the action is the same either way: attach
 * a screenshot by hand instead, which the same dialog already offers.
 */
const CAPTURE_FAILED_MESSAGE = 'DorkOS couldn’t get a picture of this window.';

/**
 * Register the capture channel the preload bridge exposes.
 *
 * Call once, before the window is created, alongside the other IPC setup in
 * `index.ts`.
 *
 * @param options - See {@link AppViewCaptureOptions}.
 */
export function setupAppViewCapture(options: AppViewCaptureOptions): void {
  ipcMain.handle(CAPTURE_APP_VIEW_CHANNEL, async (event): Promise<CaptureAppViewResult> => {
    if (!isCockpitSender(event, options.getRendererUrl)) {
      return { ok: false, message: 'DorkOS only takes this from its own window.' };
    }
    try {
      const image = await event.sender.capturePage();
      // An empty image is what a capture that could not read the surface comes
      // back as — no throw, just nothing. `toDataURL()` would happily encode it
      // into a valid `data:` URL of no pixels, and the dialog would attach a
      // blank picture to a bug report as though it had worked.
      if (image.isEmpty()) return { ok: false, message: CAPTURE_FAILED_MESSAGE };
      return { ok: true, dataUrl: image.toDataURL() };
    } catch (err) {
      log.error('[capture] Capturing the app view failed.', err);
      return { ok: false, message: CAPTURE_FAILED_MESSAGE };
    }
  });
}
