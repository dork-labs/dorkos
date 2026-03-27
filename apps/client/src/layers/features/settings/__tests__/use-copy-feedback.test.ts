// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useCopyFeedback } from '../lib/use-copy-feedback';

beforeEach(() => {
  vi.useFakeTimers();
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText: vi.fn().mockResolvedValue(undefined) },
    writable: true,
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useCopyFeedback', () => {
  it('returns [false, copy] initially', () => {
    const { result } = renderHook(() => useCopyFeedback());
    const [copied] = result.current;
    expect(copied).toBe(false);
  });

  it('sets copied to true after calling copy', () => {
    const { result } = renderHook(() => useCopyFeedback());
    const [, copy] = result.current;

    act(() => {
      copy('hello');
    });

    const [copied] = result.current;
    expect(copied).toBe(true);
  });

  it('writes text to clipboard', () => {
    const { result } = renderHook(() => useCopyFeedback());
    const [, copy] = result.current;

    act(() => {
      copy('some text');
    });

    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('some text');
  });

  it('reverts copied to false after the timeout', () => {
    const { result } = renderHook(() => useCopyFeedback(1500));
    const [, copy] = result.current;

    act(() => {
      copy('hello');
    });

    expect(result.current[0]).toBe(true);

    act(() => {
      vi.advanceTimersByTime(1500);
    });

    expect(result.current[0]).toBe(false);
  });

  it('respects a custom timeout duration', () => {
    const { result } = renderHook(() => useCopyFeedback(500));
    const [, copy] = result.current;

    act(() => {
      copy('hello');
    });

    act(() => {
      vi.advanceTimersByTime(499);
    });
    expect(result.current[0]).toBe(true);

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current[0]).toBe(false);
  });
});
