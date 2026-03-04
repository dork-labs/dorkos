import { describe, it, expect, vi, afterEach } from 'vitest';
import { computeHealthStatus } from '../health.js';

describe('computeHealthStatus', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns "stale" when lastSeenAt is null', () => {
    expect(computeHealthStatus(null)).toBe('stale');
  });

  it('returns "active" when last seen < 1 hour ago', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T12:30:00Z'));
    expect(computeHealthStatus('2026-01-01T12:00:00Z')).toBe('active');
  });

  it('returns "inactive" when last seen 1-24 hours ago', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-02T00:00:00Z')); // 12 hours later
    expect(computeHealthStatus('2026-01-01T12:00:00Z')).toBe('inactive');
  });

  it('returns "stale" when last seen > 24 hours ago', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-02T13:00:00Z'));
    expect(computeHealthStatus('2026-01-01T12:00:00Z')).toBe('stale');
  });

  it('returns "active" at exactly the boundary (< 1 hr)', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T12:59:59.999Z'));
    expect(computeHealthStatus('2026-01-01T12:00:00Z')).toBe('active');
  });

  it('returns "inactive" at exactly 1 hour', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T13:00:00Z'));
    expect(computeHealthStatus('2026-01-01T12:00:00Z')).toBe('inactive');
  });

  it('returns "stale" at exactly 24 hours', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-02T12:00:00Z'));
    expect(computeHealthStatus('2026-01-01T12:00:00Z')).toBe('stale');
  });
});
