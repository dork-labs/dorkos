/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useLastVisited } from '../model/use-last-visited';

const STORAGE_KEY = 'dorkos:lastVisitedDashboard';

describe('useLastVisited', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    localStorage.clear();
  });

  it('returns null when no previous visit is stored', () => {
    const { result } = renderHook(() => useLastVisited());

    act(() => {
      // Flush effects
    });

    expect(result.current).toBeNull();
  });

  it('writes current timestamp to localStorage on mount', () => {
    const now = new Date('2026-01-15T10:00:00.000Z');
    vi.setSystemTime(now);

    renderHook(() => useLastVisited());

    const stored = localStorage.getItem(STORAGE_KEY);
    expect(stored).toBe(now.toISOString());
  });

  it('returns previous timestamp on subsequent visits', () => {
    const previousVisit = '2026-01-14T09:00:00.000Z';
    localStorage.setItem(STORAGE_KEY, previousVisit);

    const { result } = renderHook(() => useLastVisited());

    act(() => {
      // Flush effects
    });

    expect(result.current).toBe(previousVisit);
  });

  it('overwrites stored timestamp on each mount', () => {
    const firstVisit = '2026-01-14T09:00:00.000Z';
    const secondVisit = new Date('2026-01-15T10:00:00.000Z');
    localStorage.setItem(STORAGE_KEY, firstVisit);
    vi.setSystemTime(secondVisit);

    renderHook(() => useLastVisited());

    const stored = localStorage.getItem(STORAGE_KEY);
    expect(stored).toBe(secondVisit.toISOString());
  });
});
