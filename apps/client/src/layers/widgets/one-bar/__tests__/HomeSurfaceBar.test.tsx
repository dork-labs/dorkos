/**
 * @vitest-environment jsdom
 *
 * The bar all four home surfaces wear (spec `one-bar-header` §3.4, phase H1).
 *
 * These assertions used to live over `HomeSurfaceLayout`, back when the tabs
 * were a row of their own under the header. The row is gone and the tabs are the
 * bar's identity now, so the tests moved with them — same claims, same stubbed
 * measurements, one row up.
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

// The health dot and the search trigger are other slices' components with their
// own data needs and their own suites. This file is about what the BAR says, so
// they are stubbed at the seam — the same way every other route-bar suite does it.
vi.mock('@/layers/features/top-nav', () => ({
  SystemHealthDot: () => <span data-testid="system-health-dot" />,
  useSystemHealth: () => 'healthy',
  CommandPaletteTrigger: () => <button aria-label="Search">Search</button>,
}));

// The two per-surface extras. Both are wired to real queries and have their own
// suites; what this file is about is WHICH surface gets them and where they land.
vi.mock('../ui/HomeRoomChips', () => ({
  HomeRoomChips: () => <span data-testid="home-members-chip" />,
}));
vi.mock('../ui/NewTaskAction', () => ({
  NewTaskAction: () => <button type="button">New Schedule</button>,
}));

import { HomeSurfaceBar } from '../ui/HomeSurfaceBar';

const activitySearchSchema = z.object({ categories: z.string().optional() });

/** A stand-in page, so a test can wait for the route it asked for. */
function page(name: string) {
  return function MockPage() {
    return <div data-testid={`${name}-page`}>{name}</div>;
  };
}

/**
 * The bar over the four routes it serves, at one of their addresses.
 *
 * The bar is mounted by the shell rather than by a route, so here it is mounted
 * beside the outlet — which is also what makes the pathname the only thing
 * deciding which tab is lit.
 */
