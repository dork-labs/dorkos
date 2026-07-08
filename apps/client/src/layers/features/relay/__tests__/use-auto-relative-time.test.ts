import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useAutoRelativeTime } from '../model/use-auto-relative-time';

// Pin the clock so the shared, calendar-aware formatRelativeTime produces
// deterministic output regardless of when the suite runs.
const FIXED_NOW = new Date('2026-06-17T12:00:00');

describe('useAutoRelativeTime', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns "Just now" for timestamps under 1 minute old', () => {
    const now = new Date().toISOString();
    const { result } = renderHook(() => useAutoRelativeTime(now));
    expect(result.current).toBe('Just now');
  });

  it('returns "Xm ago" for timestamps under 1 hour old', () => {
    const fiveMinAgo = new Date(Date.now() - 5 * 60_000).toISOString();
    const { result } = renderHook(() => useAutoRelativeTime(fiveMinAgo));
    expect(result.current).toBe('5m ago');
  });

  it('returns "Xh ago" for timestamps earlier the same day', () => {
    const twoHoursAgo = new Date(Date.now() - 2 * 3_600_000).toISOString();
    const { result } = renderHook(() => useAutoRelativeTime(twoHoursAgo));
    expect(result.current).toBe('2h ago');
  });

  it('returns a calendar label for timestamps several days old', () => {
    const threeDaysAgo = new Date(Date.now() - 3 * 86_400_000).toISOString();
    const { result } = renderHook(() => useAutoRelativeTime(threeDaysAgo));
    // Within the last week the shared formatter renders "{weekday}, {time}".
    expect(result.current).toMatch(/^[A-Z][a-z]{2}, /);
  });

  it('returns empty string for undefined input', () => {
    const { result } = renderHook(() => useAutoRelativeTime(undefined));
    expect(result.current).toBe('');
  });

  it('auto-refreshes at 10s interval for recent timestamps', () => {
    const now = new Date().toISOString();
    const { result } = renderHook(() => useAutoRelativeTime(now));
    expect(result.current).toBe('Just now');

    // Advance 65 seconds
    act(() => {
      vi.advanceTimersByTime(65_000);
    });
    expect(result.current).toBe('1m ago');
  });

  it('cleans up interval on unmount', () => {
    const clearSpy = vi.spyOn(globalThis, 'clearInterval');
    const now = new Date().toISOString();
    const { unmount } = renderHook(() => useAutoRelativeTime(now));
    unmount();
    expect(clearSpy).toHaveBeenCalled();
    clearSpy.mockRestore();
  });
});
