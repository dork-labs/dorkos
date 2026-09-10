/**
 * One click, one picture of the app — for a feedback report (feedback-attachments
 * PR 3).
 *
 * Two ways to take it, and the difference matters. Inside the desktop shell
 * there is a real window and a real compositor, so the shell photographs it
 * (`window.electronAPI.captureAppView()`): pixel-for-pixel what the person is
 * looking at. In a browser there is no such call, so the app is re-drawn from
 * its own DOM — {@link https://github.com/zumerlab/snapdom | snapdom} serializes
 * it into an SVG the browser then rasterizes, which is why oklch colours and
 * Tailwind 4's cascade layers survive: the browser evaluates its own CSS.
 *
 * **snapdom is loaded only when someone actually captures.** The import is
 * dynamic on purpose — a screenshot library nobody in a given session uses has
 * no business in the bundle that has to paint the first screen.
 *
 * **What it captures is the app and nothing else.** Both paths photograph this
 * one page: never the desktop, never another window, never another app. That is
 * the whole of the promise the dialog makes next to the button, and it is kept
 * here rather than being asserted there.
 *
 * @module shared/lib/app-capture
 */

/**
 * The element the whole app renders into (`index.html`).
 *
 * The DOM path captures this rather than `<body>`, because everything floating
 * ABOVE the app — a dialog, its overlay, a toast — is portaled to the body and
 * is not part of the picture anyone wants of a bug.
 */
const APP_ROOT_ID = 'root';

/** Why {@link captureAppView} came back with no picture. */
export type AppCaptureReason =
  /** The capture ran and produced nothing — a refusal, a throw, an empty image. */
  | 'failed'
  /** The screenshot library could not be loaded at all, so nothing ran. */
  | 'unsupported';

/**
 * A refusal from {@link captureAppView}, carrying WHY so the caller can say
 * something specific rather than a generic failure.
 *
 * The reason is a closed union rather than a message, matching
 * {@link import('./image-compress').ImageCompressError} — the surface showing a
 * refusal owns its wording, and a surface that has to pattern-match an error
 * message is one refactor away from showing nothing.
 */
export class AppCaptureError extends Error {
  /** Which of the two refusals this is. */
  readonly reason: AppCaptureReason;

  /**
   * Build a refusal.
   *
   * @param reason - Which refusal this is.
   * @param message - Developer-facing detail; never shown to the user verbatim.
   */
  constructor(reason: AppCaptureReason, message: string) {
    super(message);
    this.name = 'AppCaptureError';
    this.reason = reason;
  }
}

/**
 * The desktop shell's capture call, or `null` when there isn't one.
 *
 * Feature-detects the **method**, not the bridge object — the rule every other
 * `electronAPI` consumer here follows (`desktop-admin.ts`, `platform.ts`,
 * `api-base-url.ts`). A desktop build older than this exposes nothing and
 * correctly falls through to the DOM path, which works there too.
 */
function getDesktopCapture(): (() => Promise<DesktopCaptureResult>) | null {
  const api = typeof window !== 'undefined' ? window.electronAPI : undefined;
  if (typeof api?.captureAppView !== 'function') return null;
  const { captureAppView: capture } = api;
  return () => capture();
}

/**
 * Wait until the browser has painted whatever the DOM currently says.
 *
 * Two frames, not one: a callback registered with `requestAnimationFrame` runs
 * BEFORE the frame it was registered for is painted, so the earliest moment a
 * change is known to be on screen is inside the frame after it. This is what
 * makes hiding the dialog real rather than merely intended — the shell's
 * capture reads the compositor, so it would otherwise photograph the frame the
 * dialog was still in.
 */
function nextPaint(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });
}

/**
 * Hide everything floating above the app, and hand back the undo.
 *
 * The dialog that asks for the picture is standing in front of the thing being
 * reported, and so is its overlay and any toast. All three are portaled as
 * direct children of `<body>` (Radix's dialog, Vaul's drawer and Sonner all
 * do), so "everything above the app" is exactly "every body child that is not
 * the app root".
 *
 * `visibility` rather than `display`, and inline rather than a class: hidden
 * visibility keeps every element's box where it was, so nothing in the app
 * below reflows into the picture, and the previous inline value is put back
 * exactly as it was found rather than blanked.
 */
function hideFloatingChrome(): () => void {
  const restores: Array<() => void> = [];
  for (const child of Array.from(document.body.children)) {
    if (!(child instanceof HTMLElement) || child.id === APP_ROOT_ID) continue;
    const previous = child.style.visibility;
    child.style.visibility = 'hidden';
    restores.push(() => {
      child.style.visibility = previous;
    });
  }
  return () => {
    for (const restore of restores) restore();
  };
}

/** Take the picture through the desktop shell's own compositor. */
async function captureThroughShell(capture: () => Promise<DesktopCaptureResult>): Promise<string> {
  // Contractually this never rejects (see the preload's `captureAppView`), but a
  // bridge that is somehow broken must not escape as an unhandled rejection.
  const result = await capture().catch((error: unknown) => {
    throw new AppCaptureError('failed', `The desktop bridge threw: ${String(error)}`);
  });
  if (!result.ok) throw new AppCaptureError('failed', result.message);
  return result.dataUrl;
}

/** Re-draw the app from its own DOM, in a browser that has no window to photograph. */
async function captureThroughDom(): Promise<string> {
  let snapdom: typeof import('@zumer/snapdom').snapdom;
  try {
    ({ snapdom } = await import('@zumer/snapdom'));
  } catch (error) {
    // Usually a chunk deleted by a redeploy while this tab stayed open. Its own
    // reason is not worth telling apart: nothing ran, so the advice is the same
    // one every time (reload), and it is different advice to what a capture
    // that ran and failed earns.
    const detail = error instanceof Error ? error.message : String(error);
    throw new AppCaptureError('unsupported', `Loading the screenshot library failed: ${detail}`);
  }

  // The app root has no background of its own — the page's colour is on
  // `<body>` — so a capture of it alone comes back with transparent gaps. Read
  // the real one rather than naming a colour here, which would be a second
  // source of truth for the theme and wrong in one of the two themes.
  const element = document.getElementById(APP_ROOT_ID) ?? document.body;
  const backgroundColor = getComputedStyle(document.body).backgroundColor;
  try {
    const image = await snapdom.toPng(element, { backgroundColor });
    return image.src;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new AppCaptureError('failed', `Rendering the app to an image failed: ${detail}`);
  }
}

/**
 * Take a picture of the app as it stands.
 *
 * Hides the dialog (and anything else above the app), waits for that to be on
 * screen, captures, then puts everything back — whatever happened. Feed the
 * result to `compressImage`, which owns the size bound every screenshot has to
 * fit; nothing here is bounded.
 *
 * @returns A `data:` URL of the app view, un-compressed.
 * @throws AppCaptureError When the capture produced no picture, or the
 *   screenshot library could not be loaded.
 */
export async function captureAppView(): Promise<string> {
  const desktop = getDesktopCapture();
  const restoreChrome = hideFloatingChrome();
  try {
    await nextPaint();
    return desktop ? await captureThroughShell(desktop) : await captureThroughDom();
  } finally {
    restoreChrome();
  }
}
