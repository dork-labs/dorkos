import { describe, it, expect } from 'vitest';
import { describeCronSchedule } from '../cron.js';

describe('describeCronSchedule', () => {
  it('describes a daily schedule', () => {
    expect(describeCronSchedule('0 9 * * *')).toBe('Every day at 9:00 AM');
    expect(describeCronSchedule('30 14 * * *')).toBe('Every day at 2:30 PM');
    expect(describeCronSchedule('0 0 * * *')).toBe('Every day at 12:00 AM');
  });

  it('describes a weekday schedule (1-5)', () => {
    expect(describeCronSchedule('0 9 * * 1-5')).toBe('Every weekday at 9:00 AM');
  });

  it('describes a single-day schedule', () => {
    expect(describeCronSchedule('0 9 * * 1')).toBe('Every Monday at 9:00 AM');
    expect(describeCronSchedule('15 17 * * 5')).toBe('Every Friday at 5:15 PM');
  });

  it('returns null for unrecognized patterns instead of leaking cron', () => {
    expect(describeCronSchedule('*/5 * * * *')).toBeNull(); // interval minutes
    expect(describeCronSchedule('0 9 1 * *')).toBeNull(); // day-of-month
    expect(describeCronSchedule('0 9 * 6 *')).toBeNull(); // month-bound
    expect(describeCronSchedule('0 9 * * 8')).toBeNull(); // out-of-range day
    expect(describeCronSchedule('not a cron')).toBeNull();
    expect(describeCronSchedule('')).toBeNull();
  });

  it('returns null for invalid times', () => {
    expect(describeCronSchedule('0 25 * * *')).toBeNull();
    expect(describeCronSchedule('61 9 * * *')).toBeNull();
  });
});
