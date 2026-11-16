/**
 * The pause after one app opens another app's page (DOR-3293, Security's
 * Must, Nov 11). Whether the open may happen at all is the gesture fence's
 * call (`gesture-fence.ts`); an honoured open spends that gesture here.
 *
 * For 500 ms from the start of the navigation ({@link arriveAtAppPage}),
 * pointer and key input to the whole window is dropped, so a click timed for
 * the old page can't land on the new one. The new page fades in over 150 ms so
 * the person sees it arrive; under reduced motion it appears at once, and the
 * pause still applies. No spinner, no cursor change.
 *
 * @module features/extensions/frame/app-arrival
 */
import { DURATION, EASE } from '@/layers/shared/lib/motion';
import { resetGestureFence, spendGesture } from './gesture-fence';

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

let paused = false;
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
  resetGestureFence();
}
