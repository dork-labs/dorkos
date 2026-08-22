// @vitest-environment jsdom
/**
 * What counts as an arrival, and what does not (spec D5).
 *
 * The rule this file pins is the one D6 cares about most: **a panel painting is
 * not a panel changing.** A boot that tinted eight rows would be exactly the
 * assembling-in-front-of-you that the whole redesign removed, wearing a nicer
 * animation.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { ARRIVED_TINT_MS, sectionLayoutKey } from '../sidebar-motion';
import { useArrivedRows } from '../use-arrived-rows';

/** A section's rows, as the layout key spells them. */
function keyOf(...rows: string[]): string {
  return sectionLayoutKey(rows.map((key) => ({ key })));
}

describe('useArrivedRows', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('reports nothing for the rows the panel painted with', () => {
    // The first render is the boot, warm or cold. Red if the hook ever seeds
    // itself empty and treats the opening list as eight arrivals.
    const { result } = renderHook(() => useArrivedRows(keyOf('a', 'b', 'c'), true));
    expect([...result.current]).toEqual([]);
  });

  it('tints a row that turns up afterwards, and only that row', () => {
    const { result, rerender } = renderHook(
      ({ key }: { key: string }) => useArrivedRows(key, true),
      { initialProps: { key: keyOf('a', 'b') } }
    );

    rerender({ key: keyOf('new', 'a', 'b') });
    expect([...result.current]).toEqual(['new']);
  });

  it('lets go of the tint 200 ms later, so it can never be a state', () => {
    const { result, rerender } = renderHook(
      ({ key }: { key: string }) => useArrivedRows(key, true),
      { initialProps: { key: keyOf('a') } }
    );
    rerender({ key: keyOf('new', 'a') });
    expect(result.current.has('new')).toBe(true);

    act(() => vi.advanceTimersByTime(ARRIVED_TINT_MS));
    expect([...result.current]).toEqual([]);
  });

  it('does not tint a row that only moved', () => {
    // A reorder is the `layout` FLIP's business. Tinting on it too would flash
    // half of Today every time the hold released.
    const { result, rerender } = renderHook(
      ({ key }: { key: string }) => useArrivedRows(key, true),
      { initialProps: { key: keyOf('a', 'b') } }
    );
    rerender({ key: keyOf('b', 'a') });
    expect([...result.current]).toEqual([]);
  });

  it('reports nothing while the boot gate is still shut', () => {
    // The window a warm boot spends between its first paint and the gate
    // opening: rows genuinely appear there, and every one of them is the panel
    // loading rather than something turning up.
    const { result, rerender } = renderHook(
      ({ key, on }: { key: string; on: boolean }) => useArrivedRows(key, on),
      { initialProps: { key: keyOf('a'), on: false } }
    );

    rerender({ key: keyOf('a', 'b'), on: false });
    expect([...result.current]).toEqual([]);

    // …and what turned up while the gate was shut is not owed a tint once it
    // opens either: the row is already on screen.
    rerender({ key: keyOf('a', 'b'), on: true });
    expect([...result.current]).toEqual([]);

    rerender({ key: keyOf('a', 'b', 'c'), on: true });
    expect([...result.current]).toEqual(['c']);
  });
});
