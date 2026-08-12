/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { TooltipProvider } from '@/layers/shared/ui';
import type { RightPanelContribution } from '@/layers/shared/model';

// Mutable mock state — mutate per-test
const mockSetRightPanelOpen = vi.fn();
const mockSetActiveRightPanelTab = vi.fn();
let mockActiveRightPanelTab: string | null = null;

// The header reads only the active tab and the open/close setters from the
// store now — the container owns contribution filtering and passes the visible
// list in as a prop.
// Only the store is stubbed. `useScrollOverflow` and `revealInScroller` come
// from the real module on purpose: the fade and reveal assertions below stub
// layout metrics and then check what the strip did with them, so replacing the
// thing that reads those metrics would leave nothing under test.
vi.mock('@/layers/shared/model', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/layers/shared/model')>();
  return {
    ...actual,
    useAppStore: (selector: (s: Record<string, unknown>) => unknown) =>
      selector({
        setRightPanelOpen: mockSetRightPanelOpen,
        activeRightPanelTab: mockActiveRightPanelTab,
        setActiveRightPanelTab: mockSetActiveRightPanelTab,
      }),
  };
});

beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });

  // Radix UI Tooltip uses ResizeObserver internally — stub it for jsdom
  global.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

// Import after mocks are set up
import { RightPanelHeader } from '../ui/RightPanelHeader';

const MockIcon = () => null;

function makeContribution(
  id: string,
  overrides: Partial<RightPanelContribution> = {}
): RightPanelContribution {
  return {
    id,
    title: `Tab ${id}`,
    icon: MockIcon as unknown as RightPanelContribution['icon'],
    component: () => <div>Content {id}</div>,
    ...overrides,
  };
}

function renderHeader(contributions: RightPanelContribution[], actions?: React.ReactNode) {
  return render(
    <TooltipProvider>
      <RightPanelHeader contributions={contributions} actions={actions} />
    </TooltipProvider>
  );
}

describe('RightPanelHeader', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  beforeEach(() => {
    mockActiveRightPanelTab = 'agent';
  });

  it('renders one tab per contribution when there are 2+', () => {
    renderHeader([
      makeContribution('agent', { title: 'Agent Profile' }),
      makeContribution('canvas', { title: 'Canvas' }),
    ]);

    expect(screen.getByRole('tablist', { name: 'Right panel tabs' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Agent Profile' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Canvas' })).toBeInTheDocument();
  });

  it('renders the fallback icon for an iconless contribution among 2+ visible tabs', () => {
    // Extension-contributed tabs register no icon. Before the ?? Puzzle fallback
    // this rendered a bare `undefined` component and crashed the whole panel the
    // moment such a tab joined a second visible contribution.
    renderHeader([
      makeContribution('agent', { title: 'Agent Profile' }),
      makeContribution('ext', { title: 'My Extension', icon: undefined }),
    ]);

    // Both tabs render — the iconless one falls back to the puzzle-piece instead
    // of throwing.
    expect(screen.getByRole('tab', { name: 'Agent Profile' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'My Extension' })).toBeInTheDocument();
  });

  it('falls back to the puzzle icon for a truthy non-component icon (untyped JS extension)', () => {
    // The header renders outside PanelErrorBoundary, so a garbage `icon` value
    // from an untyped JS extension (e.g. `icon: 'foo'`) must not reach React as a
    // component. `?? Puzzle` (nullish-only) would let a truthy string through and
    // crash the panel; `isRenderableIcon` rejects it — a string is neither a
    // function nor a React element type.
    renderHeader([
      makeContribution('agent', { title: 'Agent Profile' }),
      makeContribution('ext', {
        title: 'My Extension',
        icon: 'not-a-component' as unknown as RightPanelContribution['icon'],
      }),
    ]);

    expect(screen.getByRole('tab', { name: 'Agent Profile' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'My Extension' })).toBeInTheDocument();
  });

  it('renders a forwardRef icon rather than replacing it with the fallback', async () => {
    // Every `lucide-react` icon is a `forwardRef` result — an OBJECT, not a
    // function. A function-only guard rejected all of them, so all six built-in
    // tabs rendered the same puzzle-piece and became indistinguishable.
    const { forwardRef } = await import('react');
    const RefIcon = forwardRef<SVGSVGElement, { className?: string }>((props, ref) => (
      <svg {...props} ref={ref} data-testid="real-icon" />
    ));
    renderHeader([
      makeContribution('agent', {
        title: 'Agent Profile',
        icon: RefIcon as unknown as RightPanelContribution['icon'],
      }),
      makeContribution('files', { title: 'Files' }),
    ]);

    expect(screen.getByTestId('real-icon')).toBeInTheDocument();
  });

  it('renders no tab strip with a single contribution', () => {
    renderHeader([makeContribution('agent', { title: 'Agent Profile' })]);

    expect(screen.queryByRole('tablist')).not.toBeInTheDocument();
  });

  it('names the single panel (icon + title) instead of a blank bar', () => {
    // With one visible contribution the header shows a quiet title, not a tab
    // strip — the single-tab panel is no longer an anonymous close-only bar (F6).
    const NamedIcon = () => <svg data-testid="single-icon" />;
    renderHeader([
      makeContribution('pulse', {
        title: 'Pulse',
        icon: NamedIcon as unknown as RightPanelContribution['icon'],
      }),
    ]);

    expect(screen.getByText('Pulse')).toBeInTheDocument();
    expect(screen.getByTestId('single-icon')).toBeInTheDocument();
    // Still no tablist — a title is not a tab.
    expect(screen.queryByRole('tablist')).not.toBeInTheDocument();
    expect(screen.queryByRole('tab')).not.toBeInTheDocument();
  });

  it('falls back to the puzzle icon for a single iconless contribution', () => {
    renderHeader([makeContribution('ext', { title: 'My Extension', icon: undefined })]);

    // Title still renders; the guard prevents an undefined/garbage icon from
    // crashing the header (which lives outside PanelErrorBoundary).
    expect(screen.getByText('My Extension')).toBeInTheDocument();
    expect(screen.queryByRole('tablist')).not.toBeInTheDocument();
  });

  it('renders the active tab actions beside the close button', () => {
    renderHeader(
      [makeContribution('agent'), makeContribution('files')],
      <button type="button">New File</button>
    );

    expect(screen.getByRole('button', { name: 'New File' })).toBeInTheDocument();
  });

  it('always renders the close button', () => {
    renderHeader([makeContribution('agent', { title: 'Agent Profile' })]);

    expect(screen.getByRole('button', { name: 'Close panel' })).toBeInTheDocument();
  });
});

