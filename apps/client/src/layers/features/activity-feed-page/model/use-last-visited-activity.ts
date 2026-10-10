/**
 * Track the last time the activity feed was visited.
 *
 * The moment lives in `entities/activity` (`useActivitySeenStore`), where the
 * Activity tab's "new" count reads it too (DOR-2820). This hook is the page's
 * half: it hands back the previous visit for the digest line, and while the
 * page is on screen it tells the store so, which keeps the tab from counting
 * events you are looking at.
 *
 * @module features/activity-feed-page/model/use-last-visited-activity
 */
import { useEffect, useState } from 'react';
import { useActivitySeenStore } from '@/layers/entities/activity';

/**
 * Track the last time the activity feed was visited.
 *
 * @returns ISO 8601 timestamp of the previous visit, or null on first visit.
 */
export function useLastVisitedActivity(): string | null {
  // The previous visit, frozen at mount: the digest line describes what
  // happened before you opened the page, even as the stored moment moves on.
  const [lastVisitedAt] = useState(() => useActivitySeenStore.getState().lastSeenAt);

  useEffect(() => {
    const { markSeen, setViewing } = useActivitySeenStore.getState();
    markSeen();
    setViewing(true);
    return () => {
      // Leaving the page: everything that arrived while it was open was seen.
      markSeen();
      setViewing(false);
    };
  }, []);

  return lastVisitedAt;
}
