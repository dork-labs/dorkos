import { describe, it, expect, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useStableCallback } from '../use-render-slot';

describe('useStableCallback', () => {
  it('keeps one identity and calls the latest handler', () => {
    const first = vi.fn(() => 'first');
    const second = vi.fn(() => 'second');
    const { result, rerender } = renderHook(({ fn }) => useStableCallback(fn), {
      initialProps: { fn: first as () => string },
    });
    const stable = result.current;
    rerender({ fn: second });
    expect(result.current).toBe(stable);
    expect(result.current!()).toBe('second');
    expect(first).not.toHaveBeenCalled();
  });

  it('stays absent when there is no handler', () => {
    const { result } = renderHook(() => useStableCallback(undefined));
    expect(result.current).toBeUndefined();
  });
});
