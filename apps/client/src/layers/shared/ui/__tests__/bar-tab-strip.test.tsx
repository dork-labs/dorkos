// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router';
import { BarTabStrip, type BarTab } from '../bar-tab-strip';

const TABS: BarTab[] = [
  { id: 'home', label: 'Home', to: '/' },
  { id: 'activity', label: 'Activity', to: '/activity' },
  { id: 'scheduled', label: 'Scheduled', to: '/tasks' },
  { id: 'workspaces', label: 'Workspaces', to: '/workspaces' },
];

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/** Mount the strip inside a router that actually serves the four paths. */
function renderStrip(at: string, activeTabId: string | null) {
  const rootRoute = createRootRoute({
    staticData: { header: null },
    component: () => (
      <>
        <BarTabStrip
          tabs={TABS}
          activeTabId={activeTabId}
          label="Home sections"
          indicatorLayoutId="test-indicator"
          testId="strip"
        />
        <Outlet />
      </>
    ),
  });
  const leaves = ['/', '/activity', '/tasks', '/workspaces'].map((path) =>
    createRoute({
      staticData: { header: null },
      getParentRoute: () => rootRoute,
      path,
      component: () => <div data-testid="page">{path}</div>,
    })
  );
  const router = createRouter({
    routeTree: rootRoute.addChildren(leaves),
    history: createMemoryHistory({ initialEntries: [at] }),
  });
  return render(<RouterProvider router={router} />);
}

const strip = () => screen.getByTestId('strip');
const fade = (side: 'start' | 'end') => screen.queryByTestId(`strip-fade-${side}`);

/** Pretend the labels are `content` wide inside a `box`-wide strip, scrolled to `left`. */
function layout(el: HTMLElement, content: number, box: number, left: number) {
  Object.defineProperty(el, 'scrollWidth', { value: content, configurable: true });
  Object.defineProperty(el, 'clientWidth', { value: box, configurable: true });
  el.scrollLeft = left;
}

describe('BarTabStrip — links, not tabs', () => {
  it('renders every tab as a link to its route', async () => {
    renderStrip('/', 'home');
    await screen.findByTestId('page');

    for (const tab of TABS) {
      expect(screen.getByRole('link', { name: tab.label })).toHaveAttribute('href', tab.to);
    }
  });

  it('marks the route you are on with aria-current, from Link itself', async () => {
    renderStrip('/activity', 'activity');
    await screen.findByTestId('page');

    expect(screen.getByRole('link', { name: 'Activity' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'Home' })).not.toHaveAttribute('aria-current');
  });

  it('draws its own active state from the id it was given, not from the URL', async () => {
    // `aria-current` is Link's and its value wins over anything passed in, so a
    // broken resolver could hide behind it. `data-active` is this component's,
    // which is why the visible state is asserted separately.
    renderStrip('/activity', 'activity');
    await screen.findByTestId('page');

    expect(screen.getByRole('link', { name: 'Activity' })).toHaveAttribute('data-active');
    expect(screen.getByRole('link', { name: 'Home' })).not.toHaveAttribute('data-active');
  });

  it('names the strip so a screen reader can announce the region', async () => {
    renderStrip('/', 'home');
    await screen.findByTestId('page');
    expect(screen.getByRole('navigation', { name: 'Home sections' })).toBe(strip());
  });
});

