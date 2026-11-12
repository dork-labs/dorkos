/**
 * The two guards on one app opening another app's page (DOR-3293, Security's
 * Must, Nov 11).
 *
 * - **A fresh gesture in the calling frame** ({@link frameHasGesture}). The
 *   host cannot see input inside a sandboxed cross-origin frame, so it reads
 *   two things only the browser and the person control: the window's own
 *   transient user activation, which a real click or key press in a child
 *   frame raises in its ancestors and no script can set, and which element
 *   has focus, which must be the calling app's own `<iframe>`. Together they
 *   mean the person acted inside THAT app; activation alone would let one app
 *   ride a click made in another. "Fresh" is the browser's own transient
 *   activation window, which it sets (a few seconds in current browsers), not
 *   a timer of ours: the host cannot time a click it cannot see.
 * - **One open per gesture.** An honoured open spends that activation: no
 *   other cross-app open is honoured until the browser reports the activation
 *   over and a new click raises it again. Without this, an app could put focus
 *   back on its own frame and open a second page on the same click.
 * - **A pause on arrival** ({@link arriveAtAppPage}). For 500 ms from the start
 *   of the navigation, pointer and key input to the whole window is dropped,
 *   so a click timed for the old page can't land on the new one. The new page
 *   fades in over 150 ms so the person sees it arrive; under reduced motion it
 *   appears at once, and the pause still applies. No spinner, no cursor change.
 *
 * @module features/extensions/frame/app-arrival
 */
import { DURATION, EASE } from '@/layers/shared/lib/motion';

/** How long input is dropped after an app opens another app's page. */
export const ARRIVAL_PAUSE_MS = 500;

/**
 * The routed page that fades in: the app shell's `<main>` (`APP_TAB_PANEL_ID`
 * in `features/app-tabs`, named here because one feature never imports another).
 */
const PAGE_ID = 'app-tab-panel';

/** Every pointer and key event that could act on the page. */
const DROPPED_INPUT = [
  'pointerdown',
  'pointerup',
  'mousedown',
  'mouseup',
  'click',
  'dblclick',
  'auxclick',
  'contextmenu',
  'touchstart',
  'touchend',
  'keydown',
  'keypress',
  'keyup',
] as const;

/** How often a spent activation is checked for having run out. */
const SPENT_POLL_MS = 100;

let paused = false;
let spent = false;
let spentWatch: ReturnType<typeof setInterval> | undefined;
let release: ReturnType<typeof setTimeout> | undefined;
let madeInert = false;
let listening = false;

/** Drop one input event while the pause holds. */
function drop(event: Event): void {
  if (!paused) return;
  event.preventDefault();
  event.stopImmediatePropagation();
}

/** End the pause: input reaches the page again. */
function endPause(): void {
  paused = false;
  release = undefined;
  if (madeInert) document.body.removeAttribute('inert');
  madeInert = false;
}

/**
 * Whether the person acted inside this frame just now: the window has
 * transient user activation, and focus is on this very `<iframe>`.
 *
 * Fails closed where the browser has no `navigator.userActivation`.
 *
 * @param iframe - The calling app's frame, as the host created it.
 */
export function frameHasGesture(iframe: HTMLIFrameElement | null): boolean {
  if (iframe === null || spent || !('userActivation' in navigator)) return false;
  return navigator.userActivation.isActive && document.activeElement === iframe;
}

/**
 * Spend the current activation on one open. It stays spent until the browser
 * reports the activation over, so only a new click counts again.
 */
function spendGesture(): void {
  spent = true;
  if (spentWatch !== undefined) clearInterval(spentWatch);
  spentWatch = setInterval(() => {
    if ('userActivation' in navigator && navigator.userActivation.isActive) return;
    spent = false;
    clearInterval(spentWatch);
    spentWatch = undefined;
  }, SPENT_POLL_MS);
}

/**
 * Open another app's page behind the arrival guard: the gesture is spent and
 * the pause starts first, then `go` moves the page, then the page fades in.
 *
 * @param go - Moves the router to the new page.
 */
export function arriveAtAppPage(go: () => void): void {
  spendGesture();
  if (!listening) {
    for (const type of DROPPED_INPUT) window.addEventListener(type, drop, { capture: true });
    listening = true;
  }
  paused = true;
  if (release !== undefined) clearTimeout(release);
  release = setTimeout(endPause, ARRIVAL_PAUSE_MS);
  // Frames take their own input, which the window never sees: inert keeps the
  // pointer out of them, and moving focus out sends keys to the window.
  if (!document.body.hasAttribute('inert')) {
    document.body.setAttribute('inert', '');
    madeInert = true;
  }
  if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  go();
  fadeIn();
}

/** Fade the routed page in, unless the person asks for less motion. */
function fadeIn(): void {
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
  const page = document.getElementById(PAGE_ID);
  if (typeof page?.animate !== 'function') return;
  page.animate([{ opacity: 0 }, { opacity: 1 }], {
    duration: DURATION.fast * 1000,
    easing: `cubic-bezier(${EASE.out.join(', ')})`,
  });
}

/** End any pause, and any spent gesture, now. Test seam; nothing in the app calls it. */
export function resetArrivalPause(): void {
  if (release !== undefined) clearTimeout(release);
  endPause();
  if (spentWatch !== undefined) clearInterval(spentWatch);
  spentWatch = undefined;
  spent = false;
}
