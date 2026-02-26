import { describe, it, expect, vi, afterEach } from 'vitest';
import { computeHealthStatus } from '../health.js';

describe('computeHealthStatus', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns "stale" when lastSeenAt is null', () => {
    expect(computeHealthStatus(null)).toBe('stale');
  });

  it('returns "active" when last seen < 5 minutes ago', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T12:04:00Z'));
    expect(computeHealthStatus('2026-01-01T12:00:00Z')).toBe('active');
  });

  it('returns "inactive" when last seen 5-30 minutes ago', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T12:15:00Z'));
    expect(computeHealthStatus('2026-01-01T12:00:00Z')).toBe('inactive');
  });

  it('returns "stale" when last seen > 30 minutes ago', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T13:00:00Z'));
    expect(computeHealthStatus('2026-01-01T12:00:00Z')).toBe('stale');
  });

  it('returns "active" at exactly the boundary (< 5 min)', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T12:04:59.999Z'));
    expect(computeHealthStatus('2026-01-01T12:00:00Z')).toBe('active');
  });

  it('returns "inactive" at exactly 5 minutes', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T12:05:00Z'));
    expect(computeHealthStatus('2026-01-01T12:00:00Z')).toBe('inactive');
  });

  it('returns "stale" at exactly 30 minutes', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T12:30:00Z'));
    expect(computeHealthStatus('2026-01-01T12:00:00Z')).toBe('stale');
  });
});
