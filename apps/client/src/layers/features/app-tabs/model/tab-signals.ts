/**
 * The app-wide facts tabs read but should not each fetch (DOR-2820).
 *
 * Most of a tab's identity is about its own page and is read per tab. Two
 * kinds of fact are not: how much is waiting on you (Home's count, five
 * queues behind the Inbox) and what a page reports about itself (Schedules,
 * Activity, Connections, an extension page). Reading those once and sharing
 * them keeps a strip of ten tabs from mounting ten copies of the Inbox.
 *
 * @module features/app-tabs/model/tab-signals
 */
import { useEffect } from 'react';
import { create } from 'zustand';
import { useWaitingQueue } from '@/layers/entities/attention';
import type { RouteBadge } from '../lib/tab-identity';

interface TabSignalsState {
  /** Items waiting on a person: the Inbox's count, which Home shows. */
  needsYouCount: number;
  /**
   * What a page reports for its own tab, by route path (`/tasks`, `/x/flow`).
   * The seam pages fill for their tab's status and count.
   */
  routeBadges: Readonly<Record<string, RouteBadge>>;
  /** Set how many items are waiting on a person. */
  setNeedsYouCount: (count: number) => void;
  /**
   * Set, or clear with `null`, what a page reports for its own tab.
   *
   * @param path - The route path the badge belongs to.
   * @param badge - The status, count and sentence, or `null` to clear.
   */
  setRouteBadge: (path: string, badge: RouteBadge | null) => void;
}

/** The shared tab facts. Read with a selector; write through the setters. */
export const useTabSignalsStore = create<TabSignalsState>()((set) => ({
  needsYouCount: 0,
  routeBadges: {},
  setNeedsYouCount: (count) =>
    set((state) => (state.needsYouCount === count ? state : { needsYouCount: count })),
  setRouteBadge: (path, badge) =>
    set((state) => {
      const next = { ...state.routeBadges };
      if (badge === null) delete next[path];
      else next[path] = badge;
      return { routeBadges: next };
    }),
}));

/**
 * Keep the shared tab facts current. Mount once, at the app shell, so every
 * tab, the History menu and the window title read one copy.
 */
export function useTabSignalsSync(): void {
  const { items } = useWaitingQueue();
  const setNeedsYouCount = useTabSignalsStore((state) => state.setNeedsYouCount);
  useEffect(() => {
    setNeedsYouCount(items.length);
  }, [items.length, setNeedsYouCount]);
}
