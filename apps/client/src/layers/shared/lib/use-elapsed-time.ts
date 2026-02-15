import { useState, useEffect, useRef } from 'react';

interface ElapsedTimeResult {
  formatted: string;
  ms: number;
}

function formatElapsed(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  if (totalSeconds < 3600) {
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
  }
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  return `${hours}h ${String(minutes).padStart(2, '0')}m`;
}

export function useElapsedTime(startTime: number | null): ElapsedTimeResult {
  const [now, setNow] = useState(() => Date.now());
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (startTime === null) {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
      return;
    }

    setNow(Date.now());
    intervalRef.current = setInterval(() => setNow(Date.now()), 1000);

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [startTime]);

  if (startTime === null) {
    return { formatted: '0m 00s', ms: 0 };
  }

  const ms = Math.max(0, now - startTime);
  return { formatted: formatElapsed(ms), ms };
}
