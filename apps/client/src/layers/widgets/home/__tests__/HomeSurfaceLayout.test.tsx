/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router';
import { z } from 'zod';
import { zodValidator } from '@tanstack/zod-adapter';
import { HomeSurfaceLayout } from '../ui/HomeSurfaceLayout';

// The pages are stand-ins: this file is about the tab bar and the layout seam,
// not about what Activity or Workspaces render. The real wiring — that these
// four routes hang off the layout in the shipped router — is pinned by
// `src/__tests__/home-surface-routes.test.ts`.
function page(name: string) {
  return function MockPage() {
    return <div data-testid={`${name}-page`}>{name}</div>;
  };
}

const activitySearchSchema = z.object({ categories: z.string().optional() });

function renderAt(initialUrl: string) {
  const rootRoute = createRootRoute({ component: () => <Outlet /> });
  const homeSurfaceRoute = createRoute({
    getParentRoute: () => rootRoute,
    id: '_home',
    component: HomeSurfaceLayout,
  });
  const indexRoute = createRoute({
    getParentRoute: () => homeSurfaceRoute,
    path: '/',
    component: page('home'),
  });
  const activityRoute = createRoute({
    getParentRoute: () => homeSurfaceRoute,
    path: '/activity',
    validateSearch: zodValidator(activitySearchSchema),
    component: page('activity'),
  });
  const tasksRoute = createRoute({
    getParentRoute: () => homeSurfaceRoute,
    path: '/tasks',
    component: page('tasks'),
  });
  const workspacesRoute = createRoute({
    getParentRoute: () => homeSurfaceRoute,
    path: '/workspaces',
    component: page('workspaces'),
  });

  const router = createRouter({
    routeTree: rootRoute.addChildren([
      homeSurfaceRoute.addChildren([indexRoute, activityRoute, tasksRoute, workspacesRoute]),
    ]),
    history: createMemoryHistory({ initialEntries: [initialUrl] }),
  });

  // The test tree is not the app's registered router; the cast is only so the
  // provider's generic accepts it.
  render(<RouterProvider router={router as never} />);
  return router;
}

/**
 * The label of every tab this component is drawing as active.
 *
 * Deliberately NOT `aria-current`: `Link` sets that itself from its own route
 * matching, and its value wins over anything the component passes. Asserting on
 * it tests TanStack, not `resolveHomeTabId` — a resolver that returned `null`
 * for everything once passed all of these. `data-active` is the attribute this
 * component derives from the resolver, so it is the one that can fail.
 */
function activeTabLabels(): string[] {
  return screen
    .getAllByRole('link')
    .filter((link) => link.hasAttribute('data-active'))
    .map((link) => link.textContent ?? '');
}

/** How many tabs are drawing the sliding underline. */
function indicatorCount(): number {
  return document.querySelectorAll('[data-slot="home-tab-indicator"]').length;
}

describe('HomeSurfaceLayout', () => {
  it('renders the four tabs in order', async () => {
    renderAt('/');

    await screen.findByTestId('home-page');
    expect(screen.getAllByRole('link').map((link) => link.textContent)).toEqual([
      'Home',
      'Activity',
      'Scheduled',
      'Workspaces',
    ]);
  });

  it('labels the /tasks tab "Scheduled" and links it to /tasks', async () => {
    renderAt('/');

    await screen.findByTestId('home-page');
    expect(screen.getByRole('link', { name: 'Scheduled' })).toHaveAttribute('href', '/tasks');
  });

  it.each([
    ['/', 'Home', 'home'],
    ['/activity', 'Activity', 'activity'],
    ['/tasks', 'Scheduled', 'tasks'],
    ['/workspaces', 'Workspaces', 'workspaces'],
    // The router serves these spellings too — it tolerates a trailing slash and
    // matches case-insensitively — and reports the pathname back exactly as
    // typed. A hand-edited or copied link must still light its tab.
    ['/activity/', 'Activity', 'activity'],
    ['/tasks//', 'Scheduled', 'tasks'],
    ['/Activity', 'Activity', 'activity'],
  ])('draws exactly one tab active at %s', async (url, label, testId) => {
    renderAt(url);

    await screen.findByTestId(`${testId}-page`);
    expect(activeTabLabels()).toEqual([label]);
    expect(indicatorCount()).toBe(1);
  });

  it('keeps a deep link’s search params and still lands on the right tab', async () => {
    const router = renderAt('/activity?categories=session');

    await screen.findByTestId('activity-page');
    expect(activeTabLabels()).toEqual(['Activity']);
    expect(indicatorCount()).toBe(1);
    expect(router.state.location.search).toEqual(
      expect.objectContaining({ categories: 'session' })
    );
  });

  it('navigates to /tasks when the Scheduled tab is clicked', async () => {
    const user = userEvent.setup();
    const router = renderAt('/');
    await screen.findByTestId('home-page');

    await user.click(screen.getByRole('link', { name: 'Scheduled' }));

    await waitFor(() => expect(router.state.location.pathname).toBe('/tasks'));
    expect(await screen.findByTestId('tasks-page')).toBeInTheDocument();
    expect(activeTabLabels()).toEqual(['Scheduled']);
  });
});

