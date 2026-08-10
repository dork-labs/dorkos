/**
 * The Activity tab's week-at-a-glance line: how many sessions ran across every
 * agent on this machine in the last seven days, with a sparkline of the daily
 * shape. Re-homed from the retired dashboard System Status row, which is where
 * the sparkline used to live.
 *
 * @module widgets/activity/ui/ActivityWeekSummary
 */
import { useSessionActivity } from '../model/use-session-activity';
import { sessionActivitySummary } from '../lib/activity-summary';
import { ActivitySparkline } from './ActivitySparkline';

/** One line of context above the activity feed. */
export function ActivityWeekSummary() {
  const week = useSessionActivity();

  // Zero DOM until the count is a real answer. A query in flight, a failed one,
  // or a transport with nothing to count all yield no week, and "no runs" from
  // an unanswered question is a claim we have not earned.
  if (week === null) return null;

  return (
    <div className="flex items-center justify-between gap-4">
      <p className="text-muted-foreground text-sm">
        {sessionActivitySummary(week.dailyCounts, week.degraded)}
      </p>
      <ActivitySparkline data={week.dailyCounts} className="h-6 w-24 shrink-0" />
    </div>
  );
}
