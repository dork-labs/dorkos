import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useRotatingVerb } from '../model/use-rotating-verb';

const TEST_VERBS = ['Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon'] as const;

describe('useRotatingVerb', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns an initial verb from the list', () => {
    const { result } = renderHook(() => useRotatingVerb(TEST_VERBS, 3500));
    expect(TEST_VERBS).toContain(result.current.verb);
  });

  it('returns a key string', () => {
    const { result } = renderHook(() => useRotatingVerb(TEST_VERBS, 3500));
    expect(result.current.key).toMatch(/^verb-\d+$/);
  });

  it('rotates verb after interval', () => {
    const { result } = renderHook(() => useRotatingVerb(TEST_VERBS, 3500));
    const initialVerb = result.current.verb;

    let changed = false;
    for (let i = 0; i < 10; i++) {
      act(() => {
        vi.advanceTimersByTime(3500);
      });
      if (result.current.verb !== initialVerb) {
        changed = true;
        break;
      }
    }
    expect(changed).toBe(true);
  });

  it('increments key on each rotation', () => {
    const { result } = renderHook(() => useRotatingVerb(TEST_VERBS, 3500));
    expect(result.current.key).toBe('verb-0');

    act(() => {
      vi.advanceTimersByTime(3500);
    });
    expect(result.current.key).toBe('verb-1');

    act(() => {
      vi.advanceTimersByTime(3500);
    });
    expect(result.current.key).toBe('verb-2');
  });

  it('does not repeat the same verb consecutively (with sufficient list)', () => {
    const { result } = renderHook(() => useRotatingVerb(TEST_VERBS, 1000));
    let prevVerb = result.current.verb;
    let consecutiveRepeat = false;

    for (let i = 0; i < 20; i++) {
      act(() => {
        vi.advanceTimersByTime(1000);
      });
      if (result.current.verb === prevVerb) {
        consecutiveRepeat = true;
        break;
      }
      prevVerb = result.current.verb;
    }
    expect(consecutiveRepeat).toBe(false);
  });

  it('handles single-verb list gracefully', () => {
    const { result } = renderHook(() => useRotatingVerb(['Only'], 3500));
    expect(result.current.verb).toBe('Only');
  });

  it('handles empty verb list gracefully', () => {
    const { result } = renderHook(() => useRotatingVerb([], 3500));
    expect(result.current.verb).toBe('');
  });
});
