import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { renderHook, act, cleanup } from '@testing-library/react';
import { useTabVisibility } from '../use-tab-visibility';

afterEach(cleanup);

beforeEach(() => {
  Object.defineProperty(document, 'hidden', { value: false, writable: true, configurable: true });
});

describe('useTabVisibility', () => {
  it('returns true when document is not hidden', () => {
    const { result } = renderHook(() => useTabVisibility());
    expect(result.current).toBe(true);
  });

  it('returns false when document is hidden', () => {
    Object.defineProperty(document, 'hidden', { value: true, writable: true, configurable: true });
    const { result } = renderHook(() => useTabVisibility());
    expect(result.current).toBe(false);
  });

  it('updates when visibility changes', () => {
    const { result } = renderHook(() => useTabVisibility());
    expect(result.current).toBe(true);

    act(() => {
      Object.defineProperty(document, 'hidden', {
        value: true,
        writable: true,
        configurable: true,
      });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(result.current).toBe(false);
  });
});
