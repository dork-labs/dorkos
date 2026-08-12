/**
 * Whether a scroller has more content past an edge — the question a fade cue is
 * drawn from (DOR-1043 vertically, DOR-1180 horizontally).
 *
 * jsdom lays nothing out, so every metric here is stubbed on purpose: what is
 * pinned is the RULE that turns an offset, a visible size and a total size into
 * two booleans, which is the whole of the hook. Pixels stay the browser gate's.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { useRef, useState } from 'react';
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { useScrollOverflow, type ScrollAxis } from '../scroll/use-scroll-overflow';

/** The three layout numbers jsdom always reports as zero, for one axis. */
interface Metrics {
  /** `scrollHeight` or `scrollWidth`. */
  total: number;
  /** `clientHeight` or `clientWidth`. */
  visible: number;
  /** `scrollTop` or `scrollLeft`. */
  offset?: number;
}

/** Stub them, on whichever axis the probe is running. */
function measureAs(el: HTMLElement, axis: ScrollAxis, metrics: Metrics) {
  const vertical = axis === 'vertical';
  Object.defineProperty(el, vertical ? 'scrollHeight' : 'scrollWidth', {
    value: metrics.total,
    configurable: true,
  });
  Object.defineProperty(el, vertical ? 'clientHeight' : 'clientWidth', {
    value: metrics.visible,
    configurable: true,
  });
  if (vertical) el.scrollTop = metrics.offset ?? 0;
  else el.scrollLeft = metrics.offset ?? 0;
}

/**
 * A scroller wired to the hook, reporting both edges as data attributes.
 *
 * `rows` exists so a test can change the CONTENT without touching the scroll
 * position — the case a scroll listener alone never hears about.
 */
function Probe({ axis }: { axis: ScrollAxis }) {
  const ref = useRef<HTMLDivElement>(null);
  const { onScroll, start, end } = useScrollOverflow(ref, axis);
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
        data-start={String(start)}
        data-end={String(end)}
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

  // **Every rule is asserted on both axes, from one table.** The axis is the
  // only thing the hook branches on, so a horizontal reader that silently kept
  // reading `scrollTop` would answer "nothing is hidden" for every strip in the
  // app — which is the shape of the defect the horizontal axis was added for.
  for (const axis of ['vertical', 'horizontal'] as const) {
    describe(axis, () => {
      const probe = () => render(<Probe axis={axis} />);

      it('draws no cue when everything already fits', () => {
        probe();
        measureAs(scroller(), axis, { total: 200, visible: 200 });
        fireEvent.scroll(scroller());

        expect(scroller().dataset.start).toBe('false');
        expect(scroller().dataset.end).toBe('false');
      });

      it('says there is more ahead while parked at the start', () => {
        probe();
        measureAs(scroller(), axis, { total: 600, visible: 200, offset: 0 });
        fireEvent.scroll(scroller());

        expect(scroller().dataset.end).toBe('true');
        expect(scroller().dataset.start).toBe('false');
      });

      it('says there is more both ways in the middle', () => {
        probe();
        measureAs(scroller(), axis, { total: 600, visible: 200, offset: 150 });
        fireEvent.scroll(scroller());

        expect(scroller().dataset.start).toBe('true');
        expect(scroller().dataset.end).toBe('true');
      });

      it('drops the far cue at the end of the scroll, and keeps the near one', () => {
        probe();
        measureAs(scroller(), axis, { total: 600, visible: 200, offset: 400 });
        fireEvent.scroll(scroller());

        expect(scroller().dataset.end).toBe('false');
        expect(scroller().dataset.start).toBe('true');
      });

      it('ignores a sub-pixel remainder rather than pinning a cue on forever', () => {
        // Fractional layout sizes leave a fraction of a pixel of scroll range at
        // rest, which is not content and must not advertise itself as content.
        probe();
        measureAs(scroller(), axis, { total: 200.5, visible: 200, offset: 0 });
        fireEvent.scroll(scroller());

        expect(scroller().dataset.end).toBe('false');
      });

      it('re-measures when the content changes under a still scroll position', () => {
        // An approval arriving over the event stream fires no scroll event: the
        // list simply gets longer while nobody touched it.
        probe();
        measureAs(scroller(), axis, { total: 200, visible: 200 });
        fireEvent.scroll(scroller());
        expect(scroller().dataset.end).toBe('false');

        measureAs(scroller(), axis, { total: 600, visible: 200 });
        act(() => {
          screen.getByRole('button', { name: 'add' }).click();
        });

        expect(scroller().dataset.end).toBe('true');
      });
    });
  }

  it('defaults to the vertical axis', () => {
    // The default is what every existing caller relies on, so it is stated
    // rather than inherited from whichever branch happens to run first.
    function Default() {
      const ref = useRef<HTMLDivElement>(null);
      const { onScroll, end } = useScrollOverflow(ref);
      return <div ref={ref} onScroll={onScroll} data-testid="scroller" data-end={String(end)} />;
    }
    render(<Default />);
    // Tall content, and a WIDE box: a horizontal reading of these numbers says
    // nothing is hidden.
    measureAs(scroller(), 'vertical', { total: 600, visible: 200 });
    measureAs(scroller(), 'horizontal', { total: 200, visible: 200 });
    fireEvent.scroll(scroller());

    expect(scroller().dataset.end).toBe('true');
  });
});
