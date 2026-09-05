import { describe, it, expect } from 'vitest';
import { bucketElapsedMs } from '../bucket-elapsed-ms';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

describe('bucketElapsedMs', () => {
  it('counts whole minutes under an hour', () => {
    expect(bucketElapsedMs(0)).toEqual({ value: 0, unit: 'minute' });
    expect(bucketElapsedMs(45 * MINUTE)).toEqual({ value: 45, unit: 'minute' });
    expect(bucketElapsedMs(59 * MINUTE + 59_000)).toEqual({ value: 59, unit: 'minute' });
  });

  it('rolls over to hours, then to days, exactly on the boundary', () => {
    expect(bucketElapsedMs(HOUR)).toEqual({ value: 1, unit: 'hour' });
    expect(bucketElapsedMs(23 * HOUR)).toEqual({ value: 23, unit: 'hour' });
    expect(bucketElapsedMs(DAY)).toEqual({ value: 1, unit: 'day' });
    expect(bucketElapsedMs(9 * DAY)).toEqual({ value: 9, unit: 'day' });
  });

  // Floors, never rounds: nothing may be reported as older than it is.
  it('floors a partial unit rather than rounding up', () => {
    expect(bucketElapsedMs(HOUR + 59 * MINUTE)).toEqual({ value: 1, unit: 'hour' });
    expect(bucketElapsedMs(DAY + 23 * HOUR)).toEqual({ value: 1, unit: 'day' });
  });

  // Clock skew between a server and a browser: the answer is zero minutes, not
  // a time in the future.
  it('clamps a negative span to zero', () => {
    expect(bucketElapsedMs(-5 * HOUR)).toEqual({ value: 0, unit: 'minute' });
  });
});
