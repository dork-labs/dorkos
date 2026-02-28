/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, cleanup } from '@testing-library/react';
import { usePrefersReducedMotion } from '../use-reduced-motion';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Creates a mock MediaQueryList with a controllable `matches` value. */
function createMockMql(initialMatches: boolean) {
  const listeners: Array<(e: MediaQueryListEvent) => void> = [];
  const mql = {
    matches: initialMatches,
    media: '(prefers-reduced-motion: reduce)',
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn((_, handler: (e: MediaQueryListEvent) => void) => {
      listeners.push(handler);
    }),
    removeEventListener: vi.fn((_, handler: (e: MediaQueryListEvent) => void) => {
      const idx = listeners.indexOf(handler);
      if (idx >= 0) listeners.splice(idx, 1);
    }),
    dispatchEvent: vi.fn(),
  };

  /** Simulate the system preference changing at runtime. */
  function setMatches(value: boolean) {
    mql.matches = value;
    for (const listener of listeners) {
      listener({ matches: value } as MediaQueryListEvent);
    }
  }

  return { mql, setMatches, listeners };
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(cleanup);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('usePrefersReducedMotion', () => {
  it('returns false when system prefers no reduction', () => {
    const { mql } = createMockMql(false);
    vi.spyOn(window, 'matchMedia').mockReturnValue(mql as unknown as MediaQueryList);

    const { result } = renderHook(() => usePrefersReducedMotion());
    expect(result.current).toBe(false);
  });

  it('returns true when system prefers reduced motion', () => {
    const { mql } = createMockMql(true);
    vi.spyOn(window, 'matchMedia').mockReturnValue(mql as unknown as MediaQueryList);

    const { result } = renderHook(() => usePrefersReducedMotion());
    expect(result.current).toBe(true);
  });

  it('reacts to runtime changes in system preference', () => {
    const { mql, setMatches } = createMockMql(false);
    vi.spyOn(window, 'matchMedia').mockReturnValue(mql as unknown as MediaQueryList);

    const { result } = renderHook(() => usePrefersReducedMotion());
    expect(result.current).toBe(false);

    // Simulate user toggling reduce-motion in system settings
    act(() => {
      setMatches(true);
    });
    expect(result.current).toBe(true);

    // Toggle back
    act(() => {
      setMatches(false);
    });
    expect(result.current).toBe(false);
  });

  it('registers a change event listener on the MediaQueryList', () => {
    const { mql } = createMockMql(false);
    vi.spyOn(window, 'matchMedia').mockReturnValue(mql as unknown as MediaQueryList);

    renderHook(() => usePrefersReducedMotion());
    expect(mql.addEventListener).toHaveBeenCalledWith('change', expect.any(Function));
  });

  it('cleans up the event listener on unmount', () => {
    const { mql } = createMockMql(false);
    vi.spyOn(window, 'matchMedia').mockReturnValue(mql as unknown as MediaQueryList);

    const { unmount } = renderHook(() => usePrefersReducedMotion());
    unmount();
    expect(mql.removeEventListener).toHaveBeenCalledWith('change', expect.any(Function));
  });
});
