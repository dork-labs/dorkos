/**
 * The app-wide facts tabs read but should not each fetch (DOR-2820).
 *
 * Most of a tab's identity is about its own page and is read per tab. Two
 * kinds of fact are not: how much is waiting on you (Home's count, five
 * queues behind the Inbox) and what a page reports about itself (Schedules,
 * Activity, Connections). An extension page's own badge lives with the page,
 * in the extension registry. Reading those once and sharing
 * them keeps a strip of ten tabs from mounting ten copies of the Inbox.
 *
 * The store only; `use-tab-signals-sync.ts` keeps it current.
 *
 * @module features/app-tabs/model/tab-signals
 */
import { create } from 'zustand';
import type { RouteBadge } from '../lib/tab-identity';

/** Whether two badges say the same thing, so an equal one is not written twice. */
function sameBadge(a: RouteBadge | undefined, b: RouteBadge | null): boolean {
  if (!a || !b) return !a && !b;
  return a.status === b.status && a.count === b.count && a.sentence === b.sentence;
}

interface TabSignalsState {
  /** Items waiting on a person: the Inbox's count, which Home shows. */
  needsYouCount: number;
  /**
   * What a page reports for its own tab, by route path (`/tasks`).
   * The seam pages fill for their tab's status and count.
   */
  routeBadges: Readonly<Record<string, RouteBadge>>;
  /** Schedules waiting for your OK: what the window title's `(N)` adds for schedules. */
  schedulesWaitingCount: number;
  /** Set how many items are waiting on a person. */
  setNeedsYouCount: (count: number) => void;
  /**
   * Set, or clear with `null`, what a page reports for its own tab.
   *
   * @param path - The route path the badge belongs to.
   * @param badge - The status, count and sentence, or `null` to clear.
   */
  setRouteBadge: (path: string, badge: RouteBadge | null) => void;
  /** Set how many schedules wait for your OK. */
  setSchedulesWaitingCount: (count: number) => void;
}

/** The shared tab facts. Read with a selector; write through the setters. */
export const useTabSignalsStore = create<TabSignalsState>()((set) => ({
  needsYouCount: 0,
  routeBadges: {},
  schedulesWaitingCount: 0,
  setNeedsYouCount: (count) =>
    set((state) => (state.needsYouCount === count ? state : { needsYouCount: count })),
  setRouteBadge: (path, badge) =>
    set((state) => {
      if (sameBadge(state.routeBadges[path], badge)) return state;
      const next = { ...state.routeBadges };
      if (badge === null) delete next[path];
      else next[path] = badge;
      return { routeBadges: next };
    }),
  setSchedulesWaitingCount: (count) =>
    set((state) =>
      state.schedulesWaitingCount === count ? state : { schedulesWaitingCount: count }
    ),
}));
