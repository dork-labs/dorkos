/**
 * Daily session counts behind the Activity tab's week-at-a-glance line.
 *
 * @module widgets/activity/model/use-session-activity
 */
import { useMemo } from 'react';
import { useSessions } from '@/layers/entities/session';
import { useNow } from '@/layers/shared/model';

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const BUCKET_COUNT = 7;

/**
 * Derive a 7-day daily session count array for the activity sparkline.
 * Index 0 = 6 days ago, index 6 = today.
 *
 * Counts sessions in the **currently selected project**, not across the whole
 * machine: `GET /api/sessions` is project-scoped by construction (ADR-0310 —
 * every runtime derives its list from that project's own transcript store), so
 * there is no global session list to count. Callers must say so in their copy.
 *
 * @returns Seven integers, oldest day first — or `null` while the session list
 *   is unknown (no project selected yet, first load in flight, or the list
 *   failed). `null` is not zero: it means the question has no answer yet, and
 *   the caller must render nothing rather than claim a quiet week.
 */
export function useSessionActivity(): number[] | null {
  const { sessions, isAnswered } = useSessions();
  const nowMs = useNow();

  return useMemo(() => {
    if (!isAnswered) return null;

    const buckets = Array(BUCKET_COUNT).fill(0) as number[];
    if (!sessions.length) return buckets;

    const now = new Date(nowMs);
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
  }, [isAnswered, nowMs, sessions]);
}
