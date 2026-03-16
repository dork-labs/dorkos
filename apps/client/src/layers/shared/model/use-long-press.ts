import { useRef, useCallback } from 'react';
import { TIMING } from '@/layers/shared/lib';

interface UseLongPressOptions {
  ms?: number;
  onLongPress: () => void;
}

/** Return touch event handlers that trigger a callback after a sustained press. */
export function useLongPress({ onLongPress, ms = TIMING.LONG_PRESS_MS }: UseLongPressOptions) {
  const timerRef = useRef<number | null>(null);

  const onTouchStart = useCallback(() => {
    timerRef.current = window.setTimeout(onLongPress, ms);
  }, [onLongPress, ms]);

  const onTouchEnd = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  return {
    onTouchStart,
    onTouchEnd,
    onTouchMove: onTouchEnd,
  };
}
