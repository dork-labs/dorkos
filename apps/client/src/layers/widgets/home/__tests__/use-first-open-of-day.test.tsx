// @vitest-environment jsdom
/**
 * The day's first look at Home happens once (team-room-home spec D3.6).
 *
 * The failure this pins is the quiet one: a hook that answers `true` and then
 * immediately answers `false` to its own write plays no animation at all, and
 * nothing on screen says why.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, cleanup } from '@testing-library/react';
import { useFirstOpenOfDay } from '../model/use-first-open-of-day';

const STORAGE_KEY = 'dorkos:home-opened-on';

/** Today, the way the hook stamps it. */
function todayStamp(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('useFirstOpenOfDay', () => {
  it('is true the first time today, and records that it happened', () => {
    const { result } = renderHook(() => useFirstOpenOfDay());

    expect(result.current).toBe(true);
    expect(localStorage.getItem(STORAGE_KEY)).toBe(todayStamp());
  });

  it('is false on the next mount the same day', () => {
    renderHook(() => useFirstOpenOfDay());
    cleanup();

    const { result } = renderHook(() => useFirstOpenOfDay());

    expect(result.current).toBe(false);
  });

  it('is true again the next day', () => {
    localStorage.setItem(STORAGE_KEY, '2020-01-01');

    const { result } = renderHook(() => useFirstOpenOfDay());

    expect(result.current).toBe(true);
  });

  it('holds its answer across re-renders — the write must not undo the read', () => {
    const { result, rerender } = renderHook(() => useFirstOpenOfDay());

    expect(result.current).toBe(true);
    rerender();
    rerender();
    // The effect has already written today's stamp by now. A hook that re-read
    // storage on every render would have flipped to `false` here, killing the
    // animation mid-flight.
    expect(result.current).toBe(true);
  });

  it('still settles when the browser refuses to remember', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('storage disabled');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('storage disabled');
    });

    // A thrown decoration is worse than a replayed one.
    expect(() => renderHook(() => useFirstOpenOfDay())).not.toThrow();
  });
});
