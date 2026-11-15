/**
 * Whether the person acted inside one app's frame just now, which is what lets
 * that app open another app's page (DOR-3293, Security's Musts, Nov 15).
 *
 * The host cannot see input inside a sandboxed cross-origin frame. What it can
 * see is its own page's input, where focus is, and the window's transient user
 * activation, which only real input raises. A gesture counts only when all of
 * these hold:
 *
 * 1. **The activation is live, and no input to the host's own page touched it.**
 *    A capture listener on the host window counts every trusted pointer, touch
 *    and key event. Any of them since the activation was last seen down makes the
 *    current activation the host's, not the frame's.
 * 2. **Focus moved into this very frame while the host watched, and the host has
 *    had no input since.** The host saw its window blur with the frame focused,
 *    or the frame already had focus when the fence started. A frame that focuses
 *    itself gets no activation from it, and a later host click falls to rule 1.
 * 3. **Spent once, failed closed.** An honoured open spends the activation until
 *    the browser reports it over. No `navigator.userActivation`, no gesture.
 *
 * "Fresh" is the browser's own activation window, not a timer here: the host
 * cannot time a click it cannot see.
 *
 * @module features/extensions/frame/gesture-fence
 */

/** Input to the host's own page that can raise, or keep up, an activation. */
const HOST_INPUT = [
  'pointerdown',
  'pointerup',
  'mousedown',
  'touchstart',
  'touchend',
  'keydown',
] as const;

/** How often a touched or spent activation is checked for having run out. */
const ACTIVATION_POLL_MS = 100;

/** Host input events counted so far. */
let hostInputs = 0;
/** The count when the activation was last seen down; more since means the host touched it. */
let hostInputsAtRest = 0;
/** The frame focus moved into while the host watched, and the count at that moment. */
let focusedFrame: HTMLIFrameElement | null = null;
let hostInputsAtFocus = 0;
let spent = false;
let watch: ReturnType<typeof setInterval> | undefined;
let installed = false;

/** Whether the browser says the window has transient user activation now. */
function activationLive(): boolean {
  return 'userActivation' in navigator && navigator.userActivation.isActive;
}

/** Watch for the activation to run out, which clears host input and a spent gesture. */
function watchActivation(): void {
  if (watch !== undefined) return;
  watch = setInterval(() => {
    if (activationLive()) return;
    hostInputsAtRest = hostInputs;
    spent = false;
    clearInterval(watch);
    watch = undefined;
  }, ACTIVATION_POLL_MS);
}

/**
 * Count one event on the host's own page. Script-made events are not input.
 *
 * @internal Exported for testing only: jsdom cannot make a trusted event.
 * @param event - The event the host window's capture listener saw.
 */
export function noteHostInput(event: Pick<Event, 'isTrusted'>): void {
  if (!event.isTrusted) return;
  hostInputs += 1;
  watchActivation();
}

/** Note the frame focus moved into, when the host window loses focus to one. */
function noteFocusLeft(): void {
  const active = document.activeElement;
  if (!(active instanceof HTMLIFrameElement)) return;
  focusedFrame = active;
  hostInputsAtFocus = hostInputs;
}

/**
 * Start the fence, once. An activation already live at this point began
 * before the host was watching, so it counts as the host's until it ends.
 */
function install(): void {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  for (const type of HOST_INPUT) window.addEventListener(type, noteHostInput, { capture: true });
  window.addEventListener('blur', noteFocusLeft);
  if (document.activeElement instanceof HTMLIFrameElement) noteFocusLeft();
  if (activationLive()) {
    hostInputs += 1;
    watchActivation();
  }
}

/**
 * Whether the person acted inside this frame just now: rules 1 to 3 above.
 *
 * @param iframe - The calling app's frame, as the host created it.
 */
export function frameHasGesture(iframe: HTMLIFrameElement | null): boolean {
  if (iframe === null || spent || !activationLive()) return false;
  if (hostInputs !== hostInputsAtRest) return false;
  if (focusedFrame !== iframe || hostInputs !== hostInputsAtFocus) return false;
  return document.activeElement === iframe;
}

/**
 * Spend the current activation on one open. It stays spent until the browser
 * reports the activation over, so only a new click counts again.
 */
export function spendGesture(): void {
  spent = true;
  watchActivation();
}

/** Forget everything the fence has seen. Test seam; nothing in the app calls it. */
export function resetGestureFence(): void {
  if (watch !== undefined) clearInterval(watch);
  watch = undefined;
  hostInputs = 0;
  hostInputsAtRest = 0;
  focusedFrame = null;
  hostInputsAtFocus = 0;
  spent = false;
}

install();
