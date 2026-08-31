/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, cleanup } from '@testing-library/react';
import { setPrefersReducedMotion } from '@/test-setup';

const { usePinnedDrainBeat, ALL_CLEAR_BEAT_MS } = await import('../model/use-pinned-drain-beat');

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('usePinnedDrainBeat', () => {
  it('beats when the last pinned item leaves while the popover is open', () => {
    const { result, rerender } = renderHook(({ count, open }) => usePinnedDrainBeat(count, open), {
      initialProps: { count: 1, open: true },
    });
    expect(result.current).toBe(false);

    rerender({ count: 0, open: true });
    expect(result.current).toBe(true);
  });

  it('puts the flag down again after the beat', () => {
    const { result, rerender } = renderHook(({ count, open }) => usePinnedDrainBeat(count, open), {
      initialProps: { count: 1, open: true },
    });
    rerender({ count: 0, open: true });
    expect(result.current).toBe(true);

    act(() => {
      vi.advanceTimersByTime(ALL_CLEAR_BEAT_MS);
    });
    expect(result.current).toBe(false);
  });

  it('says nothing when the queue drains with the popover shut', () => {
    // The beat is the reward for having just answered the last thing. Played
    // into a closed popover it is a beat nobody saw.
    const { result, rerender } = renderHook(({ count, open }) => usePinnedDrainBeat(count, open), {
      initialProps: { count: 1, open: false },
    });
    rerender({ count: 0, open: false });
    expect(result.current).toBe(false);
  });

  it('does not replay for somebody who opens the popover later', () => {
    const { result, rerender } = renderHook(({ count, open }) => usePinnedDrainBeat(count, open), {
      initialProps: { count: 1, open: false },
    });
    rerender({ count: 0, open: false });
    rerender({ count: 0, open: true });

    // The drain already happened, off screen. Opening the panel afterwards is
    // not the moment being celebrated.
    expect(result.current).toBe(false);
  });

  it('beats once per drain, not once per render', () => {
    const { result, rerender } = renderHook(({ count, open }) => usePinnedDrainBeat(count, open), {
      initialProps: { count: 1, open: true },
    });
    rerender({ count: 0, open: true });
    expect(result.current).toBe(true);

    act(() => {
      vi.advanceTimersByTime(ALL_CLEAR_BEAT_MS);
    });
    // Still empty, still open, several more renders — and no second beat.
    rerender({ count: 0, open: true });
    rerender({ count: 0, open: true });
    expect(result.current).toBe(false);
  });

  it('clears the flag when something new arrives inside the beat window', () => {
    // The defect the sidebar's own beat had to fix, and it reaches here the same
    // way: answer the last ask, and something arrives within 2.5 seconds. An
    // early return would have cancelled the timer that lowers the flag, leaving
    // "All clear" on screen with a full queue underneath it.
    const { result, rerender } = renderHook(({ count, open }) => usePinnedDrainBeat(count, open), {
      initialProps: { count: 1, open: true },
    });
    rerender({ count: 0, open: true });
    expect(result.current).toBe(true);

    rerender({ count: 1, open: true });
    expect(result.current).toBe(false);
  });

  it('is suppressed entirely under prefers-reduced-motion', () => {
    setPrefersReducedMotion(true);
    const { result, rerender } = renderHook(({ count, open }) => usePinnedDrainBeat(count, open), {
      initialProps: { count: 1, open: true },
    });
    rerender({ count: 0, open: true });

    // The visible half only. The all-clear CHIME is deliberately not this
    // hook's — it hangs off the queue draining app-wide, in
    // `features/notifications`'s `NotificationCenter`, so reduced motion
    // silences the check mark and leaves the sound alone. That split is
    // asserted in `NotificationCenter.test.tsx`.
    expect(result.current).toBe(false);
  });
});
