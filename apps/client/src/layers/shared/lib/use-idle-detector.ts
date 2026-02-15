import { useEffect, useRef, useCallback } from 'react';

export interface IdleDetectorOptions {
  timeoutMs?: number;  // Default: 30000
  onIdle?: () => void;
  onReturn?: () => void;
}

export interface IdleDetectorState {
  isIdle: boolean;
}

export function useIdleDetector(options: IdleDetectorOptions = {}): IdleDetectorState {
  const { timeoutMs = 30_000, onIdle, onReturn } = options;
  const isIdleRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const markIdle = useCallback(() => {
    if (!isIdleRef.current) {
      isIdleRef.current = true;
      onIdle?.();
    }
  }, [onIdle]);

  const markActive = useCallback(() => {
    if (isIdleRef.current) {
      isIdleRef.current = false;
      onReturn?.();
    }
  }, [onReturn]);

  const resetTimer = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(markIdle, timeoutMs);
    markActive();
  }, [timeoutMs, markIdle, markActive]);

  useEffect(() => {
    // Start the idle timer
    timerRef.current = setTimeout(markIdle, timeoutMs);

    // Activity events
    const events = ['mousemove', 'keydown', 'scroll', 'touchstart'] as const;
    events.forEach((e) => document.addEventListener(e, resetTimer, { passive: true }));

    // Visibility change
    const handleVisibility = () => {
      if (document.hidden) {
        markIdle();
      } else {
        resetTimer();
      }
    };
    document.addEventListener('visibilitychange', handleVisibility);

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      events.forEach((e) => document.removeEventListener(e, resetTimer));
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, [timeoutMs, markIdle, resetTimer]);

  return { isIdle: isIdleRef.current };
}
