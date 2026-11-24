import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  computeHealthStatus,
  ACTIVE_THRESHOLD_MINUTES,
  INACTIVE_THRESHOLD_MINUTES,
} from '../health.js';

/** Helper: create a Date that is `minutes` before `base`. */
function minutesBefore(base: Date, minutes: number): Date {
  return new Date(base.getTime() - minutes * 60_000);
}

describe('computeHealthStatus', () => {
  const BASE = new Date('2026-01-15T12:00:00Z');

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns "stale" when lastSeenAt is null', () => {
    expect(computeHealthStatus(null)).toBe('stale');
  });

  it('returns "inactive" when last seen between active and inactive thresholds', () => {
    vi.useFakeTimers();
    vi.setSystemTime(BASE);
    const midpoint = (ACTIVE_THRESHOLD_MINUTES + INACTIVE_THRESHOLD_MINUTES) / 2;
    const timestamp = minutesBefore(BASE, midpoint);
    expect(computeHealthStatus(timestamp.toISOString())).toBe('inactive');
  });

  it('returns "stale" when last seen beyond inactive threshold', () => {
    vi.useFakeTimers();
    vi.setSystemTime(BASE);
    const timestamp = minutesBefore(BASE, INACTIVE_THRESHOLD_MINUTES + 60);
    expect(computeHealthStatus(timestamp.toISOString())).toBe('stale');
  });

  it('returns "inactive" at exactly the active threshold', () => {
    vi.useFakeTimers();
    vi.setSystemTime(BASE);
    const atBoundary = minutesBefore(BASE, ACTIVE_THRESHOLD_MINUTES);
    expect(computeHealthStatus(atBoundary.toISOString())).toBe('inactive');
  });
});
