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
 * no business in the bundle that has to paint the first screen. It is also
 * pinned to an EXACT version in `apps/client/package.json`, which a
 * `package.json` cannot explain in place: this library walks and re-serializes
 * the entire rendered DOM of the app, so a patch release lands inside the
 * screenshot a person is about to send us. That blast radius is worth reviewing
 * a version bump for, rather than picking one up silently from a caret range.
 *
 * **What it captures is the app and nothing else.** Both paths photograph this
 * one page: never the desktop, never another window, never another app. That is
 * the whole of the promise the dialog makes next to the button, and it is kept
 * here rather than being asserted there.
 *
 * **Nothing can report progress while the picture is being taken**, and that is
 * deliberate rather than an oversight: the only place a spinner could live is
 * the dialog, and the dialog is precisely what has to be invisible for the
 * capture to be worth having. So the app looks frozen for as long as this takes,
 * and the honest mitigation is a bound rather than a cue —
 * {@link APP_CAPTURE_TIMEOUT_MS} is the longest that state can last, after which
 * the app comes back and says what happened.
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

/**
 * How long a capture may run before it is called off.
 *
 * The bound on the one state nothing can report from: while the picture is being
 * taken the dialog is invisible, so a capture that never settles is an app that
 * never comes back. Generous, because a full-page re-draw on a slow machine is
 * genuinely slow and cutting a working capture short would be the worse failure
 * — but finite, which is the whole point.
 *
 * Calling off does not stop the work underneath (neither snapdom nor an IPC
 * round-trip is cancellable); it restores the app and reports a refusal, and
 * whatever the abandoned capture eventually produces is dropped.
 */
export const APP_CAPTURE_TIMEOUT_MS = 20_000;

/**
 * The slice of the page a capture actually covers, in CSS pixels of the current
 * viewport — the same coordinate space `getBoundingClientRect()` speaks.
 *
 * The two capture paths do NOT frame the same thing, and a caller that wants to
 * find one element inside the picture cannot work without knowing which it got.
 * The shell photographs the window, so its region is the viewport at the origin.
 * The DOM path re-draws `#root`, which on a page taller than the window extends
 * well past the bottom of it — and, once the window is scrolled, starts ABOVE
 * it, at a negative `top`. Reporting the region rather than assuming one is what
 * lets a caller cropping to a single element land on the right pixels under
 * either path (the feedback dialog's "Point at element" is the one that does).
 */
export interface AppCaptureRegion {
  /** Distance from the viewport's left edge to the picture's left edge, in CSS px. */
  left: number;
  /** Distance from the viewport's top edge to the picture's top edge, in CSS px. */
  top: number;
  /** Width of the captured slice, in CSS px. */
  width: number;
  /** Height of the captured slice, in CSS px. */
  height: number;
}

/** One picture of the app, and what part of the page it covers. */
export interface AppCaptureShot {
  /** The captured image as a `data:` URL, un-compressed. */
  dataUrl: string;
  /** What the picture covers, in CSS pixels — see {@link AppCaptureRegion}. */
  region: AppCaptureRegion;
}

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
 * reported, and so is its overlay and any toast. All of them are portaled as
 * direct children of `<body>` (Radix's dialog, Vaul's drawer and Sonner all
 * do), so "everything above the app" is exactly "every body child that is not
 * the app root" — and each of those children is a portal WRAPPER, which is the
 * right element to write on: the dialog panel inside it carries
 * `animate-in fade-in-0` with `fill-mode: both`, and an animation's filled
 * opacity beats an inline one. The wrapper carries no animation, so nothing
 * competes with it.
 *
 * **`opacity: 0`, never `visibility: hidden`.** Hiding a focused subtree by
 * visibility blurs `document.activeElement` to `<body>` and it does not come
 * back when the style is undone (measured in a real Chromium against this exact
 * DOM). The person loses their caret mid-sentence, and — worse — the paste path
 * dies with it, because React's `onPaste` sits on the portaled dialog and never
 * sees an event delivered to the body. Zero opacity paints nothing while
 * keeping the box, the focus and the hit-testing exactly as they were.
 *
 * Inline rather than a class, and the previous inline value is put back exactly
 * as it was found rather than blanked — a floating element its own author had
 * already hidden stays hidden.
 *
 * **This is load-bearing only for the desktop capture.** On the web path snapdom
 * shoots `#root`, and the portals are its siblings, so they were never in frame
 * to begin with; the shell's `capturePage()` photographs the whole window, which
 * is what makes hiding necessary at all. It runs on both paths anyway, so there
 * is one sequence to reason about rather than two.
 */
function hideFloatingChrome(): () => void {
  const restores: Array<() => void> = [];
  for (const child of Array.from(document.body.children)) {
    if (!(child instanceof HTMLElement) || child.id === APP_ROOT_ID) continue;
    const previous = child.style.opacity;
    child.style.opacity = '0';
    restores.push(() => {
      child.style.opacity = previous;
    });
  }
  return () => {
    for (const restore of restores) restore();
  };
}

