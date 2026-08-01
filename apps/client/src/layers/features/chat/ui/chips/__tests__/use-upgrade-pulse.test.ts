/**
 * @vitest-environment jsdom
 */
import { describe, it, expect } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useUpgradePulse } from '../use-upgrade-pulse';

describe('useUpgradePulse', () => {
  it('does not pulse for a chip that was already upgraded when it mounted', () => {
    const { result } = renderHook(() => useUpgradePulse(true));

    expect(result.current.pulsing).toBe(false);
  });

  it('pulses on the edge from read to edited', () => {
    const { result, rerender } = renderHook(({ upgraded }) => useUpgradePulse(upgraded), {
      initialProps: { upgraded: false },
    });

    expect(result.current.pulsing).toBe(false);
    rerender({ upgraded: true });

    expect(result.current.pulsing).toBe(true);
  });

  it('spends the pulse once, however many edits follow', () => {
    const { result, rerender } = renderHook(({ upgraded }) => useUpgradePulse(upgraded), {
      initialProps: { upgraded: false },
    });

    rerender({ upgraded: true });
    act(() => result.current.end());
    expect(result.current.pulsing).toBe(false);

    // Every later edit re-renders with `upgraded` still true — the accumulator
    // never unsets it — and none of them may fire the ring again.
    rerender({ upgraded: true });
    rerender({ upgraded: true });

    expect(result.current.pulsing).toBe(false);
  });

  it('stays quiet while nothing has been upgraded', () => {
    const { result, rerender } = renderHook(({ upgraded }) => useUpgradePulse(upgraded), {
      initialProps: { upgraded: false },
    });

    rerender({ upgraded: false });
    rerender({ upgraded: false });

    expect(result.current.pulsing).toBe(false);
  });
});
