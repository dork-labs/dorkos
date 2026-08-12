import { useCallback, useEffect, useRef } from 'react';
import { LONG_PRESS_DRIFT_PX, TIMING } from '@/layers/shared/lib';

/**
 * Where a press is in its life, for a surface that acknowledges being pressed.
 *
 * `released` and `cancelled` are deliberately different endings. A press the
 * reader completed earns the spring-back the design draws; a press they
 * abandoned mid-gesture — they started scrolling, or selecting text — gets
 * nothing, because animating a gesture somebody walked away from is the surface
 * celebrating something that did not happen.
 */
export type LongPressState = 'pressing' | 'released' | 'cancelled';

interface UseLongPressOptions {
  /** Delay in ms before the long-press fires. Default: 500 (TIMING.LONG_PRESS_MS). */
  ms?: number;
  /** Called when long-press is detected. */
  onLongPress: () => void;
  /**
   * Called as the press starts, completes, or is abandoned. Optional: a caller
   * that only wants the menu never hears about it.
   */
  onPressStateChange?: (state: LongPressState) => void;
  /**
   * A CSS selector this press yields to. Checked against the pointerdown's own
   * `target` (via `closest`) at press-start; a match means some more specific
   * descendant already owns this gesture, so this press never even starts —
   * no timer, no `onPressStateChange('pressing')`, nothing to cancel later.
   *
   * Opt-in and off by default: only a press SURFACE that sits above a
   * possibly-nested gesture of its own needs this — `ResponsiveContextMenu`'s
   * `MobileTrigger` is the one caller, yielding to `[data-gesture-priority]`
   * so a room message's own long-press (the actions drawer) never races a
   * mention pill's `IdentityHoverCard` long-press (the identity card) sitting
   * inside it. The identity card's OWN `useLongPress` call never passes this:
   * its target IS the marked trigger, and a press yielding to its own trigger
   * would mean it never opens at all.
   */
  yieldToSelector?: string;
}

interface UseLongPressReturn {
  onPointerDown: (e: React.PointerEvent) => void;
  onPointerMove: (e: React.PointerEvent) => void;
  onPointerUp: () => void;
  onPointerLeave: () => void;
  onPointerCancel: () => void;
}

/**
 * Return pointer event handlers that trigger a callback after a sustained press.
 *
 * The press has to be sustained AND still. Releasing, leaving, or the browser
 * taking the gesture over all cancel it — and so does moving further than
 * {@link LONG_PRESS_DRIFT_PX}, which is what keeps this off the two gestures
 * that share its opening moment: a drag-scroll and a text selection. Waiting
 * for `pointercancel` alone is not enough, because a mouse drag across
 * selectable text never fires one, and a message's text is exactly what a
 * reader drags across.
 *
 * @param options - The callback, and how long the press must last.
 */
export function useLongPress({
  onLongPress,
  ms = TIMING.LONG_PRESS_MS,
  onPressStateChange,
  yieldToSelector,
}: UseLongPressOptions): UseLongPressReturn {
  const timerRef = useRef<number | null>(null);
  const originRef = useRef<{ x: number; y: number } | null>(null);

  /**
   * Stand the press down. `ending` is how it ended, which the acknowledgment
   * animation reads — and it is only reported when a press was actually running,
   * so a stray `pointerleave` over a row nobody pressed says nothing.
   */
  const clear = useCallback(
    (ending: Exclude<LongPressState, 'pressing'>) => {
      const wasPressing = originRef.current !== null;
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      originRef.current = null;
      if (wasPressing) onPressStateChange?.(ending);
    },
    [onPressStateChange]
  );

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      // Only fire on primary pointer (left click / single touch)
      if (e.button !== 0) return;
      if (yieldToSelector && (e.target as Element | null)?.closest?.(yieldToSelector)) return;
      originRef.current = { x: e.clientX, y: e.clientY };
      onPressStateChange?.('pressing');
      timerRef.current = window.setTimeout(() => {
        // The menu is opening and takes the gesture from here, so the press is
        // over as far as the pressed surface is concerned — it springs back
        // rather than sitting squashed under an open drawer.
        originRef.current = null;
        timerRef.current = null;
        onPressStateChange?.('released');
        onLongPress();
      }, ms);
    },
    [onLongPress, ms, onPressStateChange, yieldToSelector]
  );

  // **A press that outlives its element.** Opening the surface can unmount the
  // row the finger is on — a menu item that navigates, a rebuild that drops the
  // row — and the timer would keep running to call back into a component that
  // is gone. Nothing user-visible has been traced to it; it is closed because a
  // pending timer holding a stale closure is the kind of thing that becomes
  // user-visible later, in a stack trace that names none of this.
  useEffect(() => () => clear('cancelled'), [clear]);

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      const origin = originRef.current;
      if (origin === null) return;
      const drifted =
        Math.abs(e.clientX - origin.x) > LONG_PRESS_DRIFT_PX ||
        Math.abs(e.clientY - origin.y) > LONG_PRESS_DRIFT_PX;
      if (drifted) clear('cancelled');
    },
    [clear]
  );

  return {
    onPointerDown,
    onPointerMove,
    onPointerUp: () => clear('released'),
    onPointerLeave: () => clear('cancelled'),
    onPointerCancel: () => clear('cancelled'),
  };
}
