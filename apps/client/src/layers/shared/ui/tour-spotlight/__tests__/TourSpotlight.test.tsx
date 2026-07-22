import { act, cleanup, fireEvent, render, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TOUR_ANCHORS, type TourStep } from '@/layers/shared/config';

import { TourSpotlight } from '../TourSpotlight';

const CAPTION = 'This is where you talk to me.';

/** Install a matchMedia mock so useIsMobile / usePrefersReducedMotion resolve. */
function mockMatchMedia({
  mobile = false,
  reduced = false,
}: {
  mobile?: boolean;
  reduced?: boolean;
}) {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: query.includes('prefers-reduced-motion')
      ? reduced
      : query.includes('max-width')
        ? mobile
        : false,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
}

/** Mount a #root with an anchor element inside, so inert targets a real node. */
function mountRootWithAnchor(testid: string): HTMLElement {
  const root = document.createElement('div');
  root.id = 'root';
  const anchor = document.createElement('button');
  anchor.setAttribute('data-testid', testid);
  anchor.textContent = 'real target';
  root.appendChild(anchor);
  document.body.appendChild(root);
  return anchor;
}

/** The caption renders in both the popover bubble and the aria-live region. */
function popover(): HTMLElement {
  const el = document.querySelector<HTMLElement>('.reactour__popover');
  if (!el) throw new Error('popover not rendered');
  return el;
}

/** Wait for the spotlight overlay (popover + caption) to appear. */
async function waitForSpotlight() {
  await waitFor(() => expect(document.querySelector('.reactour__popover')).not.toBeNull());
  await waitFor(() => expect(within(popover()).getByText(CAPTION)).toBeInTheDocument());
}

const GENERAL_STEP: TourStep = {
  anchor: TOUR_ANCHORS.dashboardComposer,
  caption: CAPTION,
  chipLabel: 'Next',
};

beforeEach(() => {
  mockMatchMedia({});
  // jsdom does not implement scrollIntoView; the resolver calls it on resolve.
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
  vi.useRealTimers();
});

describe('TourSpotlight — S1 anchor resolution', () => {
  it('spotlights a present anchor: renders our caption over the real element', async () => {
    mountRootWithAnchor(TOUR_ANCHORS.dashboardComposer);
    render(
      <TourSpotlight steps={[GENERAL_STEP]} activeIndex={0} onAdvance={vi.fn()} onEnd={vi.fn()} />
    );
    await waitForSpotlight();
    expect(within(popover()).getByText(CAPTION)).toBeInTheDocument();
  });

  it('skips the step on timeout when the anchor never mounts', async () => {
    vi.useFakeTimers();
    mountRootWithAnchor('some-other-id');
    const onAdvance = vi.fn();
    render(
      <TourSpotlight
        steps={[GENERAL_STEP, GENERAL_STEP]}
        activeIndex={0}
        onAdvance={onAdvance}
        onEnd={vi.fn()}
      />
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(4200);
    });

    // First step is not last → a skip advances rather than ends.
    expect(onAdvance).toHaveBeenCalledTimes(1);
    expect(document.querySelector('.reactour__popover')).toBeNull();
  });

  it('resolves an anchor that mounts late', async () => {
    render(
      <TourSpotlight steps={[GENERAL_STEP]} activeIndex={0} onAdvance={vi.fn()} onEnd={vi.fn()} />
    );
    expect(document.querySelector('.reactour__popover')).toBeNull();

    act(() => {
      mountRootWithAnchor(TOUR_ANCHORS.dashboardComposer);
    });

    await waitForSpotlight();
  });

  it('keeps the caption up when a found anchor is removed and re-stamped (sticky, no end/advance)', async () => {
    const anchor = mountRootWithAnchor(TOUR_ANCHORS.dashboardComposer);
    const root = anchor.parentElement as HTMLElement;
    const onAdvance = vi.fn();
    const onEnd = vi.fn();
    render(
      <TourSpotlight steps={[GENERAL_STEP]} activeIndex={0} onAdvance={onAdvance} onEnd={onEnd} />
    );
    await waitForSpotlight();

    // A query-driven section re-render unmounts the found node. A reached step is
    // sticky: the caption stays up (it is NOT torn down), so it can never blink
    // out — the production "caption never renders" signature.
    act(() => anchor.remove());
    expect(within(popover()).getByText(CAPTION)).toBeInTheDocument();

    // The same data-testid is re-stamped on a fresh node; the spotlight swaps in.
    act(() => {
      const fresh = document.createElement('button');
      fresh.setAttribute('data-testid', TOUR_ANCHORS.dashboardComposer);
      fresh.textContent = 'real target';
      root.appendChild(fresh);
    });
    await waitForSpotlight();

    expect(onEnd).not.toHaveBeenCalled();
    expect(onAdvance).not.toHaveBeenCalled();
  });

  it('never self-advances a reached step whose anchor is permanently lost (no cascade)', async () => {
    vi.useFakeTimers();
    const anchor = mountRootWithAnchor(TOUR_ANCHORS.dashboardComposer);
    const onAdvance = vi.fn();
    const onEnd = vi.fn();
    // Two steps, so a self-advancing bug would visibly walk the tour.
    render(
      <TourSpotlight
        steps={[GENERAL_STEP, GENERAL_STEP]}
        activeIndex={0}
        onAdvance={onAdvance}
        onEnd={onEnd}
      />
    );
    // Resolve the first step (found).
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(document.querySelector('.reactour__popover')).not.toBeNull();

    // The anchor is permanently removed and never re-stamped.
    act(() => anchor.remove());
    // Advance far past the timeout budget and a full 3-step cascade window.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15000);
    });

    // A step that was genuinely reached never times out, so it never
    // auto-advances or self-ends (the 8-12s cascade is gone).
    expect(onAdvance).not.toHaveBeenCalled();
    expect(onEnd).not.toHaveBeenCalled();
  });
});

