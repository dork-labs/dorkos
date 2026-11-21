import { describeCronSchedule } from '@dorkos/shared/cron';

/** A package's cadence in words, without guessing at an unusual expression. */
export function describePackageScheduleWhen(cron: string | null): string {
  if (!cron) return 'Runs only when asked';
  // The row shows the exact rule separately, including for unusual patterns.
  return describeCronSchedule(cron) ?? 'On a custom schedule';
}
