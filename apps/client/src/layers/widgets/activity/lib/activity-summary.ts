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
 * The copy names its scope on purpose. The number comes from
 * `useSessionActivity`, which counts sessions in the selected project — the
 * only session list the server can produce (ADR-0310) — while the feed beneath
 * this line is machine-wide. An unscoped "12 runs this week" sitting on a
 * global feed would read as a global count and quietly be wrong.
 *
 * @param dailyCounts - Session counts per day, oldest first.
 */
export function sessionActivitySummary(dailyCounts: number[]): string {
  const total = dailyCounts.reduce((sum, count) => sum + count, 0);
  if (total === 0) return 'No runs in this project this week';
  const noun = total === 1 ? 'run' : 'runs';
  return `${total} ${noun} in this project this week`;
}
