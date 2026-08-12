/**
 * "The operator is in here" — the one signal every hands-off rule is built on.
 *
 * BC-17 wrote it first, for Today's order: rows must not move under a cursor
 * that is about to click them. The Getting-started slot needs the same fact for
 * a different reason (a zone must not come back under a hand either), and one
 * pair of booleans wired to one set of handlers is how the two stay the same
 * rule rather than becoming two rules that drift.
 *
 * @module features/dashboard-sidebar/model/holds/use-inside-hold
 */
import { useCallback, useState } from 'react';

/**
 * Spread onto the element the hold is about.
 *
 * Pointer and focus both, because a keyboard has no pointer and the promise is
 * about neither device in particular: it is about not moving what somebody is
 * aiming at.
 */
export interface InsideHoldHandlers {
  /** The pointer crossed into the element. */
  onPointerEnter: () => void;
  /** …and back out of it. */
  onPointerLeave: () => void;
  /** Something inside took focus. */
  onFocus: () => void;
  /** …and gave it up. */
  onBlur: () => void;
}

/** What {@link useInsideHold} hands back. */
export interface InsideHold {
  /** Whether the operator's pointer or focus is currently inside. */
  inside: boolean;
  /** The four handlers that answer it. */
  handlers: InsideHoldHandlers;
}

/**
 * Track whether the operator is inside an element, by pointer or by focus.
 *
 * `onFocus`/`onBlur` rather than the DOM's `focusin`/`focusout`: React's
 * synthetic versions of these two bubble, so one pair on a wrapper covers every
 * row inside it.
 *
 * On touch there is no hover to get stuck in — a touch pointer is destroyed
 * after the tap and the browser fires `pointerleave` with it — so the same
 * handlers serve a phone without a "the hold never released" failure mode of
 * their own.
 */
export function useInsideHold(): InsideHold {
  const [pointerInside, setPointerInside] = useState(false);
  const [focusInside, setFocusInside] = useState(false);

  const onPointerEnter = useCallback(() => setPointerInside(true), []);
  const onPointerLeave = useCallback(() => setPointerInside(false), []);
  const onFocus = useCallback(() => setFocusInside(true), []);
  const onBlur = useCallback(() => setFocusInside(false), []);

  return {
    inside: pointerInside || focusInside,
    handlers: { onPointerEnter, onPointerLeave, onFocus, onBlur },
  };
}
