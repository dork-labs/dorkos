/**
 * Plain-language summary of the Activity tab's week-at-a-glance line. It states
 * what the week looked like rather than a bare metric, following
 * writing-for-humans.
 *
 * @module widgets/activity/lib/activity-summary
 */

/**
 * Summarise a week of daily session counts in one line.
 *
 * The copy says exactly what the number is: sessions your agents STARTED in the
 * last seven days, counted across every agent on this machine (DOR-1039). It is
 * not a count of sessions worked in — a session started nine days ago and
 * resumed today is not in it — and it is not a count of turns.
 *
 * "Across your agents" names the scope the feed below this line already has:
 * machine-wide rather than the project the client happens to have selected.
 * Scope, not subject — the feed carries no session events at all, so the two
 * describe the same machine, not the same things happening on it.
 *
 * When a runtime could not be read, the count is a floor and the copy says so:
 * a degraded fan-out contributes zero sessions, and reporting that as a total
 * would quietly under-report the week.
 *
 * @param dailyCounts - Session counts per day, oldest first.
 * @param degraded - A runtime could not be read, so the counts are a floor.
 */
export function sessionActivitySummary(dailyCounts: number[], degraded: boolean): string {
  const total = dailyCounts.reduce((sum, count) => sum + count, 0);
  const noun = total === 1 ? 'session' : 'sessions';

  if (degraded) {
    // Zero here is not a quiet week and not a busy one — with a runtime unread
    // we know nothing about how many sessions started, so we claim nothing.
    if (total === 0) return "This week's count is incomplete";
    return `Your agents started at least ${total} ${noun} this week`;
  }

  if (total === 0) return 'Your agents started no sessions this week';
  return `Your agents started ${total} ${noun} this week`;
}
