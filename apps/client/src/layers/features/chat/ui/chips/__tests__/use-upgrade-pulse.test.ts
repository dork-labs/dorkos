/**
 * @vitest-environment jsdom
 */
import { describe, it, expect } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useUpgradePulses } from '../use-upgrade-pulse';

describe('useUpgradePulses', () => {
  it('owes a ring to a chip that has just been upgraded', () => {
    const { result } = renderHook(() => useUpgradePulses());

    expect(result.current.shouldPulse('file:/repo/a.ts', true)).toBe(true);
  });

  it('owes nothing to a chip that was never upgraded', () => {
    const { result } = renderHook(() => useUpgradePulses());

    expect(result.current.shouldPulse('file:/repo/a.ts', undefined)).toBe(false);
    expect(result.current.shouldPulse('file:/repo/a.ts', false)).toBe(false);
  });

  it('spends the ring once, however many renders follow', () => {
    const { result, rerender } = renderHook(() => useUpgradePulses());

    act(() => result.current.acknowledge('file:/repo/a.ts'));
    rerender();

    // Every later edit re-renders with `upgraded` still true — the accumulator
    // never unsets it — and none of them may fire the ring again.
    expect(result.current.shouldPulse('file:/repo/a.ts', true)).toBe(false);
  });

  it('keeps the ring owed to a chip that has not spent it', () => {
    const { result, rerender } = renderHook(() => useUpgradePulses());

    act(() => result.current.acknowledge('file:/repo/a.ts'));
    rerender();

    expect(result.current.shouldPulse('file:/repo/b.ts', true)).toBe(true);
  });

  it('survives the chip leaving and coming back', () => {
    // This is the whole reason the ledger is not the chip's own state. The live
    // row holds four touches, so a file read early in a turn leaves the row and
    // remounts when it is edited — which is exactly the moment the ring is for.
    const { result, rerender } = renderHook(() => useUpgradePulses());

    expect(result.current.shouldPulse('file:/repo/a.ts', true)).toBe(true);
    rerender();
    expect(result.current.shouldPulse('file:/repo/a.ts', true)).toBe(true);

    act(() => result.current.acknowledge('file:/repo/a.ts'));
    rerender();
    expect(result.current.shouldPulse('file:/repo/a.ts', true)).toBe(false);
  });
});
