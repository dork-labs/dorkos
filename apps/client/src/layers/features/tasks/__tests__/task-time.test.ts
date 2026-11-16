/**
 * The row's cadence words against the real cron reader, so the ticket's own
 * strings ("Weekdays at 8:00 AM") are checked, not a stand-in (DOR-4120).
 */
import { describe, expect, it } from 'vitest';
import { describeCronSchedule } from '../lib/task-time';

describe('describeCronSchedule', () => {
  it('says weekdays and daily times in 12-hour form with no leading zero', () => {
    expect(describeCronSchedule('0 8 * * 1-5')).toBe('Weekdays at 8:00 AM');
    expect(describeCronSchedule('30 14 * * *')).toBe('Daily at 2:30 PM');
  });

  it('hands back the expression when it cannot be read', () => {
    expect(describeCronSchedule('not a cron')).toBe('not a cron');
  });
});
