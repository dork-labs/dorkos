/**
 * Daily session counts behind the Activity tab's week-at-a-glance line.
 *
 * @module widgets/activity/model/use-session-activity
 */
import { useQuery } from '@tanstack/react-query';
import type { SessionDailyCountsResponse } from '@dorkos/shared/types';
import { sessionKeys } from '@/layers/entities/session';
import { useTransport } from '@/layers/shared/model';

/** How many days the week line covers, ending today. */
export const ACTIVITY_WINDOW_DAYS = 7;

/** A counted week, as the summary line and sparkline consume it. */
export interface SessionWeekActivity {
  /** Sessions started per day, oldest first; the last entry is today. */
  dailyCounts: number[];
  /**
   * At least one runtime could not be read, so `dailyCounts` is a FLOOR, not a
   * total. Copy built on it must not report the number as a total (ADR-0310).
   */
  degraded: boolean;
}

/**
 * Count the sessions started per day across EVERY agent on this machine.
 *
 * The Activity feed below this line is machine-wide, so this count is taken at
 * the same SCOPE — from `GET /api/sessions/daily-counts`, which fans out across
 * every registered agent and every runtime (DOR-1039). It is deliberately NOT
 * derived from `useSessions`, which answers for the one project the client has
 * selected (ADR-0310) and so described a smaller machine than the feed it sat
 * above.
 *
 * Same scope is as far as it goes: the feed carries no session events, so the
 * line counts sessions while the feed lists what subsystems did.
 *
 * @returns The counted week, or `null` while there is no answer — the first
 *   load, a failed request, or an embedded transport with no agent roster.
 *   `null` is not zero: it means the question is unanswered, and the caller
 *   must render nothing rather than claim a quiet week.
 */
export function useSessionActivity(): SessionWeekActivity | null {
  const transport = useTransport();

  const { data } = useQuery<SessionDailyCountsResponse>({
    queryKey: sessionKeys.dailyCounts(ACTIVITY_WINDOW_DAYS),
    queryFn: () => transport.getSessionDailyCounts(ACTIVITY_WINDOW_DAYS),
    staleTime: 60_000,
  });

  // An empty window is what a transport with nothing to count returns; it is an
  // absent answer, not a week of zeros.
  if (!data || data.dailyCounts.length === 0) return null;

  return { dailyCounts: data.dailyCounts, degraded: (data.warnings?.length ?? 0) > 0 };
}
