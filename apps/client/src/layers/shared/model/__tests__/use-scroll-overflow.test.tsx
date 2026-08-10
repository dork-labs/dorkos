/**
 * Whether a scroller has more content past an edge — the question a fade cue is
 * drawn from (DOR-1043).
 *
 * jsdom lays nothing out, so every metric here is stubbed on purpose: what is
 * pinned is the RULE that turns `scrollTop`/`scrollHeight`/`clientHeight` into
 * two booleans, which is the whole of the hook. Pixels stay the browser gate's.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { useRef, useState } from 'react';
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { useScrollOverflow } from '../scroll/use-scroll-overflow';

/** Stub the three layout numbers jsdom always reports as zero. */
function measureAs(
  el: HTMLElement,
  metrics: { scrollHeight: number; clientHeight: number; scrollTop?: number }
) {
  Object.defineProperty(el, 'scrollHeight', { value: metrics.scrollHeight, configurable: true });
  Object.defineProperty(el, 'clientHeight', { value: metrics.clientHeight, configurable: true });
  el.scrollTop = metrics.scrollTop ?? 0;
}

/**
 * A scroller wired to the hook, reporting both edges as data attributes.
 *
 * `rows` exists so a test can change the CONTENT without touching the scroll
 * position — the case a scroll listener alone never hears about.
 */
function Probe() {
  const ref = useRef<HTMLDivElement>(null);
  const { onScroll, above, below } = useScrollOverflow(ref);
  const [rows, setRows] = useState(1);

  return (
    <div>
      <button type="button" onClick={() => setRows((n) => n + 1)}>
        add
      </button>
      <div
        ref={ref}
        onScroll={onScroll}
        data-testid="scroller"
        data-above={String(above)}
        data-below={String(below)}
      >
        {Array.from({ length: rows }, (_, i) => (
          <p key={i}>row {i}</p>
        ))}
      </div>
    </div>
  );
}

/** The scroller, and what it currently says about its two edges. */
function scroller(): HTMLElement {
  return screen.getByTestId('scroller');
}

describe('useScrollOverflow', () => {
  afterEach(cleanup);

  it('draws no cue when everything already fits', () => {
    render(<Probe />);
    measureAs(scroller(), { scrollHeight: 200, clientHeight: 200 });
    fireEvent.scroll(scroller());

    expect(scroller().dataset.above).toBe('false');
    expect(scroller().dataset.below).toBe('false');
  });

  it('says there is more below while parked at the top', () => {
    render(<Probe />);
    measureAs(scroller(), { scrollHeight: 600, clientHeight: 200, scrollTop: 0 });
    fireEvent.scroll(scroller());

    expect(scroller().dataset.below).toBe('true');
    expect(scroller().dataset.above).toBe('false');
  });

  it('says there is more both ways in the middle', () => {
    render(<Probe />);
    measureAs(scroller(), { scrollHeight: 600, clientHeight: 200, scrollTop: 150 });
    fireEvent.scroll(scroller());

    expect(scroller().dataset.above).toBe('true');
    expect(scroller().dataset.below).toBe('true');
  });

  it('drops the bottom cue at the end of the scroll, and keeps the top one', () => {
    render(<Probe />);
    measureAs(scroller(), { scrollHeight: 600, clientHeight: 200, scrollTop: 400 });
    fireEvent.scroll(scroller());

    expect(scroller().dataset.below).toBe('false');
    expect(scroller().dataset.above).toBe('true');
  });

  it('ignores a sub-pixel remainder rather than pinning a cue on forever', () => {
    // Fractional layout heights leave a fraction of a pixel of scroll range at
    // rest, which is not content and must not advertise itself as content.
    render(<Probe />);
    measureAs(scroller(), { scrollHeight: 200.5, clientHeight: 200, scrollTop: 0 });
    fireEvent.scroll(scroller());

    expect(scroller().dataset.below).toBe('false');
  });

  it('re-measures when the content changes under a still scroll position', () => {
    // An approval arriving over the event stream fires no scroll event: the
    // list simply gets longer while nobody touched it.
    render(<Probe />);
    measureAs(scroller(), { scrollHeight: 200, clientHeight: 200 });
    fireEvent.scroll(scroller());
    expect(scroller().dataset.below).toBe('false');

    measureAs(scroller(), { scrollHeight: 600, clientHeight: 200 });
    act(() => {
      screen.getByRole('button', { name: 'add' }).click();
    });

    expect(scroller().dataset.below).toBe('true');
  });
});
