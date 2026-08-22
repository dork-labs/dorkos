/**
 * The anchor latches at the first SETTLED model, not at mount (spec
 * `sidebar-simplification` D6, BC-36).
 *
 * The defect this pins: on `/channels` the room list arrives after the panel
 * does, so the anchor went `null → room` a beat late. Latched at mount, that
 * reads exactly like the operator switching conversations, and the panel
 * smooth-scrolled itself while they were doing nothing.
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { createRef } from 'react';

const reducedMotion = { value: false as boolean | null };
vi.mock('motion/react', () => ({ useReducedMotion: () => reducedMotion.value }));

const { useScrollToActive } = await import('../use-scroll-to-active');

let scrollIntoView: ReturnType<typeof vi.fn<(options?: boolean | ScrollIntoViewOptions) => void>>;

/** A container holding one row marked as the open conversation. */
function containerWithActiveRow() {
  const container = document.createElement('div');
  const row = document.createElement('button');
  row.setAttribute('aria-current', 'page');
  row.scrollIntoView = scrollIntoView;
  container.append(row);
  document.body.append(container);
  const ref = createRef<HTMLElement>();
  (ref as { current: HTMLElement }).current = container;
  return ref;
}

beforeEach(() => {
  scrollIntoView = vi.fn();
  reducedMotion.value = false;
});

afterEach(() => {
  document.body.innerHTML = '';
});

describe('useScrollToActive', () => {
  it('does nothing at all while the panel is still booting', () => {
    const ref = containerWithActiveRow();
    renderHook(({ anchor }) => useScrollToActive(ref, anchor, false), {
      initialProps: { anchor: 'room:general' },
    });
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it('positions instantly on the first settled model, never travelling', () => {
    // `behavior: 'auto'` in a layout effect: the open row is simply in view in
    // the first frame, rather than sliding there in front of the operator.
    const ref = containerWithActiveRow();
    renderHook(() => useScrollToActive(ref, 'room:general', true));
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest', behavior: 'auto' });
  });

  it('does not read the room list landing as a switch (the /channels regression)', () => {
    // The anchor is `null` while the rooms query is in flight and becomes the
    // open room when it answers. Both of those happen BEFORE the gate opens, so
    // neither is a switch — and when the gate does open, the row is positioned
    // instantly rather than travelled to.
    const ref = containerWithActiveRow();
    const { rerender } = renderHook(
      ({ anchor, settled }) => useScrollToActive(ref, anchor, settled),
      { initialProps: { anchor: null as string | null, settled: false } }
    );

    rerender({ anchor: 'room:general', settled: false });
    expect(scrollIntoView).not.toHaveBeenCalled();

    rerender({ anchor: 'room:general', settled: true });
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest', behavior: 'auto' });
  });

  it('smooth-scrolls when the operator actually switches after settle', () => {
    const ref = containerWithActiveRow();
    const { rerender } = renderHook(({ anchor }) => useScrollToActive(ref, anchor, true), {
      initialProps: { anchor: 'room:general' as string | null },
    });
    scrollIntoView.mockClear();

    rerender({ anchor: 'session:abc' });
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest', behavior: 'smooth' });
  });

  it('never travels under a reduced-motion preference', () => {
    reducedMotion.value = true;
    const ref = containerWithActiveRow();
    const { rerender } = renderHook(({ anchor }) => useScrollToActive(ref, anchor, true), {
      initialProps: { anchor: 'room:general' as string | null },
    });
    scrollIntoView.mockClear();

    rerender({ anchor: 'session:abc' });
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest', behavior: 'auto' });
  });

  it('stays put when the model rebuilds with the same anchor', () => {
    const ref = containerWithActiveRow();
    const { rerender } = renderHook(({ anchor }) => useScrollToActive(ref, anchor, true), {
      initialProps: { anchor: 'room:general' as string | null },
    });
    scrollIntoView.mockClear();

    rerender({ anchor: 'room:general' });
    expect(scrollIntoView).not.toHaveBeenCalled();
  });
});
