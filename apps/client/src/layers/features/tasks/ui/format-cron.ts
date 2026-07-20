import { describeCronSchedule } from '@dorkos/shared/cron';

/**
 * Convert common cron expressions into human-readable labels.
 *
 * The recognizing core lives in `@dorkos/shared/cron` (shared with the
 * server's shape-apply offer ledger). The tasks list falls back to the raw
 * expression for anything unrecognized — in this technical surface the raw
 * string is accurate detail, not a claim.
 *
 * @param expression - A standard 5-field cron expression
 */
export function formatCron(expression: string): string {
  return describeCronSchedule(expression) ?? expression;
}