describe('BarTabStrip — group divider', () => {
  /** `/team`'s shape: three ways to read the roster, then two rules surfaces. */
  const GROUPED: BarTab[] = [
    { id: 'cards', label: 'Cards', to: '/' },
    { id: 'topology', label: 'Topology', to: '/activity' },
    { id: 'denied', label: 'Denied', to: '/tasks', dividerBefore: true },
    { id: 'access', label: 'Access', to: '/workspaces' },
  ];

  function renderGrouped() {
    const rootRoute = createRootRoute({
      staticData: { header: null },
      component: () => (
        <>
          <BarTabStrip
            tabs={GROUPED}
            activeTabId="cards"
            label="Team views"
            indicatorLayoutId="test-grouped"
            testId="strip"
          />
          <Outlet />
        </>
      ),
    });
    const leaves = ['/', '/activity', '/tasks', '/workspaces'].map((path) =>
      createRoute({
        staticData: { header: null },
        getParentRoute: () => rootRoute,
        path,
        component: () => <div data-testid="page">{path}</div>,
      })
    );
    return render(
      <RouterProvider
        router={createRouter({
          routeTree: rootRoute.addChildren(leaves),
          history: createMemoryHistory({ initialEntries: ['/'] }),
        })}
      />
    );
  }

  it('draws a rule immediately before the tab that asks for one', async () => {
    renderGrouped();
    await screen.findByTestId('page');

    // Asserting POSITION, not merely presence: a divider rendered at the end of
    // the strip, or before the wrong tab, would still satisfy a "there is a
    // divider" check while saying the wrong thing about which views group.
    const children = [...strip().children];
    const labels = children.map((el) =>
      el.getAttribute('data-slot') === 'bar-tab-strip-divider' ? '│' : el.textContent
    );
    expect(labels).toEqual(['Cards', 'Topology', '│', 'Denied', 'Access']);
  });

  it('draws no rule when no tab asks for one', async () => {
    renderStrip('/', 'home');
    await screen.findByTestId('page');
    expect(strip().querySelector('[data-slot="bar-tab-strip-divider"]')).toBeNull();
  });

  it('keeps the rule out of the accessibility tree — it is not a place to go', async () => {
    renderGrouped();
    await screen.findByTestId('page');

    const divider = strip().querySelector('[data-slot="bar-tab-strip-divider"]');
    expect(divider).not.toBeNull();
    expect(divider).toHaveAttribute('aria-hidden');
    // Four labels, four links: the rule adds no fifth destination.
    expect(screen.getAllByRole('link')).toHaveLength(4);
  });
});

describe('BarTabStrip — overflow at a narrow width', () => {
  it('fades only the edge that still has tabs behind it', async () => {
    // jsdom lays nothing out, so every number here is stubbed: what this pins is
    // what the component DOES with a measurement. The pixels are Chromium's at
    // 390×844, where four labels want 430px and have 390.
    renderStrip('/', 'home');
    await screen.findByTestId('page');
    const el = strip();

    layout(el, 430, 390, 0);
    fireEvent.scroll(el);
    expect(fade('start')).toBeNull();
    expect(fade('end')).toBeInTheDocument();

    layout(el, 430, 390, 20);
    fireEvent.scroll(el);
    expect(fade('start')).toBeInTheDocument();
    expect(fade('end')).toBeInTheDocument();

    layout(el, 430, 390, 40);
    fireEvent.scroll(el);
    expect(fade('start')).toBeInTheDocument();
    expect(fade('end')).toBeNull();
  });

  it('advertises nothing at a width where everything fits', async () => {
    // ADR 260725-004456: a cue pointing at nothing is worse than no cue. This is
    // every desktop, which is why the strip must cost nothing there.
    renderStrip('/', 'home');
    await screen.findByTestId('page');

    layout(strip(), 430, 900, 0);
    fireEvent.scroll(strip());
    expect(fade('start')).toBeNull();
    expect(fade('end')).toBeNull();
  });

  it('keeps the cue out of the way of the tab underneath it', async () => {
    renderStrip('/', 'home');
    await screen.findByTestId('page');
    layout(strip(), 430, 390, 20);
    fireEvent.scroll(strip());

    for (const side of ['start', 'end'] as const) {
      const cue = fade(side);
      expect(cue?.className).toContain('pointer-events-none');
      expect(cue).toHaveAttribute('aria-hidden');
    }
  });
});

describe('BarTabStrip — the active tab is brought into view', () => {
  const rect = (left: number, right: number) =>
    ({
      left,
      right,
      width: right - left,
      x: left,
      y: 0,
      top: 0,
      bottom: 0,
      height: 0,
    }) as DOMRect;

  function stubLayout(activeLeft: number, activeRight: number) {
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: Element
    ) {
      if (this.getAttribute('data-slot') === 'bar-tab-strip') return rect(0, 390);
      if (this.hasAttribute('data-active')) return rect(activeLeft, activeRight);
      return rect(0, 0);
    });
  }

  it('scrolls to the last tab when a deep link lands on it', async () => {
    // The failure this prevents: `/workspaces` opened from a bookmark lands on
    // the one tab that starts off-screen, so the strip answers "where am I?"
    // with nothing. A click reveals its own tab for free (the browser scrolls
    // what it focuses), so only the paths that do not click show this.
    stubLayout(294, 422);
    renderStrip('/workspaces', 'workspaces');
    await screen.findByTestId('page');

    // The least scroll that clears the edge, plus the reveal margin.
    expect(strip().scrollLeft).toBe(422 - 390 + 8);
  });

  it('leaves the scroll position alone when the active tab already fits', async () => {
    stubLayout(8, 81);
    renderStrip('/', 'home');
    await screen.findByTestId('page');

    expect(strip().scrollLeft).toBe(0);
  });
});
