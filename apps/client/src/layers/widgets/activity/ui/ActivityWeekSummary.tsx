/**
 * The Activity tab's week-at-a-glance line: how many sessions ran in the last
 * seven days, with a sparkline of the daily shape. Re-homed from the retired
 * dashboard System Status row, which is where the sparkline used to live.
 *
 * @module widgets/activity/ui/ActivityWeekSummary
 */
import { useSessionActivity } from '../model/use-session-activity';
import { sessionActivitySummary } from '../lib/activity-summary';
import { ActivitySparkline } from './ActivitySparkline';

/** One line of context above the activity feed. */
export function ActivityWeekSummary() {
  const dailyCounts = useSessionActivity();

  // Zero DOM until the session list is a real answer. A disabled or in-flight
  // query yields an empty list, and "no runs" from an unasked question is a
  // claim we have not earned.
  if (dailyCounts === null) return null;

  return (
    <div className="flex items-center justify-between gap-4 px-4">
      <p className="text-muted-foreground text-sm">{sessionActivitySummary(dailyCounts)}</p>
      <ActivitySparkline data={dailyCounts} className="h-6 w-24 shrink-0" />
    </div>
  );
}