describe('TourSpotlight — S2 fully custom popover', () => {
  it('renders our caption and none of the library chrome', async () => {
    mountRootWithAnchor(TOUR_ANCHORS.dashboardComposer);
    render(
      <TourSpotlight steps={[GENERAL_STEP]} activeIndex={0} onAdvance={vi.fn()} onEnd={vi.fn()} />
    );
    await waitForSpotlight();

    // Our advance chip is present; reactour's default dot navigation is not.
    expect(within(popover()).getByRole('button', { name: 'Next' })).toBeInTheDocument();
    expect(document.querySelector('.reactour__dot')).toBeNull();
  });
});

describe('TourSpotlight — S3 mobile bottom sheet', () => {
  it('pins the caption to the bottom on a mobile viewport', async () => {
    mockMatchMedia({ mobile: true });
    mountRootWithAnchor(TOUR_ANCHORS.dashboardComposer);
    render(
      <TourSpotlight steps={[GENERAL_STEP]} activeIndex={0} onAdvance={vi.fn()} onEnd={vi.fn()} />
    );
    await waitForSpotlight();

    expect(popover().style.bottom).toBe('0px');
    expect(popover().style.transform).toBe('none');
  });
});

describe('TourSpotlight — S4 accessibility bar', () => {
  it('ends the tour on Escape', async () => {
    mountRootWithAnchor(TOUR_ANCHORS.dashboardComposer);
    const onEnd = vi.fn();
    render(
      <TourSpotlight steps={[GENERAL_STEP]} activeIndex={0} onAdvance={vi.fn()} onEnd={onEnd} />
    );
    await waitForSpotlight();

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onEnd).toHaveBeenCalledTimes(1);
  });

  it('ends the tour on click-outside (the mask)', async () => {
    mountRootWithAnchor(TOUR_ANCHORS.dashboardComposer);
    const onEnd = vi.fn();
    render(
      <TourSpotlight steps={[GENERAL_STEP]} activeIndex={0} onAdvance={vi.fn()} onEnd={onEnd} />
    );
    await waitForSpotlight();

    // The mask's click-catcher rect: reactour styles fill/clip-path inline.
    const clickArea = Array.from(document.querySelectorAll('rect')).find((r) =>
      r.style.clipPath.includes('clip')
    );
    expect(clickArea).toBeTruthy();
    fireEvent.click(clickArea as Element);
    expect(onEnd).toHaveBeenCalledTimes(1);
  });

  it('moves focus into the caption when a step opens', async () => {
    mountRootWithAnchor(TOUR_ANCHORS.dashboardComposer);
    render(
      <TourSpotlight steps={[GENERAL_STEP]} activeIndex={0} onAdvance={vi.fn()} onEnd={vi.fn()} />
    );
    await waitForSpotlight();

    await waitFor(() => expect(popover().contains(document.activeElement)).toBe(true));
  });

  it('announces the caption via an aria-live region naming the target', async () => {
    mountRootWithAnchor(TOUR_ANCHORS.dashboardComposer);
    render(
      <TourSpotlight steps={[GENERAL_STEP]} activeIndex={0} onAdvance={vi.fn()} onEnd={vi.fn()} />
    );
    await waitForSpotlight();

    const live = document.querySelector('[role="status"][aria-live="polite"]');
    expect(live).not.toBeNull();
    expect(live?.textContent).toBe(CAPTION);
  });

  it('makes the app root inert while active and restores it on end', async () => {
    mountRootWithAnchor(TOUR_ANCHORS.dashboardComposer);
    const { rerender } = render(
      <TourSpotlight steps={[GENERAL_STEP]} activeIndex={0} onAdvance={vi.fn()} onEnd={vi.fn()} />
    );
    await waitFor(() => expect(document.getElementById('root')?.inert).toBe(true));

    // Ending the tour (no steps) clears inert.
    rerender(<TourSpotlight steps={[]} activeIndex={0} onAdvance={vi.fn()} onEnd={vi.fn()} />);
    await waitFor(() => expect(document.getElementById('root')?.inert).toBe(false));
  });
});