/**
 * The bar holds more than a phone shows, and has to say so (DOR-1180).
 *
 * At 390×844 the four labels want 430px, so a cold load drew
 * `Home | Activity | Scheduled | Workspac` with nothing to suggest the word was
 * cut rather than misspelled — macOS draws no scrollbar until you have already
 * scrolled. jsdom lays nothing out, so every number below is stubbed: what these
 * pin is what the component DOES with a measurement. The pixels are
 * `home-shell.spec.ts`'s.
 */
describe('HomeTabBar — a strip that says when it holds more', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  /** The strip, which is its own scroll container. */
  function strip(): HTMLElement {
    return screen.getByTestId('home-tabs');
  }

  /** Pretend the labels are `content` wide inside a `box`-wide strip, scrolled to `left`. */
  function layout(el: HTMLElement, { content, box, left }: Record<string, number>) {
    Object.defineProperty(el, 'scrollWidth', { value: content, configurable: true });
    Object.defineProperty(el, 'clientWidth', { value: box, configurable: true });
    el.scrollLeft = left!;
  }

  const fade = (side: 'start' | 'end') => screen.queryByTestId(`home-tabs-fade-${side}`);

  it('fades only the edge that still has tabs behind it', async () => {
    renderAt('/');
    await screen.findByTestId('home-page');
    const el = strip();

    // A cold load at 390: everything is to the right, nothing to the left.
    layout(el, { content: 430, box: 390, left: 0 });
    fireEvent.scroll(el);
    expect(fade('start')).toBeNull();
    expect(fade('end')).toBeInTheDocument();

    // Mid-scroll: labels behind both edges.
    layout(el, { content: 430, box: 390, left: 20 });
    fireEvent.scroll(el);
    expect(fade('start')).toBeInTheDocument();
    expect(fade('end')).toBeInTheDocument();

    // At the end: nothing further right, and the cue says so rather than
    // hanging over an edge with nothing behind it.
    layout(el, { content: 430, box: 390, left: 40 });
    fireEvent.scroll(el);
    expect(fade('start')).toBeInTheDocument();
    expect(fade('end')).toBeNull();
  });

  it('advertises nothing at a width where all four fit', async () => {
    // ADR 260725-004456: a cue pointing at nothing is worse than no cue. This is
    // every desktop, which is why the bar must cost nothing there.
    renderAt('/');
    await screen.findByTestId('home-page');

    layout(strip(), { content: 430, box: 900, left: 0 });
    fireEvent.scroll(strip());
    expect(fade('start')).toBeNull();
    expect(fade('end')).toBeNull();
  });

  it('keeps the cue out of the way of the tab underneath it', async () => {
    renderAt('/');
    await screen.findByTestId('home-page');
    layout(strip(), { content: 430, box: 390, left: 20 });
    fireEvent.scroll(strip());

    for (const side of ['start', 'end'] as const) {
      const cue = fade(side);
      // A 44px touch target under a decoration that ate taps would cost more
      // than the decoration is worth, and a screen reader has no use for it.
      expect(cue?.className).toContain('pointer-events-none');
      expect(cue).toHaveAttribute('aria-hidden');
    }
  });

  it('scrolls the active tab into view on a deep link to the last one', async () => {
    // The failure this prevents: `/workspaces` opened from a bookmark lands on
    // the one tab that starts off-screen, so the bar answers "which part of Home
    // am I in?" with nothing at all. A click reveals its own tab for free — the
    // browser scrolls what it focuses — so only the paths that do not click show
    // it.
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
    // The numbers Chromium measured at 390×844: a 390px strip holding 430px of
    // labels, with Workspaces running from 294 to 422.
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: Element
    ) {
      if (this.getAttribute('data-slot') === 'home-tab-bar') return rect(0, 390);
      if (this.hasAttribute('data-active')) return rect(294, 422);
      return rect(0, 0);
    });

    renderAt('/workspaces');
    await screen.findByTestId('workspaces-page');

    // The least scroll that clears the edge, plus the reveal margin.
    expect(strip().scrollLeft).toBe(422 - 390 + 8);
  });

  it('leaves the scroll position alone when the active tab already fits', async () => {
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
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: Element
    ) {
      if (this.getAttribute('data-slot') === 'home-tab-bar') return rect(0, 390);
      if (this.hasAttribute('data-active')) return rect(8, 81);
      return rect(0, 0);
    });

    renderAt('/');
    await screen.findByTestId('home-page');

    expect(strip().scrollLeft).toBe(0);
  });
});
