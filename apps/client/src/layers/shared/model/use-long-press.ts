import { useRef, useCallback } from 'react';
import { TIMING } from '@/layers/shared/lib';

interface UseLongPressOptions {
  /** Delay in ms before the long-press fires. Default: 500 (TIMING.LONG_PRESS_MS). */
  ms?: number;
  /** Called when long-press is detected. */
  onLongPress: () => void;
}

interface UseLongPressReturn {
  onPointerDown: (e: React.PointerEvent) => void;
  onPointerUp: () => void;
  onPointerLeave: () => void;
  onPointerCancel: () => void;
}

/** Return pointer event handlers that trigger a callback after a sustained press. */
export function useLongPress({
  onLongPress,
  ms = TIMING.LONG_PRESS_MS,
}: UseLongPressOptions): UseLongPressReturn {
  const timerRef = useRef<number | null>(null);

  const clear = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      // Only fire on primary pointer (left click / single touch)
      if (e.button !== 0) return;
      timerRef.current = window.setTimeout(onLongPress, ms);
    },
    [onLongPress, ms]
  );

  return {
    onPointerDown,
    onPointerUp: clear,
    onPointerLeave: clear,
    onPointerCancel: clear,
  };
}