function renderAt(initialUrl: string) {
  const rootRoute = createRootRoute({
    staticData: { header: null },
    component: () => (
      <>
        <header className="flex h-9 items-center gap-2">
          <HomeSurfaceBar />
        </header>
        <Outlet />
      </>
    ),
  });
  const homeSurfaceRoute = createRoute({
    staticData: { header: null },
    getParentRoute: () => rootRoute,
    id: '_home',
    component: () => <Outlet />,
  });
  const indexRoute = createRoute({
    staticData: { header: null },
    getParentRoute: () => homeSurfaceRoute,
    path: '/',
    component: page('home'),
  });
  const activityRoute = createRoute({
    staticData: { header: null },
    getParentRoute: () => homeSurfaceRoute,
    path: '/activity',
    validateSearch: zodValidator(activitySearchSchema),
    component: page('activity'),
  });
  const tasksRoute = createRoute({
    staticData: { header: null },
    getParentRoute: () => homeSurfaceRoute,
    path: '/tasks',
    component: page('tasks'),
  });
  const workspacesRoute = createRoute({
    staticData: { header: null },
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
 * The label of every tab the bar is drawing as active.
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
  return document.querySelectorAll('[data-slot="bar-tab-strip-indicator"]').length;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('HomeSurfaceBar', () => {
  it('carries the four home surfaces as its identity, in order', async () => {
    renderAt('/');

    await screen.findByTestId('home-page');
    expect(screen.getAllByRole('link').map((link) => link.textContent)).toEqual([
      'Home',
      'Activity',
      'Schedules',
      'Workspaces',
    ]);
  });

  it('says "Home" once — the tab, not a title over it', async () => {
    // The bar used to read "Home" above a tab reading "Home", which is one
    // screen saying the same word twice. The tab is the identity now.
    renderAt('/');
    await screen.findByTestId('home-page');

    expect(screen.getAllByText('Home')).toHaveLength(1);
  });

  it('labels the /tasks tab "Schedules" and links it to /tasks', async () => {
    renderAt('/');

    await screen.findByTestId('home-page');
    expect(screen.getByRole('link', { name: 'Schedules' })).toHaveAttribute('href', '/tasks');
  });

  it.each([
    ['/', 'Home', 'home'],
    ['/activity', 'Activity', 'activity'],
    ['/tasks', 'Schedules', 'tasks'],
    ['/workspaces', 'Workspaces', 'workspaces'],
    // The router serves these spellings too — it tolerates a trailing slash and
    // matches case-insensitively — and reports the pathname back exactly as
    // typed. A hand-edited or copied link must still light its tab.
    ['/activity/', 'Activity', 'activity'],
    ['/tasks//', 'Schedules', 'tasks'],
    ['/Activity', 'Activity', 'activity'],
  ])('draws exactly one tab active at %s', async (url, label, testId) => {
    renderAt(url);

    await screen.findByTestId(`${testId}-page`);
    expect(activeTabLabels()).toEqual([label]);
    expect(indicatorCount()).toBe(1);
  });

  it('marks the active tab as the current page for a screen reader', async () => {
    // `Link` computes this itself, so it is TanStack's claim rather than the
    // resolver's — but spec §5.11 promises it, and the promise is about the DOM
    // the reader gets, whoever writes the attribute.
    renderAt('/activity');

    await screen.findByTestId('activity-page');
    expect(screen.getByRole('link', { name: 'Activity' })).toHaveAttribute('aria-current', 'page');
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

  it('navigates to /tasks when the Schedules tab is clicked', async () => {
    const user = userEvent.setup();
    const router = renderAt('/');
    await screen.findByTestId('home-page');

    await user.click(screen.getByRole('link', { name: 'Schedules' }));

    await waitFor(() => expect(router.state.location.pathname).toBe('/tasks'));
    expect(await screen.findByTestId('tasks-page')).toBeInTheDocument();
    expect(activeTabLabels()).toEqual(['Schedules']);
  });

  it('keeps the health dot last on every surface, behind the page action', async () => {
    // **What this can and cannot prove.** jsdom lays nothing out, so it cannot
    // measure where the dot is drawn — the x-positions are in the browser
    // evidence on DOR-1401 (identical on all four surfaces). What it CAN prove
    // is the property those pixels follow from: the dot is the last thing in the
    // bar, after the flexible space and after whatever page action the surface
    // adds. Put it in the chips zone instead — which is where it was — and it is
    // no longer last, and it slid 47px the moment Home's members chip appeared
    // beside it.
    for (const [url, testId] of [
      ['/', 'home'],
      ['/activity', 'activity'],
      ['/tasks', 'tasks'],
      ['/workspaces', 'workspaces'],
    ] as const) {
      renderAt(url);
      await screen.findByTestId(`${testId}-page`);

      const dot = screen.getByTestId('system-health-dot');
      const bar = dot.closest('header')!;
      const after = [...bar.querySelectorAll('*')].filter(
        (el) => dot.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING
      );
      expect(after, `something is drawn after the health dot on ${url}`).toEqual([]);

      cleanup();
    }
  });

  it('gives Home the members chip and Schedules the New Schedule action — and not the other way round', async () => {
    renderAt('/');
    await screen.findByTestId('home-page');
    expect(screen.getByTestId('home-members-chip')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'New Schedule' })).not.toBeInTheDocument();
    cleanup();

    renderAt('/tasks');
    await screen.findByTestId('tasks-page');
    expect(screen.getByRole('button', { name: 'New Schedule' })).toBeInTheDocument();
    expect(screen.queryByTestId('home-members-chip')).not.toBeInTheDocument();
    cleanup();

    // And a surface with neither draws neither, rather than inheriting the last
    // one's — the failure a per-route bar could not have, and a shared one can.
    renderAt('/workspaces');
    await screen.findByTestId('workspaces-page');
    expect(screen.queryByTestId('home-members-chip')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'New Schedule' })).not.toBeInTheDocument();
  });

  it('keeps ONE tab strip mounted across a tab press — the node survives', async () => {
    // **What this can and cannot prove.** It cannot fail under the original bug.
    // The bug lived in the SHELL — `AnimatePresence` keyed on the route id, so
    // four home routes were four keys and every tab press tore the bar down —
    // and this harness mounts the bar directly, with no `resolveRouteHeader` and
    // no `AnimatePresence` above it. So the node would have survived here even
    // then.
    //
    // What it does prove is the bar's own half of the fix, which is a real way
    // to break it again: that pressing a tab re-renders this component rather
    // than remounting its strip — a `key` on the strip, or resolving the tabs
    // per route into a fresh array identity, would fail here. The shell's half
    // is pinned in `route-header.test.ts` (routes sharing a bar share a key),
    // and the end-to-end claim — same DOM node across all four switches, the
    // underline sliding 351 → 585 — is browser-measured evidence on DOR-1401,
    // because a mounted-ness question about a real animation is not one jsdom
    // can answer.
    const user = userEvent.setup();
    renderAt('/');
    await screen.findByTestId('home-page');
    const before = screen.getByTestId('home-tabs');

    await user.click(screen.getByRole('link', { name: 'Schedules' }));
    await screen.findByTestId('tasks-page');

    expect(screen.getByTestId('home-tabs')).toBe(before);
  });
});

/**
 * The bar holds more than a phone shows, and has to say so (DOR-1180).
 *
 * At 390×844 the four labels want 430px, so a cold load drew
 * `Home | Activity | Schedules | Workspac` with nothing to suggest the word was
 * cut rather than misspelled — macOS draws no scrollbar until you have already
 * scrolled. jsdom lays nothing out, so every number below is stubbed: what these
 * pin is what the component DOES with a measurement. The pixels are
 * `home-shell.spec.ts`'s.
 */
describe('HomeSurfaceBar — a strip that says when it holds more', () => {
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
      // A touch target under a decoration that ate taps would cost more than the
      // decoration is worth, and a screen reader has no use for it.
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
      if (this.getAttribute('data-slot') === 'bar-tab-strip') return rect(0, 390);
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
      if (this.getAttribute('data-slot') === 'bar-tab-strip') return rect(0, 390);
      if (this.hasAttribute('data-active')) return rect(8, 81);
      return rect(0, 0);
    });

    renderAt('/');
    await screen.findByTestId('home-page');

    expect(strip().scrollLeft).toBe(0);
  });
});
