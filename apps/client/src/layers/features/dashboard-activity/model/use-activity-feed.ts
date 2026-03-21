import { useMemo } from 'react';
import { useSessions } from '@/layers/entities/session';
import { useRuns } from '@/layers/entities/pulse';

/** Maximum number of events to show in the feed before capping. */
const MAX_EVENTS = 20;

/** Seven days in milliseconds — lookback window for the activity feed. */
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

export interface ActivityEvent {
  id: string;
  type: 'session' | 'pulse' | 'relay' | 'mesh' | 'system';
  timestamp: string;
  title: string;
  link?: { to: string; params?: Record<string, string> };
}

export interface ActivityGroup {
  /** Human-readable time bucket label. */
  label: string;
  events: ActivityEvent[];
}

/** @internal Exported for testing only. */
export function formatDuration(ms: number): string {
  const minutes = Math.floor(ms / 60000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  if (hours < 24) return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/**
 * Aggregate recent events from sessions and Pulse runs into a time-grouped feed.
 * Sources: sessions (last 7 days), Pulse runs (last 7 days).
 * Sorted reverse-chronologically and grouped into Today / Yesterday / Last 7 days.
 * Capped at 20 items.
 */
export function useActivityFeed(): { groups: ActivityGroup[]; totalCount: number } {
  const { sessions } = useSessions();
  const { data: runs } = useRuns();

  return useMemo(() => {
    const events: ActivityEvent[] = [];
    const now = new Date();
    const sevenDaysAgo = now.getTime() - SEVEN_DAYS_MS;

    // Session events from last 7 days
    if (sessions) {
      for (const session of sessions) {
        const createdAt = new Date(session.createdAt).getTime();
        if (createdAt > sevenDaysAgo) {
          const elapsed = formatDuration(now.getTime() - createdAt);
          events.push({
            id: `session-${session.id}`,
            type: 'session',
            timestamp: session.createdAt,
            title: `${session.title ?? session.id.slice(0, 8)} completed (${elapsed})`,
            link: {
              to: '/session',
              params: { session: session.id, dir: session.cwd ?? '' },
            },
          });
        }
      }
    }

    // Pulse run events from last 7 days
    if (runs) {
      for (const run of runs) {
        const runTime = new Date(run.createdAt).getTime();
        if (runTime > sevenDaysAgo) {
          const status = run.status === 'failed' ? 'failed' : 'ran successfully';
          events.push({
            id: `pulse-${run.id}`,
            type: 'pulse',
            timestamp: run.createdAt,
            title: `Schedule ${run.scheduleId.slice(0, 8)} ${status}`,
          });
        }
      }
    }

    // Sort reverse-chronologically
    events.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

    const totalCount = events.length;
    const capped = events.slice(0, MAX_EVENTS);

    // Group into time buckets
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const yesterday = new Date(today.getTime() - 24 * 60 * 60 * 1000);

    const groups: ActivityGroup[] = [];
    const todayEvents = capped.filter((e) => new Date(e.timestamp) >= today);
    const yesterdayEvents = capped.filter((e) => {
      const t = new Date(e.timestamp);
      return t >= yesterday && t < today;
    });
    const olderEvents = capped.filter((e) => new Date(e.timestamp) < yesterday);

    if (todayEvents.length > 0) groups.push({ label: 'Today', events: todayEvents });
    if (yesterdayEvents.length > 0) groups.push({ label: 'Yesterday', events: yesterdayEvents });
    if (olderEvents.length > 0) groups.push({ label: 'Last 7 days', events: olderEvents });

    return { groups, totalCount };
  }, [sessions, runs]);
}
