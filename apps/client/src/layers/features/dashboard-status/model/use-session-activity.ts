import { useMemo } from 'react';
import { useSessions } from '@/layers/entities/session';

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const BUCKET_COUNT = 7;

/**
 * Derive a 7-day daily session count array for the activity sparkline.
 * Index 0 = 6 days ago, index 6 = today.
 *
 * @returns Array of 7 integers representing session counts per day.
 */
export function useSessionActivity(): number[] {
  const { sessions } = useSessions();

  return useMemo(() => {
    const buckets = Array(BUCKET_COUNT).fill(0) as number[];
    if (!sessions.length) return buckets;

    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());

    for (const session of sessions) {
      const created = new Date(session.createdAt);
      const startOfCreatedDay = new Date(
        created.getFullYear(),
        created.getMonth(),
        created.getDate()
      );
      const diffDays = Math.floor(
        (startOfToday.getTime() - startOfCreatedDay.getTime()) / MS_PER_DAY
      );
      if (diffDays >= 0 && diffDays < BUCKET_COUNT) {
        buckets[BUCKET_COUNT - 1 - diffDays]++;
      }
    }
    return buckets;
  }, [sessions]);
}
