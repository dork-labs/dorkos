import { describe, expect, it } from 'vitest';
import { describePackageScheduleWhen } from '../schedule-when.js';

describe('package schedule wording', () => {
  it.each([
    ['0 9 * * *', 'Every day at 9:00 AM'],
    ['0 9 * * 1-5', 'Every weekday at 9:00 AM'],
    [null, 'Runs only when asked'],
    ['*/5 * * * *', 'On a custom schedule'],
  ])('describes %s without guessing', (cron, words) => {
    expect(describePackageScheduleWhen(cron)).toBe(words);
  });
});
