/**
 * When you last looked at Activity, and how much has happened since.
 *
 * The Activity page's "since your last visit" line and the Activity tab's
 * "new" count (DOR-2820) both measure from the same moment, so they cannot
 * disagree. Kept in this browser only: it is a reading position, not data.
 *
 * @module entities/activity/model/activity-seen
 */
import { useQuery } from '@tanstack/react-query';
import { create } from 'zustand';
import { useTransport } from '@/layers/shared/model';

/**
 * Where the moment is kept. The key the Activity page has always used, so a
 * visit before this module existed still counts as one.
 */
const STORAGE_KEY = 'dorkos:lastVisitedActivity';

/** The most events one read counts. The tab draws anything above 99 as `99+`. */
const NEW_EVENTS_LIMIT = 100;

/** Read the stored moment, or `null` when there is none (or no storage). */
function readStored(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

interface ActivitySeenState {
  /** When Activity was last on screen, ISO 8601, or `null` before the first visit. */
  lastSeenAt: string | null;
  /** Whether the Activity page is on screen now: everything on it is being seen. */
  viewing: boolean;
  /** Record that everything up to now has been seen. */
  markSeen: () => void;
  /** Say whether the Activity page is on screen. */
  setViewing: (viewing: boolean) => void;
}

/** The reading position. Read with a selector; write through the setters. */
export const useActivitySeenStore = create<ActivitySeenState>()((set) => ({
  lastSeenAt: readStored(),
  viewing: false,
  markSeen: () => {
    const now = new Date().toISOString();
    try {
      localStorage.setItem(STORAGE_KEY, now);
    } catch {
      // Storage refused (private mode, full): the count still clears for now.
    }
    set({ lastSeenAt: now });
  },
  setViewing: (viewing) => set({ viewing }),
}));

// Another window opening Activity moves the stored moment; follow it, so this
// window's count does not go on counting events that person has seen. The
// `storage` event fires only in the OTHER windows of this origin.
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (event.key !== STORAGE_KEY) return;
    useActivitySeenStore.setState({ lastSeenAt: event.newValue });
  });
}

/** How many events happened since you last looked. */
export interface NewActivityCount {
  /** The events one read counted, up to {@link NEW_EVENTS_LIMIT}. */
  count: number;
  /** Whether there are more than that. */
  more: boolean;
}

/** Nothing new, minted once for a stable result. */
const NOTHING_NEW: NewActivityCount = { count: 0, more: false };

/**
 * How many events happened since you last looked at Activity.
 *
 * Zero before your first visit, since there is nothing to measure from, and
 * zero while the page is on screen. Sits under the `['activity']` query root,
 * so whatever refreshes the Activity feed refreshes this too.
 *
 * @returns The count, capped at {@link NEW_EVENTS_LIMIT}, and whether there are more.
 */
export function useNewActivityCount(): NewActivityCount {
  const transport = useTransport();
  const lastSeenAt = useActivitySeenStore((state) => state.lastSeenAt);
  const viewing = useActivitySeenStore((state) => state.viewing);
  const { data } = useQuery({
    queryKey: ['activity', 'new-since', lastSeenAt],
    queryFn: () => transport.listActivityEvents({ since: lastSeenAt!, limit: NEW_EVENTS_LIMIT }),
    select: (page): NewActivityCount => ({
      count: page.items.length,
      more: page.nextCursor !== null,
    }),
    enabled: lastSeenAt !== null && !viewing,
    staleTime: 30_000,
    refetchInterval: 60_000,
    refetchIntervalInBackground: false,
  });
  return lastSeenAt === null || viewing ? NOTHING_NEW : (data ?? NOTHING_NEW);
}
