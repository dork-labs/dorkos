/**
 * The decision window is hours long, so the countdown has to read in hours as
 * well as minutes — and has to stay honest at both ends of the window.
 */
import { describe, it, expect } from 'vitest';
import { formatTimeLeft } from '../lib/format-time-left';

/** An ISO timestamp `ms` milliseconds after `now`. */
function inMs(now: number, ms: number): string {
  return new Date(now + ms).toISOString();
}

describe('formatTimeLeft', () => {
  const now = Date.parse('2026-07-25T12:00:00.000Z');

  it('counts down in minutes below the hour', () => {
    expect(formatTimeLeft(inMs(now, 8.5 * 60_000), now)).toBe('8 min left');
    expect(formatTimeLeft(inMs(now, 59 * 60_000), now)).toBe('59 min left');
  });

  it('counts down in hours and minutes above the hour', () => {
    expect(formatTimeLeft(inMs(now, 65 * 60_000), now)).toBe('1 hr 5 min left');
    expect(formatTimeLeft(inMs(now, 119 * 60_000), now)).toBe('1 hr 59 min left');
  });

  it('drops the minutes when a whole number of hours is left', () => {
    expect(formatTimeLeft(inMs(now, 120 * 60_000), now)).toBe('2 hr left');
    expect(formatTimeLeft(inMs(now, 60 * 60_000), now)).toBe('1 hr left');
  });

  it('warns inside the last minute instead of saying zero', () => {
    expect(formatTimeLeft(inMs(now, 30_000), now)).toBe('expiring');
    expect(formatTimeLeft(inMs(now, 1), now)).toBe('expiring');
  });

  it('reports a closed window, including a timestamp it cannot read', () => {
    expect(formatTimeLeft(inMs(now, 0), now)).toBe('expired');
    expect(formatTimeLeft(inMs(now, -60_000), now)).toBe('expired');
    expect(formatTimeLeft('not a date', now)).toBe('expired');
  });
});
