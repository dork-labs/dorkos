import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useElapsedTime } from '../use-elapsed-time';

describe('useElapsedTime', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns zero when startTime is null', () => {
    const { result } = renderHook(() => useElapsedTime(null));
    expect(result.current.formatted).toBe('0m 00s');
    expect(result.current.ms).toBe(0);
  });

  it('formats seconds correctly (< 1 minute)', () => {
    const now = Date.now();
    vi.setSystemTime(now);
    const { result } = renderHook(() => useElapsedTime(now - 5000));
    expect(result.current.formatted).toBe('0m 05s');
  });

  it('formats minutes and seconds (1m 05s)', () => {
    const now = Date.now();
    vi.setSystemTime(now);
    const { result } = renderHook(() => useElapsedTime(now - 65000));
    expect(result.current.formatted).toBe('1m 05s');
  });

  it('formats hours and minutes (1h 23m)', () => {
    const now = Date.now();
    vi.setSystemTime(now);
    const { result } = renderHook(() => useElapsedTime(now - (83 * 60 * 1000)));
    expect(result.current.formatted).toBe('1h 23m');
  });

  it('updates every second via interval', () => {
    const now = Date.now();
    vi.setSystemTime(now);
    const { result } = renderHook(() => useElapsedTime(now));

    expect(result.current.formatted).toBe('0m 00s');

    act(() => {
      vi.advanceTimersByTime(5000);
    });

    expect(result.current.formatted).toBe('0m 05s');
  });

  it('cleans up interval on unmount', () => {
    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');
    const now = Date.now();
    vi.setSystemTime(now);
    const { unmount } = renderHook(() => useElapsedTime(now));

    unmount();
    expect(clearIntervalSpy).toHaveBeenCalled();
    clearIntervalSpy.mockRestore();
  });

  it('cleans up interval when startTime becomes null', () => {
    const now = Date.now();
    vi.setSystemTime(now);
    const { result, rerender } = renderHook(
      ({ startTime }: { startTime: number | null }) => useElapsedTime(startTime),
      { initialProps: { startTime: now as number | null } }
    );

    expect(result.current.ms).toBeGreaterThanOrEqual(0);

    rerender({ startTime: null });
    expect(result.current.formatted).toBe('0m 00s');
    expect(result.current.ms).toBe(0);
  });
});
