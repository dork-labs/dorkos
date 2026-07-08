import { useState, useEffect } from 'react';
import { formatRelativeTime } from '@/layers/shared/lib';

/**
 * Auto-refreshing relative time hook with adaptive intervals.
 *
 * Refresh rates:
 * - Under 1 minute old: every 10 seconds
 * - Under 1 hour old: every 60 seconds
 * - Older: every hour
 *
 * @param dateStr - ISO 8601 timestamp string, or undefined
 * @returns Formatted relative time string, or empty string if dateStr is undefined
 */
export function useAutoRelativeTime(dateStr: string | undefined): string {
  const [, setTick] = useState(0);

  useEffect(() => {
    if (!dateStr) return;
    const age = Date.now() - new Date(dateStr).getTime();
    const interval =
      age < 60_000
        ? 10_000 // < 1 min: refresh every 10s
        : age < 3_600_000
          ? 60_000 // < 1 hr: refresh every minute
          : 3_600_000; // older: refresh every hour

    const timer = setInterval(() => setTick((t) => t + 1), interval);
    return () => clearInterval(timer);
  }, [dateStr]);

  return dateStr ? formatRelativeTime(dateStr) : '';
}
