import { useRef, useCallback } from 'react';
import { LONG_PRESS_DRIFT_PX, TIMING } from '@/layers/shared/lib';

interface UseLongPressOptions {
  /** Delay in ms before the long-press fires. Default: 500 (TIMING.LONG_PRESS_MS). */
  ms?: number;
  /** Called when long-press is detected. */
  onLongPress: () => void;
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
}: UseLongPressOptions): UseLongPressReturn {
  const timerRef = useRef<number | null>(null);
  const originRef = useRef<{ x: number; y: number } | null>(null);

  const clear = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    originRef.current = null;
  }, []);

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      // Only fire on primary pointer (left click / single touch)
      if (e.button !== 0) return;
      originRef.current = { x: e.clientX, y: e.clientY };
      timerRef.current = window.setTimeout(onLongPress, ms);
    },
    [onLongPress, ms]
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      const origin = originRef.current;
      if (origin === null) return;
      const drifted =
        Math.abs(e.clientX - origin.x) > LONG_PRESS_DRIFT_PX ||
        Math.abs(e.clientY - origin.y) > LONG_PRESS_DRIFT_PX;
      if (drifted) clear();
    },
    [clear]
  );

  return {
    onPointerDown,
    onPointerMove,
    onPointerUp: clear,
    onPointerLeave: clear,
    onPointerCancel: clear,
  };
}
