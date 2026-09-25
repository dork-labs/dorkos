/**
 * Rendering a usage window's charges that are not inference.
 *
 * The service names the charge and its unit (`displayName`, `unit`); these
 * helpers only format the two things it sends as data — a quantity and a
 * billing period — so no unit, rate or allowance is ever written down here.
 *
 * @module features/cloud-plan/lib/storage-usage
 */

/**
 * Format a charged quantity next to the service's own unit, e.g. `2.5 GB-month`.
 *
 * The contract caps `units` at three decimal places, so that is all this shows;
 * trailing zeros are dropped. `en-US` for the same reason `formatMicro` uses it:
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

/**
 * Format a billing period as a short date range, e.g. `Sep 15 – Oct 15`.
 *
 * @param periodStart - When the period started, as an ISO-8601 timestamp.
 * @param periodEnd - When the period ended, as an ISO-8601 timestamp.
 */
export function formatPeriod(periodStart: string, periodEnd: string): string {
  return `${PERIOD_DATE.format(new Date(periodStart))} – ${PERIOD_DATE.format(new Date(periodEnd))}`;
}