describe('TourSpotlight — S5 reduced motion', () => {
  it('stills the cutout: applies the reduced-motion mask class', async () => {
    mockMatchMedia({ reduced: true });
    mountRootWithAnchor(TOUR_ANCHORS.dashboardComposer);
    render(
      <TourSpotlight steps={[GENERAL_STEP]} activeIndex={0} onAdvance={vi.fn()} onEnd={vi.fn()} />
    );
    await waitForSpotlight();

    expect(document.querySelector('.dork-tour-mask--reduced-motion')).not.toBeNull();
  });

  it('animates the cutout when reduced motion is off (no reduced-motion class)', async () => {
    mockMatchMedia({ reduced: false });
    mountRootWithAnchor(TOUR_ANCHORS.dashboardComposer);
    render(
      <TourSpotlight steps={[GENERAL_STEP]} activeIndex={0} onAdvance={vi.fn()} onEnd={vi.fn()} />
    );
    await waitForSpotlight();

    expect(document.querySelector('.dork-tour-mask--reduced-motion')).toBeNull();
  });

  it('applies the eased geometry transition to the cutout once it appears', async () => {
    mockMatchMedia({ reduced: false });
    mountRootWithAnchor(TOUR_ANCHORS.dashboardComposer);
    render(
      <TourSpotlight steps={[GENERAL_STEP]} activeIndex={0} onAdvance={vi.fn()} onEnd={vi.fn()} />
    );
    await waitForSpotlight();

    // The visible cutout rect carries the eased geometry transition, so a step
    // change slides it instead of popping in.
    await waitFor(() => {
      const rect = Array.from(document.querySelectorAll('rect')).find((r) =>
        r.style.transition?.includes('280ms')
      );
      expect(rect).toBeTruthy();
    });
  });
});

describe('TourSpotlight — S6 smooth movement between steps', () => {
  const SECOND_CAPTION = 'And these are your agents.';
  const TWO_STEPS: TourStep[] = [
    GENERAL_STEP,
    { anchor: TOUR_ANCHORS.yourAgents, caption: SECOND_CAPTION, chipLabel: 'Done' },
  ];

  /** Mount a #root that carries both step anchors. */
  function mountRootWithTwoAnchors() {
    const root = document.createElement('div');
    root.id = 'root';
    for (const id of [TOUR_ANCHORS.dashboardComposer, TOUR_ANCHORS.yourAgents]) {
      const el = document.createElement('button');
      el.setAttribute('data-testid', id);
      el.textContent = id;
      root.appendChild(el);
    }
    document.body.appendChild(root);
  }

  it('advances to the next step without remounting the provider (the cutout persists)', async () => {
    mountRootWithTwoAnchors();
    const { rerender } = render(
      <TourSpotlight steps={TWO_STEPS} activeIndex={0} onAdvance={vi.fn()} onEnd={vi.fn()} />
    );
    await waitForSpotlight();
    const firstPopover = popover();

    rerender(
      <TourSpotlight steps={TWO_STEPS} activeIndex={1} onAdvance={vi.fn()} onEnd={vi.fn()} />
    );
    await waitFor(() => expect(within(popover()).getByText(SECOND_CAPTION)).toBeInTheDocument());

    // Same DOM node across the advance: the provider (and its cutout rect) was not
    // torn down, so the CSS geometry transition can glide it to the new element.
    expect(popover()).toBe(firstPopover);
  });

  it('ignores a keyboard advance during the resolve gap (only advances a visible step)', async () => {
    // Only the first step's anchor is present; the second never mounts, so the
    // shown step trails at 0 while step 1 resolves.
    mountRootWithAnchor(TOUR_ANCHORS.dashboardComposer);
    const onAdvance = vi.fn();
    const onEnd = vi.fn();
    const { rerender } = render(
      <TourSpotlight steps={TWO_STEPS} activeIndex={0} onAdvance={onAdvance} onEnd={onEnd} />
    );
    await waitForSpotlight();

    // Engine advances to step 1, whose anchor is absent: a fast ArrowRight must be
    // a no-op so it can never skip a step that never painted.
    rerender(
      <TourSpotlight steps={TWO_STEPS} activeIndex={1} onAdvance={onAdvance} onEnd={onEnd} />
    );
    fireEvent.keyDown(document, { key: 'ArrowRight' });

    expect(onAdvance).not.toHaveBeenCalled();
    expect(onEnd).not.toHaveBeenCalled();
    // The first step's caption is still the one on screen.
    expect(within(popover()).getByText(CAPTION)).toBeInTheDocument();
  });
});
