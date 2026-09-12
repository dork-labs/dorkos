/**
 * What a driving round trip says when it cannot happen, and the seam it rides.
 *
 * Three different things can be true when an agent asks to click something, and
 * telling them apart is the whole point of this file: nothing is open, something
 * is open that DorkOS is not instrumenting, or the page was asked and did not
 * answer. Collapsing them into one note is what made the old screenshot path
 * wait eight seconds to say something misleading.
 *
 * @module services/session/browser-seat/act-protocol
 */
import type { StreamEvent } from '@dorkos/shared/types';

/**
 * The per-turn event queue a driving request is pushed onto — the same seam
 * `control_ui` uses for `ui_command`, drained into the session's durable stream
 * and from there to the window that was addressed.
 */
export interface SessionEventSink {
  /** The per-turn StreamEvent queue drained into the durable session stream. */
  eventQueue: StreamEvent[];
  /** Wakes the queue drainer after a push. */
  eventQueueNotify?: () => void;
}

/**
 * Nothing is open to drive. Verbatim what `browser_screenshot` has always said,
 * because it already tells the agent exactly what to do next and already says
 * which pages can be instrumented.
 */
export const NO_PREVIEW_NOTE =
  'No preview is open for this session yet, so nothing has been captured. Open a local ' +
  'preview with browser_navigate first (a local HTML file or a localhost dev server); ' +
  'external sites and pages with a strict Content-Security-Policy are not instrumented.';

/**
 * Something is open somewhere, but no window is showing a browser page right
 * now — every claim was released when the tabs were closed.
 */
export const NO_DRIVER_NOTE =
  'No window is showing a browser preview for this session right now, so there is nothing ' +
  'to drive. Open one with browser_navigate, or bring the window with the preview to the front.';

/** A page was named by id, and no window is holding it any more. */
export const UNKNOWN_DOCUMENT_NOTE =
  'No window has that page open any more. Call get_ui_state to see which browser tabs are open.';

/**
 * The page is open and rendering, and DorkOS put nothing in it — an external
 * site, or a dev server framed by its own address. Answered at once rather than
 * after a timeout, because nothing there was ever going to reply.
 */
export const NOT_INSTRUMENTED_NOTE =
  'That page is open but DorkOS is not instrumenting it, so it cannot be driven or read from ' +
  'here. A local file or a dev server preview can be; a page loaded straight from the internet ' +
  'cannot.';

/**
 * The sentence every driving tool's description carries, because it is what a
 * person deciding whether to approve the call needs to know.
 */
export const DRIVING_SAFETY_SENTENCE =
  'It acts only inside the preview frame, on the page you are already looking at, and it ' +
  'cannot reach DorkOS itself. On a page DorkOS serves that frame has no sign-in and no ' +
  'origin of its own; on a dev server preview it is that dev server, so it acts there exactly ' +
  'as a person clicking in it would — including anything that page is already signed in to.';

/**
 * The failure sentence for a request the page never answered.
 *
 * Names the verb and the wait, so the agent can tell "the page is busy" from
 * "the window went away" and decide whether trying again is worth a turn.
 *
 * @param verb - The tool that asked, by its own name.
 * @param timeoutMs - How long it waited.
 */
export function drivingTimeoutNote(verb: string, timeoutMs: number): string {
  return (
    `${verb} waited ${Math.round(timeoutMs / 1000)}s and the page never answered. The window ` +
    'showing it may have been closed or reloaded. Call get_ui_state to see what is open, then ' +
    'try again.'
  );
}