describe('RightPanelHeader — a tab strip that scrolls instead of clipping', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  /** The scroll container the tablist sits inside. */
  function scroller(): HTMLElement {
    return screen.getByRole('tablist').parentElement!;
  }

  /** Pretend the strip is `content` wide inside a `box`-wide viewport, scrolled to `left`. */
  function layout(el: HTMLElement, { content, box, left }: Record<string, number>) {
    Object.defineProperty(el, 'scrollWidth', { value: content, configurable: true });
    Object.defineProperty(el, 'clientWidth', { value: box, configurable: true });
    el.scrollLeft = left!;
  }

  it('scrolls the overflow rather than clipping it, and keeps every label whole', () => {
    // Six tabs are wider than a 375px overlay panel; a tab pushed past the edge
    // with no way to reach it is a lost surface (Terminal already was one).
    renderHeader(
      ['agent', 'files', 'canvas', 'terminal', 'session', 'pulse'].map((id) => makeContribution(id))
    );

    expect(scroller().className).toContain('overflow-x-auto');
    // Explicit, not incidental: with `overflow-x: auto` and a `visible` cross
    // axis, CSS promotes the used `overflow-y` to `auto` and the active tab's
    // shadow plus its focus ring clip against the scroll box.
    expect(scroller().className).toContain('overflow-y-hidden');
    expect(scroller().className).toMatch(/py-1/);
    for (const tab of screen.getAllByRole('tab')) {
      expect(tab.className).toContain('shrink-0');
      expect(tab.className).toContain('whitespace-nowrap');
    }
  });

  it('fades only the edge that has tabs behind it', () => {
    renderHeader(
      ['agent', 'files', 'canvas', 'terminal', 'session', 'pulse'].map((id) => makeContribution(id))
    );
    const el = scroller();

    // Scrolled to the start: something is hidden to the right, nothing to the left.
    layout(el, { content: 600, box: 340, left: 0 });
    fireEvent.scroll(el);
    expect(screen.queryByTestId('right-panel-tabs-fade-start')).toBeNull();
    expect(screen.getByTestId('right-panel-tabs-fade-end')).toBeInTheDocument();

    // Mid-scroll: tabs behind both edges.
    layout(el, { content: 600, box: 340, left: 100 });
    fireEvent.scroll(el);
    expect(screen.getByTestId('right-panel-tabs-fade-start')).toBeInTheDocument();
    expect(screen.getByTestId('right-panel-tabs-fade-end')).toBeInTheDocument();

    // Scrolled to the end: nothing further right.
    layout(el, { content: 600, box: 340, left: 260 });
    fireEvent.scroll(el);
    expect(screen.getByTestId('right-panel-tabs-fade-start')).toBeInTheDocument();
    expect(screen.queryByTestId('right-panel-tabs-fade-end')).toBeNull();
  });

  it('advertises nothing when every tab already fits', () => {
    // ADR 260725-004456: an affordance pointing at something unreachable — or at
    // nothing at all — is worse than no affordance.
    renderHeader([makeContribution('agent'), makeContribution('files')]);
    const el = scroller();

    layout(el, { content: 300, box: 300, left: 0 });
    fireEvent.scroll(el);
    expect(screen.queryByTestId('right-panel-tabs-fade-start')).toBeNull();
    expect(screen.queryByTestId('right-panel-tabs-fade-end')).toBeNull();
  });

  it('draws the fades over the tabs without swallowing their clicks', () => {
    renderHeader(
      ['agent', 'files', 'canvas', 'terminal', 'session', 'pulse'].map((id) => makeContribution(id))
    );
    const el = scroller();
    layout(el, { content: 600, box: 340, left: 100 });
    fireEvent.scroll(el);

    for (const side of ['start', 'end']) {
      const fade = screen.getByTestId(`right-panel-tabs-fade-${side}`);
      expect(fade.className).toContain('pointer-events-none');
      expect(fade).toHaveAttribute('aria-hidden');
    }
  });
});

