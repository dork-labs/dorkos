/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useResolvedTheme } from '../use-theme';

const STORAGE_KEY = 'dorkos-theme';
const DARK_MQ = '(prefers-color-scheme: dark)';

/** A controllable matchMedia stub: reports `matches` and lets a test fire a change. */
function installMatchMedia(initialDark: boolean) {
  let matches = initialDark;
  const listeners = new Set<(e: MediaQueryListEvent) => void>();
  const mql = {
    get matches() {
      return matches;
    },
    media: DARK_MQ,
    onchange: null,
    addEventListener: (_: string, cb: (e: MediaQueryListEvent) => void) => listeners.add(cb),
    removeEventListener: (_: string, cb: (e: MediaQueryListEvent) => void) => listeners.delete(cb),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  };
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: vi.fn().mockReturnValue(mql),
  });
  return {
    /** Flip the OS preference and notify subscribers, as a real MQ change would. */
    setDark(next: boolean) {
      matches = next;
      for (const cb of listeners) cb({ matches: next } as MediaQueryListEvent);
    },
  };
}

beforeEach(() => {
  localStorage.clear();
});
afterEach(() => {
  // Drop the stub so a later test falls back to jsdom's default (no matchMedia).
  Reflect.deleteProperty(window, 'matchMedia');
  vi.restoreAllMocks();
});

describe('useResolvedTheme', () => {
  it('returns the explicit preference for light', () => {
    localStorage.setItem(STORAGE_KEY, 'light');
    const { result } = renderHook(() => useResolvedTheme());
    expect(result.current).toBe('light');
  });

  it('returns the explicit preference for dark', () => {
    localStorage.setItem(STORAGE_KEY, 'dark');
    const { result } = renderHook(() => useResolvedTheme());
    expect(result.current).toBe('dark');
  });

  it('resolves "system" to dark when the OS prefers dark (the bug: this used to fall to light)', () => {
    localStorage.setItem(STORAGE_KEY, 'system');
    installMatchMedia(true);
    const { result } = renderHook(() => useResolvedTheme());
    expect(result.current).toBe('dark');
  });

  it('resolves "system" to light when the OS prefers light', () => {
    localStorage.setItem(STORAGE_KEY, 'system');
    installMatchMedia(false);
    const { result } = renderHook(() => useResolvedTheme());
    expect(result.current).toBe('light');
  });

  it('tracks a live OS change while on "system"', () => {
    localStorage.setItem(STORAGE_KEY, 'system');
    const mq = installMatchMedia(false);
    const { result } = renderHook(() => useResolvedTheme());
    expect(result.current).toBe('light');

    act(() => mq.setDark(true));
    expect(result.current).toBe('dark');
  });
});
