/**
 * Rendering a usage window's charges that are not inference.
 *
 * The service names the charge and its unit (`displayName`, `unit`); these
 * helpers only format the two things it sends as data — a quantity and a
 * billing period — so no unit, rate or allowance is ever written down here.
 *
 * @module features/cloud-plan/lib/other-charges
 */

/**
 * Format a charged quantity next to the service's own unit, e.g. `3.719 GB-month`.
 *
 * The service rounds `units` to three decimal places, so that is all this shows;
 * trailing zeros are dropped. `en-US`, like the contract's own formatter, so
 * every figure in the section reads with one decimal point.
 *
 * @param units - How much was charged for.
 * @param unit - What `units` counts, exactly as the service sent it.
 */
export function formatUnits(units: number, unit: string): string {
  return `${units.toLocaleString('en-US', { maximumFractionDigits: 3 })} ${unit}`;
}

const PERIOD_DATE = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  // A billing period is a server-side window. Rendering its edges in the
  // viewer's zone would move a midnight boundary onto the previous day.
  timeZone: 'UTC',
});

/** One day, in milliseconds. */
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Format a billing period as the days it covers, e.g. `Sep 1 – Sep 30`.
 *
 * The contract's `periodEnd` is exclusive and falls on midnight UTC — a
 * calendar month ends at the first instant of the next — so the last day shown
 * is the day before it. An end that is not on midnight UTC is outside that
 * promise and is shown as sent, because moving it back a day would drop a day
 * the period partly covers.
 *
 * @param periodStart - When the period started, as an ISO-8601 timestamp.
 * @param periodEnd - When the period ends, exclusive, as an ISO-8601 timestamp.
 */
export function formatPeriod(periodStart: string, periodEnd: string): string {
  const end = new Date(periodEnd);
  const lastDay = end.getTime() % DAY_MS === 0 ? new Date(end.getTime() - DAY_MS) : end;
  return `${PERIOD_DATE.format(new Date(periodStart))} – ${PERIOD_DATE.format(lastDay)}`;
}
