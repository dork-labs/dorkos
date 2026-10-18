const DATE = new Intl.DateTimeFormat('en-GB', {
  weekday: 'long',
  day: 'numeric',
  month: 'long',
  year: 'numeric',
  timeZone: 'UTC',
});

/**
 * A date as owner-replacement copy says it: in UTC, with the day spelled out, such as
 * "Tuesday, 29 September 2026 (UTC)". The zone is named because owner and host may be anywhere.
 */
export function formatReplacementDate(date: Date): string {
  return `${DATE.format(date)} (UTC)`;
}