describe('RightPanelHeader — the selected tab is never left behind an edge', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    mockActiveRightPanelTab = null;
  });

  /** The scroll container the tablist sits inside. */
  function scroller(): HTMLElement {
    return screen.getByRole('tablist').parentElement!;
  }

  /** A rect with only the horizontal edges the reveal reads. */
  function rect(left: number, right: number): DOMRect {
    return {
      left,
      right,
      width: right - left,
      x: left,
      y: 0,
      top: 0,
      bottom: 0,
      height: 0,
    } as DOMRect;
  }

  /**
   * Put the selected tab `right - box.right` past the strip's end.
   *
   * jsdom has no layout, so the two boxes the reveal compares are stubbed: the
   * scroll box (the only element that contains a tablist) and whichever tab is
   * selected.
   */
  function layOutSelectedTabPastTheEnd() {
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: Element
    ) {
      if (this.getAttribute('role') === 'tab' && this.getAttribute('aria-selected') === 'true') {
        return rect(500, 580);
      }
      if (this.querySelector('[role="tablist"]')) return rect(0, 340);
      return rect(0, 0);
    });
  }

  it('scrolls a tab activated without a click into view', () => {
    // A click reveals the tab for free — the browser scrolls what it focuses — so
    // the bug only ever showed on the paths that do not click: a server
    // `ui_command` opening the canvas, a restored per-agent layout, or the panel
    // being dragged narrower. The active tab stayed cut off at the edge (DOR-471).
    mockActiveRightPanelTab = 'terminal';
    layOutSelectedTabPastTheEnd();
    renderHeader(
      ['agent', 'files', 'canvas', 'terminal', 'session', 'pulse'].map((id) => makeContribution(id))
    );

    // The least scroll that clears the edge, plus the reveal margin.
    expect(scroller().scrollLeft).toBe(580 - 340 + 8);
  });

  it('leaves the scroll position alone when the selected tab already fits', () => {
    mockActiveRightPanelTab = 'agent';
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: Element
    ) {
      if (this.getAttribute('role') === 'tab' && this.getAttribute('aria-selected') === 'true') {
        return rect(10, 90);
      }
      if (this.querySelector('[role="tablist"]')) return rect(0, 340);
      return rect(0, 0);
    });
    renderHeader([makeContribution('agent'), makeContribution('files')]);

    expect(scroller().scrollLeft).toBe(0);
  });

  it('watches the tablist as well as the scroll box', () => {
    // `clientWidth` comes from the scroll box, but `scrollWidth` is the tablist —
    // and the tablist can change size on its own (a late web font, a contribution
    // renaming its tab) while the box does not, which would leave the fades
    // reporting a strip that no longer exists.
    const observed: Element[] = [];
    const original = global.ResizeObserver;
    global.ResizeObserver = class {
      observe(el: Element) {
        observed.push(el);
      }
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;

    try {
      renderHeader([makeContribution('agent'), makeContribution('files')]);
      expect(observed).toContain(screen.getByRole('tablist'));
      expect(observed).toContain(scroller());
    } finally {
      global.ResizeObserver = original;
    }
  });
});