/** Take the picture through the desktop shell's own compositor. */
async function captureThroughShell(
  capture: () => Promise<DesktopCaptureResult>
): Promise<AppCaptureShot> {
  // Contractually this never rejects (see the preload's `captureAppView`), but a
  // bridge that is somehow broken must not escape as an unhandled rejection.
  const result = await capture().catch((error: unknown) => {
    throw new AppCaptureError('failed', `The desktop bridge threw: ${String(error)}`);
  });
  if (!result.ok) throw new AppCaptureError('failed', result.message);
  // `capturePage()` photographs the window's whole web contents, which is the
  // viewport and exactly the viewport — so the picture's origin IS the origin
  // every `getBoundingClientRect()` in the app is already measured from.
  return {
    dataUrl: result.dataUrl,
    region: { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight },
  };
}

/** Re-draw the app from its own DOM, in a browser that has no window to photograph. */
async function captureThroughDom(): Promise<AppCaptureShot> {
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
    // Measured before the render, not after: snapdom walks and re-serializes the
    // tree, which is long enough for a scroll or a resize to move the box out
    // from under a rect taken afterwards.
    const box = element.getBoundingClientRect();
    const image = await snapdom.toPng(element, { backgroundColor });
    return {
      dataUrl: image.src,
      region: { left: box.left, top: box.top, width: box.width, height: box.height },
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new AppCaptureError('failed', `Rendering the app to an image failed: ${detail}`);
  }
}

/**
 * Give up on a capture that is taking too long, without waiting for it.
 *
 * @param capture - The capture in progress.
 * @throws AppCaptureError When {@link APP_CAPTURE_TIMEOUT_MS} passes first.
 */
async function withTimeout(capture: Promise<AppCaptureShot>): Promise<AppCaptureShot> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(
        new AppCaptureError('failed', `The capture did not finish in ${APP_CAPTURE_TIMEOUT_MS}ms.`)
      );
    }, APP_CAPTURE_TIMEOUT_MS);
  });
  try {
    return await Promise.race([capture, expiry]);
  } finally {
    clearTimeout(timer);
    // The loser of the race is abandoned, not cancelled. Its rejection would
    // otherwise arrive with nobody left holding it.
    capture.catch(() => {});
  }
}

/** One capture, start to finish: hide, wait for paint, shoot, restore. */
async function runCapture(): Promise<AppCaptureShot> {
  const desktop = getDesktopCapture();
  const restoreChrome = hideFloatingChrome();
  try {
    await nextPaint();
    return await withTimeout(desktop ? captureThroughShell(desktop) : captureThroughDom());
  } finally {
    restoreChrome();
  }
}

/**
 * The capture in progress, so a second request joins it instead of starting one.
 *
 * Two overlapping captures would corrupt each other through the save-and-restore
 * ledger, and the damage outlives them both: the second one reads the FIRST
 * one's already-hidden values as "how this was found", and restores the app to
 * invisible — permanently, behind a modal dialog nobody can now see to close.
 * Sharing one run makes that impossible rather than merely unlikely, which is
 * the right shape for a guard whose failure has no recovery.
 */
let inFlight: Promise<AppCaptureShot> | null = null;

/**
 * Take a picture of the app as it stands, and say what part of the page it
 * covers.
 *
 * Hides the dialog (and anything else above the app), waits for that to be on
 * screen, captures, then puts everything back — whatever happened. Feed the
 * `dataUrl` to `compressImage`, which owns the size bound every screenshot has
 * to fit; nothing here is bounded.
 *
 * **Not reentrant, and answers a concurrent caller with the capture already
 * running** rather than starting a second one. Two at once cannot produce two
 * pictures worth having anyway — they would photograph each other's hidden
 * state — and the state they share is not safely interleavable.
 *
 * @returns The un-compressed picture and its {@link AppCaptureRegion}.
 * @throws AppCaptureError When the capture produced no picture, took longer than
 *   {@link APP_CAPTURE_TIMEOUT_MS}, or the screenshot library could not be
 *   loaded.
 */
export function captureAppShot(): Promise<AppCaptureShot> {
  if (inFlight) return inFlight;
  const run = runCapture();
  inFlight = run;
  // `then(settle, settle)` rather than `finally`: it handles the rejection on
  // THIS chain, so releasing the slot can never surface as an unhandled one,
  // while the caller still gets the original promise to fail on.
  const settle = (): void => {
    if (inFlight === run) inFlight = null;
  };
  void run.then(settle, settle);
  return run;
}

/**
 * Take a picture of the app as it stands — for the caller that wants the whole
 * frame and has no use for where it sits on the page.
 *
 * The same single capture as {@link captureAppShot}, sharing its one-at-a-time
 * guard: this is that call with the region dropped, not a second way to take a
 * picture. Most callers want this one; only a crop needs the region.
 *
 * @returns A `data:` URL of the app view, un-compressed.
 * @throws AppCaptureError For any of {@link captureAppShot}'s refusals.
 */
export function captureAppView(): Promise<string> {
  return captureAppShot().then((shot) => shot.dataUrl);
}
